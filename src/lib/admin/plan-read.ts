/**
 * Read a floor's plan drawing into rooms (one model call) and store it on the level, so the
 * owner can check and correct the rooms, tag photos with them, and every tour build reuses the
 * same geometry and room ids.
 */
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FloorPlan } from "@/lib/floorplan";
import { buildFloorPlan } from "@/lib/floorplan-parser/build";
import { type ParseOptions, parseFloorPlanImage } from "@/lib/floorplan-parser/parse";
import type { ParsedPlan } from "@/lib/floorplan-parser/schema";
import type { Database, Json } from "@/lib/supabase/database.types";
import { MEDIA_BUCKET } from "./media-paths";

/** Same id the tour build gives a level's plan (engine/build-tour.ts), so stored and built plans line up. */
export const planIdFor = (propertyId: string, levelId: string) => `${propertyId}-${levelId}`;

export interface PlanReadTarget {
  propertyId: string;
  propertyTitle: string;
  levelId: string;
  levelName: string;
  floorplanPath: string;
}

/** The parser's input for a floor: its stored drawing as JPEG, with the floor named as context. */
export async function planReadInput(supabase: SupabaseClient<Database>, opts: PlanReadTarget): Promise<ParseOptions> {
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).download(opts.floorplanPath);
  if (error || !data) throw new Error(`Could not load the floor plan image: ${error?.message ?? "no data"}`);
  const jpeg = await sharp(Buffer.from(await data.arrayBuffer())).rotate().jpeg({ quality: 92 }).toBuffer();
  return { imageBase64: jpeg.toString("base64"), mediaType: "image/jpeg", hint: `${opts.levelName} of "${opts.propertyTitle}".` };
}

/** The parser's result → the floor's plan. Throws when no rooms came out. */
export function planFromParsed(parsed: ParsedPlan, model: string, opts: PlanReadTarget): FloorPlan {
  const { plan } = buildFloorPlan(parsed, {
    id: planIdFor(opts.propertyId, opts.levelId),
    title: `${opts.propertyTitle} · ${opts.levelName}`,
    source: { kind: "parsed", image: opts.floorplanPath.split("/").pop(), model, parsedAt: new Date().toISOString() },
  });
  if (!plan.rooms.length) throw new Error("No rooms could be read from this drawing. Try a clearer or larger image.");
  return plan;
}

/** Read a floor's plan (src/workflows/read-plan.ts on Vercel, scripts/worker.mts locally). */
export async function readLevelPlan(supabase: SupabaseClient<Database>, opts: PlanReadTarget): Promise<FloorPlan> {
  const result = await parseFloorPlanImage(await planReadInput(supabase, opts));
  return planFromParsed(result.parsed, result.model, opts);
}

export const planJson = (plan: FloorPlan) => plan as unknown as Json;
