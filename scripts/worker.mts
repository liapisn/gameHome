/**
 * Tour build worker: claims queued `build_tour` jobs, runs the engine on the property's uploads,
 * and stores the result. Runs on a developer machine for now (`npm run worker`).
 *
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (vercel env pull) and the engine's model key
 * (GEMINI_API_KEY or ANTHROPIC_API_KEY) in .env.local. Never runs in the browser or on Vercel.
 *
 *   npm run worker            keep polling for jobs
 *   npm run worker -- --once  process at most one job, then exit
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "../src/lib/supabase/database.types";
import { MEDIA_BUCKET } from "../src/lib/admin/media-paths";
import { TOURS_BUCKET, tourFolder } from "../src/lib/admin/tour-paths";
import { activeProvider } from "../src/lib/ai/structured";
import { type BuildProgress, type Manifest, buildTour } from "../src/lib/engine/build-tour";

const { values } = parseArgs({ options: { once: { type: "boolean", default: false } } });

const POLL_MS = 5000;
const STALE_MINUTES = 45;
const WORKER_ID = `${os.hostname()}:${process.pid}`;

const supabase = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
type Job = Database["public"]["Tables"]["jobs"]["Row"];

const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

/** Jobs left `running` by a crashed worker on this machine, or running implausibly long, are failed. */
async function recoverStaleJobs() {
  const { data: running } = await supabase.from("jobs").select("id, worker_id, started_at").eq("status", "running");
  const cutoff = Date.now() - STALE_MINUTES * 60_000;
  for (const j of running ?? []) {
    const mine = j.worker_id?.startsWith(`${os.hostname()}:`) && j.worker_id !== WORKER_ID;
    const stale = j.started_at && Date.parse(j.started_at) < cutoff;
    if (!mine && !stale) continue;
    await finishJob(j.id, "failed", mine ? "The worker restarted while this job was running. Retry to build again." : `No result after ${STALE_MINUTES} minutes.`);
    log(`recovered job ${j.id.slice(0, 8)} (${mine ? "worker restarted" : "stale"})`);
  }
}

async function finishJob(jobId: string, status: "succeeded" | "failed", error?: string) {
  const { data: job } = await supabase
    .from("jobs")
    .update({ status, error: error ?? null, finished_at: new Date().toISOString() })
    .eq("id", jobId)
    .select("property_id")
    .single();
  if (!job) return;
  // The property is ready if it has any tour (this one or an earlier one), otherwise back to draft.
  const { count } = await supabase.from("tours").select("id", { count: "exact", head: true }).eq("property_id", job.property_id);
  const { data: property } = await supabase.from("properties").select("status").eq("id", job.property_id).single();
  if (property?.status !== "published") {
    await supabase.from("properties").update({ status: count ? "ready" : "draft" }).eq("id", job.property_id);
  }
}

