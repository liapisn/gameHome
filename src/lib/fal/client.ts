/**
 * fal queue client: submit, poll, fetch the result, with a resume file so an interrupted run never
 * pays twice, and an append-only spend log.
 *
 * Adapted from https://github.com/apekshik/anyscene (generate/fal.mjs), MIT licence.
 * Dropped: the Windows registry key lookup and the spend cap. Added: images as data URIs, retries.
 */
import fs from "node:fs";
import path from "node:path";

/** Rough per-call estimates for the spend log (fal pricing as AnyScene recorded it, late Oct 2026). */
export const EST_USD: Record<string, number> = {
  "openai/gpt-image-2.5/sunburst/edit": 0.25,
  "openai/gpt-image-2.5/sunburst/text-to-image": 0.25,
  "tripo3d/h3.1/image-to-3d": 0.6,
  "meshy/v7.1/image-to-3d": 0.8,
};

const SPEND_LOG = path.resolve("exports", "fal-spend.jsonl");

/**
 * fal keys: FAL_KEY, then FAL_KEY_BACKUP once the main one is out of credit. New jobs go to the
 * current key; a submitted job is always polled with the key that submitted it (fal only lets the
 * submitting key read a job).
 */
type KeyName = "main" | "backup";
let current: KeyName = "main";

function keyOf(name: KeyName) {
  const k = name === "main" ? (process.env.FAL_KEY ?? process.env.FAL_API_KEY) : process.env.FAL_KEY_BACKUP;
  if (!k) throw new Error(name === "main" ? "FAL_KEY is not set (.env.local)" : "FAL_KEY_BACKUP is not set (.env.local)");
  return k;
}

/** fal's answer when a key has no credit left. */
const OUT_OF_CREDIT = /\b(402|403)\b.*(balance|credit|billing|locked|exhausted|insufficient)/i;

