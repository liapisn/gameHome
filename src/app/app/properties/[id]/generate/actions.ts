"use server";

import { revalidatePath } from "next/cache";
import { start } from "workflow/api";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { MIN_PHOTOS } from "@/lib/admin/generate";
import { buildTourWorkflow } from "@/workflows/build-tour";

/**
 * Queue a tour build and start it on Vercel (src/workflows/build-tour.ts). RLS allows members to
 * insert `queued` jobs for their own properties only. With TOUR_BUILDER=worker the job is only
 * queued, for a local `npm run worker`.
 */
export async function queueTourBuild(propertyId: string): Promise<{ error?: string }> {
  z.uuid().parse(propertyId);
  const supabase = await createClient();

  const { data: property } = await supabase
    .from("properties")
    .select("id, levels ( floorplan_path ), media ( kind )")
    .eq("id", propertyId)
    .maybeSingle();
  if (!property) return { error: "Property not found." };
  if (!property.levels.some((l) => l.floorplan_path)) return { error: "Upload a floor plan for at least one floor first." };
  if (property.media.filter((m) => m.kind === "photo").length < MIN_PHOTOS) {
    return { error: `Add at least ${MIN_PHOTOS} photos first.` };
  }

  const { count } = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .eq("property_id", propertyId)
    .in("status", ["queued", "running"]);
  if (count) return { error: "A build is already queued or running." };

  const { data: job, error } = await supabase.from("jobs").insert({ property_id: propertyId, type: "build_tour" }).select("id").single();
  if (error || !job) return { error: error?.message ?? "Could not queue the build." };
  await supabase.from("properties").update({ status: "processing" }).eq("id", propertyId).neq("status", "published");

  if (process.env.TOUR_BUILDER !== "worker") {
    try {
      await start(buildTourWorkflow, [job.id]);
    } catch (err) {
      // The job stays queued: a local worker can still pick it up.
      console.error(`Could not start the tour build workflow for job ${job.id}:`, err);
    }
  }

  revalidatePath(`/app/properties/${propertyId}`, "layout");
  return {};
}
