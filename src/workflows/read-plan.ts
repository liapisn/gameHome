/**
 * Read a floor plan drawing into rooms, in the background (started by the floor plans page,
 * media-actions.ts readFloorplan), so the page doesn't wait on the model call and a reload or
 * leaving the page doesn't lose it.
 *
 *   claim → read (one model call, at medium thinking to fit one function run) → store → finish
 *
 * The read step is retried by the workflow if it fails. The local worker (scripts/worker.mts)
 * reads plans the same way.
 */
import { FatalError } from "workflow";
import { adminClient, claimJob, finishReadJob, storeReadPlan, type ReadPlanProgress } from "@/lib/admin/jobs";
import { type PlanReadTarget, readLevelPlan } from "@/lib/admin/plan-read";

export async function readPlanWorkflow(jobId: string) {
  "use workflow";

  const target = await claim(jobId);
  if (!target) return { skipped: true };
  try {
    return await readAndStore(jobId, target);
  } catch (err) {
    await fail(jobId, (err as Error).message || String(err));
    throw err;
  }
}

async function claim(jobId: string): Promise<PlanReadTarget | null> {
  "use step";
  const supabase = adminClient();
  const job = await claimJob(supabase, jobId, `vercel-workflow:${jobId.slice(0, 8)}`);
  if (!job) return null;
  const { levelId, floorplanPath } = job.progress as unknown as ReadPlanProgress;
  const { data: level } = await supabase.from("levels").select("name, properties ( title )").eq("id", levelId).single();
  if (!level) {
    await finishReadJob(supabase, jobId, "failed", "This floor no longer exists.");
    return null;
  }
  return { propertyId: job.property_id, propertyTitle: level.properties?.title ?? "", levelId, levelName: level.name, floorplanPath };
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