async function download(path_: string, dest: string) {
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).download(path_);
  if (error || !data) throw new Error(`Could not download ${path_}: ${error?.message ?? "no data"}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await data.arrayBuffer()));
}

/** Export the property's uploads into the engine's folder layout. */
async function exportProperty(propertyId: string, dir: string) {
  const { data: p, error } = await supabase
    .from("properties")
    .select("id, org_id, title, levels ( id, name, sort, floorplan_path ), media ( id, kind, storage_path, level_id, hint, sort )")
    .eq("id", propertyId)
    .single();
  if (error || !p) throw new Error(`Property not found: ${error?.message ?? propertyId}`);

  const levels = [...p.levels].sort((a, b) => a.sort - b.sort);
  const photos = p.media.filter((m) => m.kind === "photo").sort((a, b) => a.sort - b.sort);
  const manifest: Manifest = {
    levels: levels.map((l) => ({
      id: l.id,
      name: l.name,
      floorplan: l.floorplan_path ? `floorplans/${l.id}.webp` : null,
      ...(l.floorplan_path ? {} : { note: "a floor of this property without a floor plan" }),
    })),
    // Photo files are named after their media row, so the tour's `src` maps straight back to Storage.
    photos: photos.map((m) => ({ file: `photos/${m.id}.webp`, hint: m.hint ?? undefined, level: m.level_id ?? undefined })),
  };
  for (const l of levels) if (l.floorplan_path) await download(l.floorplan_path, path.join(dir, `floorplans/${l.id}.webp`));
  let n = 0;
  const queue = [...photos];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let m = queue.shift(); m; m = queue.shift()) {
        await download(m.storage_path, path.join(dir, `photos/${m.id}.webp`));
        n++;
      }
    }),
  );
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`exported ${levels.length} floors, ${n} photos`);
  return p;
}

async function processJob(job: Job) {
  log(`job ${job.id.slice(0, 8)} for property ${job.property_id.slice(0, 8)} (attempt ${job.attempts})`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gamehome-"));
  let lastWrite = 0;
  let pending: BuildProgress | null = null;
  const writeProgress = async (p: BuildProgress, force = false) => {
    pending = p;
    if (!force && Date.now() - lastWrite < 1000) return;
    lastWrite = Date.now();
    pending = null;
    await supabase.from("jobs").update({ progress: p as unknown as NonNullable<Json> }).eq("id", job.id);
  };

  try {
    await writeProgress({ step: "plans", label: "Downloading uploads", done: 0, total: 1 }, true);
    const property = await exportProperty(job.property_id, dir);
    const result = await buildTour(dir, {
      id: property.id,
      title: property.title,
      onProgress: (p) => void writeProgress(p),
      log: (m) => log(`  ${m.trim()}`),
    });
    if (pending) await writeProgress(pending, true);

    // Store: tours/org/<org>/property/<id>/v<n>/{tour.json, plan-<level>.json}
    const { data: last } = await supabase
      .from("tours")
      .select("version")
      .eq("property_id", property.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const version = (last?.version ?? 0) + 1;
    const folder = tourFolder(property.org_id, property.id, version);
    const upload = async (name: string, body: unknown) => {
      const { error } = await supabase.storage
        .from(TOURS_BUCKET)
        .upload(`${folder}${name}`, JSON.stringify(body), { contentType: "application/json", upsert: true });
      if (error) throw new Error(`Upload ${name}: ${error.message}`);
      return `${folder}${name}`;
    };
    const tour = { ...result.tour, mediaRoot: "" };
    const tourPath = await upload("tour.json", tour);
    const planPaths = [];
    for (const plan of result.plans) planPaths.push({ planId: plan.id, path: await upload(`plan-${plan.id}.json`, plan) });

    await supabase.from("tours").update({ is_current: false }).eq("property_id", property.id).eq("is_current", true);
    const { error: tourError } = await supabase.from("tours").insert({
      property_id: property.id,
      job_id: job.id,
      version,
      tour_path: tourPath,
      plan_paths: planPaths as unknown as NonNullable<Json>,
      is_current: true,
    });
    if (tourError) throw new Error(`Saving tour: ${tourError.message}`);

    await writeProgress({ step: "done", label: "Done", done: 1, total: 1 }, true);
    await finishJob(job.id, "succeeded");
    const posed = tour.photos.filter((p) => p.pose).length;
    log(`job ${job.id.slice(0, 8)} done: v${version}, ${posed}/${tour.photos.length} photos placed, ${result.usage.input} tokens in`);
  } catch (err) {
    const message = (err as Error).message || String(err);
    log(`job ${job.id.slice(0, 8)} failed: ${message}`);
    await finishJob(job.id, "failed", message.slice(0, 1000));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let current: Job | null = null;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (current) {
      log(`stopping: failing job ${current.id.slice(0, 8)}`);
      await finishJob(current.id, "failed", "The worker was stopped while this job was running. Retry to build again.");
    }
    process.exit(130);
  });
}

log(`worker ${WORKER_ID} · engine model provider: ${activeProvider()}`);
await recoverStaleJobs();
for (;;) {
  const { data, error } = await supabase.rpc("claim_next_job", { p_worker: WORKER_ID });
  if (error) {
    log(`claim failed: ${error.message}`);
  } else if (data?.length) {
    current = data[0];
    await processJob(current);
    current = null;
    if (values.once) break;
    continue;
  } else if (values.once) {
    log("no queued jobs");
    break;
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
