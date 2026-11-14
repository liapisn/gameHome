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
import { type JobRow, adminClient, exportProperty, finishJob, storeScenes, storeTour, writeJobProgress } from "../src/lib/admin/jobs";
import { activeProvider } from "../src/lib/ai/structured";
import { type BuildProgress, buildTour } from "../src/lib/engine/build-tour";
import { buildTourScenes } from "../src/lib/engine/build-scene";

const { values } = parseArgs({
  options: {
    once: { type: "boolean", default: false },
    // Also furnish photographed rooms from their photos (lib/scene); about 2–4 model calls per photo.
    furnish: { type: "boolean", default: process.env.WORKER_FURNISH === "1" },
  },
});

const POLL_MS = 5000;
const STALE_MINUTES = 45;
const WORKER_ID = `${os.hostname()}:${process.pid}`;

const supabase = adminClient();
type Job = JobRow;

const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

/** Jobs left `running` by a crashed worker on this machine, or running implausibly long, are failed. */
async function recoverStaleJobs() {
  const { data: running } = await supabase.from("jobs").select("id, worker_id, started_at").eq("status", "running");
  const cutoff = Date.now() - STALE_MINUTES * 60_000;
  for (const j of running ?? []) {
    const mine = j.worker_id?.startsWith(`${os.hostname()}:`) && j.worker_id !== WORKER_ID;
    const stale = j.started_at && Date.parse(j.started_at) < cutoff;
    if (!mine && !stale) continue;
    await finishJob(supabase, j.id, "failed", mine ? "The worker restarted while this job was running. Retry to build again." : `No result after ${STALE_MINUTES} minutes.`);
    log(`recovered job ${j.id.slice(0, 8)} (${mine ? "worker restarted" : "stale"})`);
  }
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
    await writeJobProgress(supabase, job.id, p);
  };

  try {
    await writeProgress({ step: "plans", label: "Downloading uploads", done: 0, total: 1 }, true);
    const property = await exportProperty(supabase, job.property_id, dir);
    log(`exported ${property.manifest.levels.length} floors, ${property.manifest.photos.length} photos`);
    const result = await buildTour(dir, {
      id: property.id,
      title: property.title,
      onProgress: (p) => void writeProgress(p),
      log: (m) => log(`  ${m.trim()}`),
    });
    if (pending) await writeProgress(pending, true);

    // Store: tours/org/<org>/property/<id>/v<n>/{tour.json, plan-<level>.json[, scenes.json]}
    const { version, folder } = await storeTour(supabase, { property, jobId: job.id, tour: result.tour, plans: result.plans });

    // Optional: furniture from the photos, stored beside tour.json (the Tour page loads it if present).
    if (values.furnish) {
      const { scenes, calls } = await buildTourScenes(result.tour, result.plans, {
        workRoot: path.join(dir, "scenes"),
        log: (m) => log(`  ${m.trim()}`),
        onProgress: (done, total) => void writeProgress({ step: "furnish", label: "Furnishing rooms from photos", done, total }, true),
      });
      if (scenes.length) await storeScenes(supabase, folder, scenes);
      log(`  furnished ${scenes.length} room(s), ${calls} model call(s)`);
    }

    await writeProgress({ step: "done", label: "Done", done: 1, total: 1 }, true);
    await finishJob(supabase, job.id, "succeeded");
    const posed = result.tour.photos.filter((p) => p.pose).length;
    log(`job ${job.id.slice(0, 8)} done: v${version}, ${posed}/${result.tour.photos.length} photos placed, ${result.usage.input} tokens in`);
  } catch (err) {
    const message = (err as Error).message || String(err);
    log(`job ${job.id.slice(0, 8)} failed: ${message}`);
    await finishJob(supabase, job.id, "failed", message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let current: Job | null = null;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (current) {
      log(`stopping: failing job ${current.id.slice(0, 8)}`);
      await finishJob(supabase, current.id, "failed", "The worker was stopped while this job was running. Retry to build again.");
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
