/**
 * Read a floor plan drawing into rooms, in the background (started by the floor plans page,
 * media-actions.ts readFloorplan, and by the Prosperty import), so the page doesn't wait on the
 * model call and a reload or leaving the page doesn't lose it.
 *
 *   claim → read (one model call, at medium thinking to fit one function run) → store → finish
 *         → [import only, last floor read] estimate the photos' rooms, a batch per step
 *
 * The read step is retried by the workflow if it fails. The local worker (scripts/worker.mts)
 * reads plans the same way.
 */
import { FatalError } from "workflow";
import {
  ESTIMATE_BATCH,
  adminClient,
  claimJob,
  finishReadJob,
  startEstimateJob,
  startEstimatesAfterRead,
  storeReadPlan,
  writeEstimateProgress,
  type ReadPlanProgress,
} from "@/lib/admin/jobs";
import { type PlanReadTarget, readLevelPlan } from "@/lib/admin/plan-read";
import { estimatePhotoRooms } from "@/lib/admin/room-estimates";

export async function readPlanWorkflow(jobId: string) {
  "use workflow";

  const target = await claim(jobId);
  if (!target) return { skipped: true };
  let result: { rooms: number } | undefined;
  let error: unknown;
  try {
    result = await readAndStore(jobId, target);
  } catch (err) {
    error = err;
    await fail(jobId, (err as Error).message || String(err));
  }
  // Even if this floor failed, the import's other floors may have rooms to estimate from.
  if (target.estimatePhotos) await estimateAfterRead(jobId);
  if (error) throw error;
  return result;
}

/**
 * Estimate the photos' rooms of a property whose plans are already stored without a read (a
 * Matterport import): the same estimate steps as after the import's last read.
 */
export async function estimatePhotosWorkflow(propertyId: string) {
  "use workflow";

  await runEstimates(() => startEstimatesFor(propertyId));
}

async function estimateAfterRead(jobId: string) {
  await runEstimates(() => startEstimates(jobId));
}

async function runEstimates(begin: () => Promise<{ jobId: string; mediaIds: string[] } | null>) {
  let estimate: { jobId: string; mediaIds: string[] } | null = null;
  try {
    estimate = await begin();
    if (!estimate) return;
    const { mediaIds } = estimate;
    let failed = 0;
    for (let i = 0; i < mediaIds.length; i += ESTIMATE_BATCH) {
      const batch = mediaIds.slice(i, i + ESTIMATE_BATCH);
      // A batch that still fails after its retries is skipped; the rest carry on.
      try {
        await estimateBatch(estimate.jobId, batch, i, mediaIds.length);
      } catch {
        failed += batch.length;
      }
    }
    await finishEstimates(estimate.jobId, failed ? `${failed} photo(s) could not be estimated.` : undefined);
  } catch (err) {
    // Estimates are a convenience: the owner can still run them from the photos page.
    if (estimate) await finishEstimates(estimate.jobId, (err as Error).message || String(err));
  }
}

async function claim(jobId: string): Promise<(PlanReadTarget & { estimatePhotos: boolean }) | null> {
  "use step";
  const supabase = adminClient();
  const job = await claimJob(supabase, jobId, `vercel-workflow:${jobId.slice(0, 8)}`);
  if (!job) return null;
  const { levelId, floorplanPath, estimatePhotos } = job.progress as unknown as ReadPlanProgress;
  const { data: level } = await supabase.from("levels").select("name, properties ( title )").eq("id", levelId).single();
  if (!level) {
    await finishReadJob(supabase, jobId, "failed", "This floor no longer exists.");
    return null;
  }
  return {
    propertyId: job.property_id,
    propertyTitle: level.properties?.title ?? "",
    levelId,
    levelName: level.name,
    floorplanPath,
    estimatePhotos: !!estimatePhotos,
  };
}

async function readAndStore(jobId: string, target: PlanReadTarget): Promise<{ rooms: number }> {
  "use step";
  const supabase = adminClient();
  let plan;
  try {
    plan = await readLevelPlan(supabase, target);
  } catch (e) {
    const message = (e as Error).message;
    // A drawing with no rooms in it won't read better the next time.
    if (/No rooms could be read/.test(message)) throw new FatalError(message);
    throw e;
  }
  const stored = await storeReadPlan(supabase, target.levelId, target.floorplanPath, plan);
  await finishReadJob(supabase, jobId, stored ? "succeeded" : "failed", stored ? undefined : "The floor plan was replaced while it was being read.");
  return { rooms: plan.rooms.length };
}

async function fail(jobId: string, error: string) {
  "use step";
  await finishReadJob(adminClient(), jobId, "failed", error);
}

async function startEstimates(readJobId: string) {
  "use step";
  const supabase = adminClient();
  const { data: job } = await supabase.from("jobs").select("id, property_id, progress").eq("id", readJobId).single();
  return job ? startEstimatesAfterRead(supabase, job) : null;
}

async function startEstimatesFor(propertyId: string) {
  "use step";
  return startEstimateJob(adminClient(), propertyId);
}

async function estimateBatch(estimateJobId: string, mediaIds: string[], doneBefore: number, total: number) {
  "use step";
  const supabase = adminClient();
  const { data: job } = await supabase.from("jobs").select("property_id").eq("id", estimateJobId).single();
  if (!job) throw new FatalError("The estimate job is gone.");
  try {
    await estimatePhotoRooms(supabase, job.property_id, mediaIds);
  } finally {
    await writeEstimateProgress(supabase, estimateJobId, doneBefore + mediaIds.length, total);
  }
}

async function finishEstimates(estimateJobId: string, error?: string) {
  "use step";
  await finishReadJob(adminClient(), estimateJobId, error ? "failed" : "succeeded", error);
}
