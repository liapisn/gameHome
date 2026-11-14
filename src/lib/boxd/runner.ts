/**
 * Blender on boxd machines (docs/boxd-models-plan.md, part 1). Every Blender run of the model
 * pipeline comes here unless BLENDER_RUNNER=local.
 *
 * Machines start from the `gh-blender-5-3` snapshot (scripts/boxd-snapshot.mts) and are kept in a
 * pool of at most BOXD_MACHINES (default 30): a job leases one, runs, and hands it back. Each
 * machine carries a one-hour wall-clock delete timer, so a crashed run cleans itself up; the pool
 * stops reusing a machine after 45 minutes. `closePool()` deletes every machine this process
 * started (the scripts call it on exit and on Ctrl-C).
 *
 * Files: the laptop's absolute paths are mirrored on the machine. Every string in the job that is
 * an existing local file is uploaded to the same path, so the job JSON and the result JSON the
 * script writes need no rewriting. Outputs are the files under the project folder that are newer
 * than a stamp written just before Blender starts; each is downloaded to the same local path.
 */
import fs from "node:fs";
import path from "node:path";
import { Boxd } from "@boxd-sh/sdk";

export const SNAPSHOT = process.env.BOXD_SNAPSHOT ?? "gh-blender-5-3";
/** Label every pool machine carries; `boxd-snapshot.mts --clean` deletes machines with it. */
export const POOL_LABEL = { app: "gamehome-blender" } as const;

const MAX_MACHINES = Number(process.env.BOXD_MACHINES ?? 30);
const DELETE_AFTER_S = 3600;
const MAX_REUSE_AGE_MS = 45 * 60_000;
const EXEC_TIMEOUT_MS = Number(process.env.BOXD_EXEC_TIMEOUT_MS ?? 10 * 60_000);
const ROOT = path.resolve(process.cwd());
const BLENDER_DIR = path.join(ROOT, "blender");

let client: Boxd | null = null;
export function boxd(): Boxd {
  if (!client) {
    if (!process.env.BOXD_API_KEY && !process.env.BOXD_TOKEN) throw new Error("BOXD_API_KEY is not set (.env.local)");
    // The SDK's default 60 s covers the RPC; a Blender exec can take minutes.
    client = new Boxd({ timeout: EXEC_TIMEOUT_MS + 5 * 60_000 });
  }
  return client;
}

// --------------------------------------------------------------------------- pool

interface Lease {
  id: string;
  name: string;
  born: number;
  /** Local path → "size:mtime" of what is already on the machine, so a reused machine skips it. */
  uploaded: Map<string, string>;
}

const idle: Lease[] = [];
const live = new Set<Lease>();
const waiters: (() => void)[] = [];
let starting = 0;
let closing = false;
let hooked = false;

function hookExit() {
  if (hooked) return;
  hooked = true;
  const bail = (sig: string) => {
    console.error(`\n${sig}: deleting ${live.size} boxd machine(s)…`);
    closePool().finally(() => process.exit(130));
  };
  process.once("SIGINT", () => bail("SIGINT"));
  process.once("SIGTERM", () => bail("SIGTERM"));
  // A script that dies on an error still deletes its machines (Node waits for this handler).
  const crash = (e: unknown) => {
    console.error(e);
    closePool().finally(() => process.exit(1));
  };
  process.once("uncaughtException", crash);
  process.once("unhandledRejection", crash);
}

