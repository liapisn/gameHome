/**
 * Queue a floor plan read (src/workflows/read-plan.ts) and start it on Vercel. Used by the floor
 * plans page and the Prosperty import. With TOUR_BUILDER=worker the job is only queued, for a
 * local `npm run worker`. Server-side only.
 */
import { start } from "workflow/api";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { READ_PLAN, type ReadPlanProgress } from "@/lib/admin/jobs";
import { readPlanWorkflow } from "@/workflows/read-plan";

/**
 * Queue a read of this drawing, unless one is already under way (a read of an older drawing doesn't count).
 * `estimatePhotos`: once the property's last such read is done, estimate its photos' rooms.
 */
export async function startPlanRead(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  levelId: string,
  floorplanPath: string,
  opts: { estimatePhotos?: boolean } = {},
) {
  const { data: running } = await supabase
    .from("jobs")
    .select("id, progress")
    .eq("property_id", propertyId)
    .eq("type", READ_PLAN)
    .in("status", ["queued", "running"]);
  if (
    running?.some((j) => {
      const p = j.progress as unknown as ReadPlanProgress;
      return p.levelId === levelId && p.floorplanPath === floorplanPath;
    })
  )
    return;

  const progress: ReadPlanProgress = { levelId, floorplanPath, label: "Reading rooms", ...(opts.estimatePhotos && { estimatePhotos: true }) };
  const { data: job, error } = await supabase
    .from("jobs")
    .insert({ property_id: propertyId, type: READ_PLAN, progress: progress as unknown as NonNullable<Json> })
    .select("id")
    .single();
  if (error || !job) throw new Error(error?.message ?? "Could not start reading the plan.");
  if (process.env.TOUR_BUILDER !== "worker") await start(readPlanWorkflow, [job.id]);
}
