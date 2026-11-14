/**
 * Estimate which room of the floor plans each photo was taken in, and store it on the photo
 * (media.room_estimate). The plans and drawings are loaded once per call and shared by its photos.
 */
import "server-only";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FloorPlan } from "@/lib/floorplan";
import type { Database, Json } from "@/lib/supabase/database.types";
import { type EstimateLevel, type RoomEstimate, estimateContext, estimateRoom } from "@/lib/tour/estimate-room";
import { MEDIA_BUCKET } from "./media-paths";

async function jpegFromStorage(supabase: SupabaseClient<Database>, path: string, size: number) {
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).download(path);
  if (error || !data) throw new Error(`Could not load ${path.split("/").pop()}: ${error?.message ?? "no data"}`);
  return (await sharp(Buffer.from(await data.arrayBuffer())).rotate().resize(size, size, { fit: "inside" }).jpeg({ quality: 86 }).toBuffer()).toString("base64");
}

export async function estimatePhotoRooms(
  supabase: SupabaseClient<Database>,
  propertyId: string,
  mediaIds: string[],
): Promise<Record<string, RoomEstimate>> {
  const { data: property, error } = await supabase
    .from("properties")
    .select("id, levels ( id, name, sort, floorplan_path, plan ), media ( id, kind, storage_path, level_id, hint )")
    .eq("id", propertyId)
    .single();
  if (error || !property) throw new Error(error?.message ?? "Property not found");

  const planned = [...property.levels].sort((a, b) => a.sort - b.sort).filter((l) => l.floorplan_path && l.plan);
  if (!planned.length) throw new Error("Read a floor plan first: rooms are estimated from the plan's rooms.");
  const levels: EstimateLevel[] = await Promise.all(
    planned.map(async (l) => ({ id: l.id, name: l.name, plan: l.plan as unknown as FloorPlan, drawing: await jpegFromStorage(supabase, l.floorplan_path!, 1600) })),
  );
  const unplanned = property.levels.filter((l) => !planned.includes(l));
  const shared = estimateContext(levels, unplanned.map((l) => l.name));

  const photos = property.media.filter((m) => m.kind === "photo" && mediaIds.includes(m.id));
  const out: Record<string, RoomEstimate> = {};
  await Promise.all(
    photos.map(async (m) => {
      // Filed under a floor without a plan: there is no room to guess.
      const estimate: RoomEstimate =
        m.level_id && unplanned.some((l) => l.id === m.level_id)
          ? { levelId: null, roomId: null, confidence: "high", reason: "Filed under a floor without a plan", model: "", at: new Date().toISOString() }
          : await estimateRoom(levels, shared, { base64: await jpegFromStorage(supabase, m.storage_path, 1280), ownerLevelId: m.level_id, note: m.hint });
      const { error: saveError } = await supabase.from("media").update({ room_estimate: estimate as unknown as Json }).eq("id", m.id);
      if (saveError) throw new Error(saveError.message);
      out[m.id] = estimate;
    }),
  );
  return out;
}