async function startMachine(): Promise<Lease> {
  const b = boxd();
  const name = `gh-blender-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const m = await b.machines.create({ name, fromSnapshot: SNAPSHOT, deleteAfter: DELETE_AFTER_S, labels: { ...POOL_LABEL } });
  const lease: Lease = { id: m.id, name, born: Date.now(), uploaded: new Map() };
  live.add(lease);
  try {
    await b.machines.waitUntilReady(m.id);
  } catch (e) {
    await dropMachine(lease);
    throw e;
  }
  return lease;
}

async function dropMachine(lease: Lease) {
  live.delete(lease);
  try {
    await boxd().machines.delete(lease.id);
  } catch {
    /* already gone, or the delete timer will take it */
  }
}

async function acquire(): Promise<Lease> {
  hookExit();
  for (;;) {
    if (closing) throw new Error("boxd pool is closing");
    while (idle.length) {
      const l = idle.pop()!;
      if (Date.now() - l.born < MAX_REUSE_AGE_MS) return l;
      void dropMachine(l);
    }
    if (live.size + starting < MAX_MACHINES) {
      starting++;
      try {
        return await startMachine();
      } finally {
        starting--;
      }
    }
    await new Promise<void>((r) => waiters.push(r));
  }
}

function release(lease: Lease, discard: boolean) {
  if (discard || closing) void dropMachine(lease);
  else idle.push(lease);
  waiters.shift()?.();
}

/**
 * Lease a machine for `fn`. `discard: true` deletes it afterwards instead of returning it to the
 * pool: for machines that ran model-written code, which must never run a trusted job later.
 */
export async function withMachine<R>(fn: (lease: Lease) => Promise<R>, opts: { discard?: boolean } = {}): Promise<R> {
  const lease = await acquire();
  let ok = false;
  try {
    const r = await fn(lease);
    ok = true;
    return r;
  } finally {
    // A machine whose job threw may be in a bad state: delete it, and finish deleting before the
    // error travels on (it may end the process).
    if (ok && !opts.discard) release(lease, false);
    else {
      await dropMachine(lease);
      waiters.shift()?.();
    }
  }
}

/** Delete every machine this process started. Safe to call more than once. */
export async function closePool() {
  closing = true;
  idle.length = 0;
  await Promise.all([...live].map(dropMachine));
  waiters.splice(0).forEach((w) => w());
  if (client) {
    await client.close().catch(() => {});
    client = null;
  }
  closing = false;
}

// --------------------------------------------------------------------------- one run

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Absolute-path strings anywhere in `job`. */
function pathsIn(job: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof job === "string") {
    if (path.isAbsolute(job) && !job.includes("\n")) out.add(job);
  } else if (Array.isArray(job)) job.forEach((v) => pathsIn(v, out));
  else if (job && typeof job === "object") Object.values(job).forEach((v) => pathsIn(v, out));
  return out;
}

async function inParallel<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

async function exec(lease: Lease, command: string, timeout = 60_000) {
  return boxd().machines.exec(lease.id, { command, timeout });
}

/**
 * Run `blender -b -P <script> -- <jobFile>` on `lease`. Resolves with Blender's output when the
 * script printed `marker` (Blender exits 0 even when the script raised).
 */
export async function runOnMachine(
  lease: Lease,
  script: string,
  jobFile: string,
  marker: string,
  log?: (line: string) => void,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS;
  const b = boxd();
  const job: unknown = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  const refs = [...pathsIn(job)];

  // Inputs: the job file, every script in blender/ (they import each other), and every existing file the job names.
  const inputs = new Set<string>([path.resolve(jobFile), path.resolve(script)]);
  for (const f of fs.readdirSync(BLENDER_DIR)) if (f.endsWith(".py")) inputs.add(path.join(BLENDER_DIR, f));
  for (const p of refs) if (fs.existsSync(p) && fs.statSync(p).isFile()) inputs.add(p);

  // Every directory a script might write into must exist (bpy's exporters don't create parents).
  const dirs = new Set<string>([...inputs].map((p) => path.dirname(p)));
  for (const p of refs) if (!inputs.has(p)) dirs.add(path.dirname(p));
  await exec(lease, `mkdir -p ${[...dirs].map(sh).join(" ")}`);

  const todo = [...inputs].filter((p) => {
    const st = fs.statSync(p);
    return lease.uploaded.get(p) !== `${st.size}:${st.mtimeMs}`;
  });
  await inParallel(todo, 6, async (p) => {
    const st = fs.statSync(p);
    await b.machines.files.upload(lease.id, p, { fromPath: p });
    lease.uploaded.set(p, `${st.size}:${st.mtimeMs}`);
  });

  const stamp = `/tmp/gh-stamp-${Date.now()}`;
  await exec(lease, `touch ${stamp}`);
  // stdin closed and output to a file: with the exec's stdin left open, Blender finishes the
  // script but never exits. `timeout` stops a stuck Blender on the machine itself.
  const logFile = `${stamp}.log`;
  // The machine stops Blender first (SIGTERM, then SIGKILL 10 s later), so its log still comes back
  // before the SDK's own deadline (60 s later) gives up on the call.
  const secs = Math.max(30, Math.floor(timeoutMs / 1000));
  const r = await exec(
    lease,
    `timeout -k 10 ${secs} blender -b --factory-startup -P ${sh(path.resolve(script))} -- ${sh(path.resolve(jobFile))} < /dev/null > ${logFile} 2>&1; code=$?; cat ${logFile}; exit $code`,
    timeoutMs + 60_000,
  );
  const out = r.stdout + r.stderr;
  if (log) for (const line of out.split("\n")) if (/Error|Traceback|_OK|Saved:/.test(line)) log(line.trim());

  // Outputs: files under the project folder written during the run. Paths come from the machine,
  // so each one is checked to be a plain path inside the project before it is written locally.
  const found = await exec(lease, `find ${sh(ROOT)} -type f -newer ${stamp} -not -path '*/__pycache__/*' -print`);
  const files = found.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  await inParallel(files, 6, async (remote) => {
    const local = path.resolve(remote);
    if (local !== remote || !local.startsWith(ROOT + path.sep)) throw new Error(`boxd: refusing output path ${remote}`);
    const bytes = await b.machines.files.download(lease.id, remote);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, bytes);
    const st = fs.statSync(local);
    lease.uploaded.set(local, `${st.size}:${st.mtimeMs}`); // now identical on both sides
  });

  if (r.exitCode === 0 && out.includes(marker)) return out;
  throw new Error(`Blender on boxd failed (exit ${r.exitCode}, ${lease.name}):\n${out.split("\n").slice(-30).join("\n")}`);
}

let remoteVersion: Promise<string> | null = null;
/** Blender's version on the snapshot (one short-lived lease, cached for the process). */
export function boxdBlenderVersion(): Promise<string> {
  remoteVersion ??= withMachine(async (l) => {
    const r = await exec(l, "blender --version");
    const m = r.stdout.match(/Blender (\d+\.\d+\.\d+)/);
    if (!m) throw new Error(`Couldn't read Blender's version on boxd: ${r.stdout.slice(0, 200)}`);
    return m[1];
  });
  return remoteVersion;
}