async function call<T>(url: string, init: RequestInit = {}, name: KeyName = current): Promise<T> {
  const res = await fetch(url, { ...init, headers: { authorization: `Key ${keyOf(name)}`, "content-type": "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url}: ${text.slice(0, 600)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** Submit with the current key; if it is out of credit and a backup exists, switch to the backup for good. */
async function submit(endpoint: string, input: Record<string, unknown>, log: (m: string) => void): Promise<Job> {
  try {
    return { ...(await call<Job>(`https://queue.fal.run/${endpoint}`, { method: "POST", body: JSON.stringify(input) })), key: current };
  } catch (err) {
    if (current === "main" && process.env.FAL_KEY_BACKUP && OUT_OF_CREDIT.test((err as Error).message)) {
      current = "backup";
      log(`fal: main key is out of credit, switching to FAL_KEY_BACKUP`);
      return { ...(await call<Job>(`https://queue.fal.run/${endpoint}`, { method: "POST", body: JSON.stringify(input) })), key: current };
    }
    throw err;
  }
}

function logSpend(row: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(SPEND_LOG), { recursive: true });
  fs.appendFileSync(SPEND_LOG, JSON.stringify({ time: new Date().toISOString(), ...row }) + "\n");
}

interface Job {
  request_id: string;
  status_url: string;
  response_url: string;
  /** Which key submitted it (older pending files: main). */
  key?: KeyName;
}

/**
 * Queue-submit `input` to `endpoint`, poll every 4 s, return the result. With `pending` (a file),
 * the submitted job is recorded until its result is in; a rerun picks it back up instead of paying again.
 */
export async function falRun<T = Record<string, unknown>>(
  endpoint: string,
  input: Record<string, unknown>,
  opts: { pending?: string; meta?: Record<string, unknown>; timeoutMin?: number; log?: (m: string) => void } = {},
): Promise<{ result: T; requestId: string; seconds: number }> {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  let job: Job | null = null;
  if (opts.pending && fs.existsSync(opts.pending)) {
    try {
      job = JSON.parse(fs.readFileSync(opts.pending, "utf8")) as Job;
      await call(job.status_url, {}, job.key ?? "main"); // still known to the queue?
      log(`resuming ${endpoint} ${job.request_id}`);
    } catch {
      job = null; // expired or unknown: submit again
    }
  }
  if (!job) {
    job = await submit(endpoint, input, log);
    logSpend({ endpoint, est_usd: EST_USD[endpoint] ?? 0, request_id: job.request_id, key: job.key, ...opts.meta });
    if (opts.pending) {
      fs.mkdirSync(path.dirname(opts.pending), { recursive: true });
      fs.writeFileSync(opts.pending, JSON.stringify(job));
    }
    log(`queued ${endpoint} ${job.request_id}`);
  }
  const timeout = (opts.timeoutMin ?? 30) * 60_000;
  for (let blips = 0; ; ) {
    await new Promise((r) => setTimeout(r, 4000));
    if (Date.now() - t0 > timeout) throw new Error(`timed out; request ${job.request_id}`);
    let st: { status: string };
    try {
      st = await call<{ status: string }>(job.status_url, {}, job.key ?? "main");
      blips = 0;
    } catch (err) {
      // A dropped connection says nothing about the job: keep polling it (up to ~2 min of outage).
      if (/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket/i.test((err as Error).message) && ++blips < 30) continue;
      throw err;
    }
    if (st.status === "COMPLETED") break;
  }
  const result = await call<T>(job.response_url, {}, job.key ?? "main");
  if (opts.pending) fs.rmSync(opts.pending, { force: true });
  return { result, requestId: job.request_id, seconds: (Date.now() - t0) / 1000 };
}

/** falRun with retries: 10–20% of generation jobs fail transiently (504, resets, timeouts). */
export async function falRunRetry<T = Record<string, unknown>>(
  endpoint: string,
  input: Record<string, unknown>,
  opts: Parameters<typeof falRun>[2] & { retries?: number } = {},
) {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await falRun<T>(endpoint, input, opts);
    } catch (err) {
      if (attempt >= retries) throw err;
      opts.log?.(`retry ${attempt + 1}/${retries} ${endpoint}: ${(err as Error).message.slice(0, 160)}`);
      // A network error while polling leaves the job running: keep the pending file so the retry
      // resumes it instead of paying for a new one. Only a job the queue itself failed is dropped.
      const networkBlip = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket/i.test((err as Error).message);
      if (opts.pending && !networkBlip) fs.rmSync(opts.pending, { force: true });
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
}

export async function download(url: string, out: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status} ${url}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Beside the target, renamed when complete, so a half-written file is never picked up.
  fs.writeFileSync(`${out}.part`, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(`${out}.part`, out);
  return out;
}

/** Download a GLB and check it really is one (generators sometimes return an error page). */
export async function downloadGlb(url: string, out: string) {
  await download(url, out);
  const head = Buffer.alloc(4);
  const fd = fs.openSync(out, "r");
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  if (head.toString("latin1") !== "glTF") {
    fs.rmSync(out, { force: true });
    throw new Error(`${path.basename(out)}: not a GLB`);
  }
  return out;
}

/** First GLB URL anywhere in a result (Tripo returns model_mesh / pbr_model, Meshy model_glb). */
export const glbUrlIn = (result: unknown) => JSON.stringify(result).match(/https:\/\/[^"]+?\.glb[^"]*/)?.[0] ?? null;

export const jpegDataUri = (buf: Buffer) => `data:image/jpeg;base64,${buf.toString("base64")}`;
export const pngDataUri = (buf: Buffer) => `data:image/png;base64,${buf.toString("base64")}`;

export function spendTotal(): number {
  if (!fs.existsSync(SPEND_LOG)) return 0;
  return fs
    .readFileSync(SPEND_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .reduce((s, l) => s + (JSON.parse(l).est_usd ?? 0), 0);
}
