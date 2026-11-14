"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { defaultLevelName } from "@/lib/admin/data";
import { type FloorPlan, ROOM_TYPES, type RoomType } from "@/lib/floorplan";
import { planJson, readLevelPlan } from "@/lib/admin/plan-read";
import { estimatePhotoRooms } from "@/lib/admin/room-estimates";
import type { RoomEstimate } from "@/lib/tour/estimate-room";
import {
  MAX_PHOTOS_PER_PROPERTY,
  MEDIA_BUCKET,
  floorplanPath,
  photoPath,
  thumbPathFor,
} from "@/lib/admin/media-paths";

const Uuid = z.uuid();
const Dimensions = z.object({
  width: z.number().int().positive().max(20000),
  height: z.number().int().positive().max(20000),
  bytes: z.number().int().positive().max(60 * 1024 * 1024),
});

/** Load a property the current user can access (RLS decides), or throw. */
async function accessibleProperty(propertyId: string) {
  Uuid.parse(propertyId);
  const supabase = await createClient();
  const { data, error } = await supabase.from("properties").select("id, org_id, title").eq("id", propertyId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Property not found");
  return { supabase, property: data };
}

function refresh(propertyId: string) {
  revalidatePath(`/app/properties/${propertyId}`, "layout");
}

// ─── Photos ──────────────────────────────────────────────────────────────────

const RecordPhotoSchema = Dimensions.extend({ fileId: Uuid });

/**
 * Record photos the browser has already uploaded. Paths are rebuilt server-side from
 * the property's org, so a client can only register files inside its own property folder.
 */
export async function recordPhotos(propertyId: string, items: z.input<typeof RecordPhotoSchema>[]) {
  const parsed = z.array(RecordPhotoSchema).min(1).max(MAX_PHOTOS_PER_PROPERTY).parse(items);
  const { supabase, property } = await accessibleProperty(propertyId);

  const { data: existing, error: countError } = await supabase
    .from("media")
    .select("sort")
    .eq("property_id", propertyId)
    .eq("kind", "photo")
    .order("sort", { ascending: false });
  if (countError) throw new Error(countError.message);
  if ((existing?.length ?? 0) + parsed.length > MAX_PHOTOS_PER_PROPERTY) {
    throw new Error(`A property can have at most ${MAX_PHOTOS_PER_PROPERTY} photos.`);
  }

  const startSort = (existing?.[0]?.sort ?? -1) + 1;
  const { data, error } = await supabase
    .from("media")
    .insert(
      parsed.map((p, i) => ({
        property_id: propertyId,
        kind: "photo" as const,
        storage_path: photoPath(property.org_id, propertyId, p.fileId),
        width: p.width,
        height: p.height,
        bytes: p.bytes,
        sort: startSort + i,
      })),
    )
    .select("id, storage_path");
  if (error) throw new Error(error.message);

  refresh(propertyId);
  return data.map((row) => ({ id: row.id, fileId: row.storage_path.split("/").pop()!.replace(".webp", "") }));
}

/**
 * Update what the owner says about a photo. A room (`roomId`, from the stored plan of `levelId`)
 * also sets the floor and the kind of room; a new floor or a bare room type clears the room.
 */
export async function updatePhoto(
  propertyId: string,
  mediaId: string,
  patch: { levelId?: string | null; hint?: string; roomType?: RoomType | null; roomId?: string | null },
) {
  Uuid.parse(mediaId);
  const update = z
    .object({
      levelId: Uuid.nullable().optional(),
      hint: z.string().trim().max(120).optional(),
      roomType: z.enum(ROOM_TYPES).nullable().optional(),
      roomId: z.string().max(40).nullable().optional(),
    })
    .parse(patch);
  const { supabase } = await accessibleProperty(propertyId);

  const row: { level_id?: string | null; hint?: string | null; room_type?: RoomType | null; room_id?: string | null } = {};
  if (update.levelId !== undefined) row.level_id = update.levelId;
  if (update.hint !== undefined) row.hint = update.hint || null;
  if (update.roomType !== undefined) row.room_type = update.roomType;
  if (update.levelId !== undefined || update.roomType !== undefined) row.room_id = null;
  if (update.roomId) {
    if (!update.levelId) throw new Error("Pick the floor along with the room.");
    const { level } = await accessibleLevel(propertyId, update.levelId);
    const room = (level.plan as unknown as FloorPlan | null)?.rooms.find((r) => r.id === update.roomId);
    if (!room) throw new Error("That room is no longer on the plan. Reload the page.");
    Object.assign(row, { level_id: update.levelId, room_id: room.id, room_type: room.type });
  } else if (update.roomId === null) row.room_id = null;

  const { error } = await supabase
    .from("media")
    .update(row)
    .eq("id", mediaId)
    .eq("property_id", propertyId);
  if (error) throw new Error(error.message);
  refresh(propertyId);
}

/** Most photos one call estimates (in parallel); the page sends larger sets in several calls. */
const ESTIMATE_BATCH = 6;

/** Guess the room of these photos from the floor plans (one model call each) and store the guesses. */
export async function estimateRooms(propertyId: string, mediaIds: string[]): Promise<Record<string, RoomEstimate>> {
  const ids = z.array(Uuid).min(1).max(ESTIMATE_BATCH).parse(mediaIds);
  const { supabase } = await accessibleProperty(propertyId);
  return estimatePhotoRooms(supabase, propertyId, ids);
}

export async function reorderPhotos(propertyId: string, orderedIds: string[]) {
  const ids = z.array(Uuid).max(MAX_PHOTOS_PER_PROPERTY).parse(orderedIds);
  const { supabase } = await accessibleProperty(propertyId);
  const results = await Promise.all(
    ids.map((id, sort) => supabase.from("media").update({ sort }).eq("id", id).eq("property_id", propertyId)),
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) throw new Error(failed.error.message);
  refresh(propertyId);
}

export async function deletePhotos(propertyId: string, mediaIds: string[]) {
  const ids = z.array(Uuid).min(1).parse(mediaIds);
  const { supabase } = await accessibleProperty(propertyId);

  const { data: rows, error } = await supabase
    .from("media")
    .select("id, storage_path")
    .eq("property_id", propertyId)
    .eq("kind", "photo")
    .in("id", ids);
  if (error) throw new Error(error.message);
  if (!rows.length) return;

  const { error: storageError } = await supabase.storage
    .from(MEDIA_BUCKET)
    .remove(rows.flatMap((r) => [r.storage_path, thumbPathFor(r.storage_path)]));
  if (storageError) throw new Error(storageError.message);

  const { error: deleteError } = await supabase.from("media").delete().in("id", rows.map((r) => r.id));
  if (deleteError) throw new Error(deleteError.message);
  refresh(propertyId);
}

// ─── Floors & floor plans ────────────────────────────────────────────────────

async function accessibleLevel(propertyId: string, levelId: string) {
  Uuid.parse(levelId);
  const ctx = await accessibleProperty(propertyId);
  const { data: level, error } = await ctx.supabase
    .from("levels")
    .select("id, name, floorplan_path, plan")
    .eq("id", levelId)
    .eq("property_id", propertyId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!level) throw new Error("Floor not found");
  return { ...ctx, level };
}

async function removeFloorplanFiles(supabase: Awaited<ReturnType<typeof createClient>>, levelId: string, path: string | null) {
  if (!path) return;
  await supabase.storage.from(MEDIA_BUCKET).remove([path]);
  await supabase.from("media").delete().eq("level_id", levelId).eq("kind", "floorplan");
}

export async function setFloorplan(propertyId: string, levelId: string, file: z.input<typeof RecordPhotoSchema>) {
  const parsed = RecordPhotoSchema.parse(file);
  const { supabase, property, level } = await accessibleLevel(propertyId, levelId);

  const path = floorplanPath(property.org_id, propertyId, parsed.fileId);
  await removeFloorplanFiles(supabase, levelId, level.floorplan_path);

  const { error: mediaError } = await supabase.from("media").insert({
    property_id: propertyId,
    level_id: levelId,
    kind: "floorplan",
    storage_path: path,
    width: parsed.width,
    height: parsed.height,
    bytes: parsed.bytes,
  });
  if (mediaError) throw new Error(mediaError.message);

  // A new drawing invalidates the rooms read from the old one.
  const { error } = await supabase.from("levels").update({ floorplan_path: path, plan: null }).eq("id", levelId);
  if (error) throw new Error(error.message);
  await clearRoomTags(supabase, levelId);
  refresh(propertyId);
}

export async function removeFloorplan(propertyId: string, levelId: string) {
  const { supabase, level } = await accessibleLevel(propertyId, levelId);
  await removeFloorplanFiles(supabase, levelId, level.floorplan_path);
  const { error } = await supabase.from("levels").update({ floorplan_path: null, plan: null }).eq("id", levelId);
  if (error) throw new Error(error.message);
  await clearRoomTags(supabase, levelId);
  refresh(propertyId);
}

/** Room ids belong to one reading of a plan: clear the floor's photo room tags when it changes (their room type stays). */
async function clearRoomTags(supabase: Awaited<ReturnType<typeof createClient>>, levelId: string) {
  const { error } = await supabase.from("media").update({ room_id: null }).eq("level_id", levelId).not("room_id", "is", null);
  if (error) throw new Error(error.message);
}

/** Read the floor's plan drawing into rooms (one model call, up to a minute or two) and store it. */
export async function readFloorplan(propertyId: string, levelId: string) {
  const { supabase, property, level } = await accessibleLevel(propertyId, levelId);
  if (!level.floorplan_path) throw new Error("Upload a floor plan for this floor first.");
  const plan = await readLevelPlan(supabase, {
    propertyId,
    propertyTitle: property.title,
    levelId,
    levelName: level.name,
    floorplanPath: level.floorplan_path,
  });
  // Only store it if the drawing hasn't been replaced while it was being read.
  const { error } = await supabase
    .from("levels")
    .update({ plan: planJson(plan) })
    .eq("id", levelId)
    .eq("floorplan_path", level.floorplan_path);
  if (error) throw new Error(error.message);
  await clearRoomTags(supabase, levelId);
  refresh(propertyId);
}

/** Correct a room the engine read: its name and kind of room. */
export async function updatePlanRoom(propertyId: string, levelId: string, roomId: string, patch: { name?: string; type?: RoomType }) {
  const update = z
    .object({ name: z.string().trim().min(1).max(60).optional(), type: z.enum(ROOM_TYPES).optional() })
    .parse(patch);
  const { supabase, level } = await accessibleLevel(propertyId, levelId);
  const plan = level.plan as unknown as FloorPlan | null;
  const room = plan?.rooms.find((r) => r.id === roomId);
  if (!plan || !room) throw new Error("Room not found. Read the floor plan again.");
  if (update.name) room.name = update.name;
  if (update.type) room.type = update.type;
  const { error } = await supabase.from("levels").update({ plan: planJson(plan) }).eq("id", levelId);
  if (error) throw new Error(error.message);
  refresh(propertyId);
}

export async function addLevel(propertyId: string) {
  const { supabase } = await accessibleProperty(propertyId);
  const { data: levels } = await supabase.from("levels").select("sort").eq("property_id", propertyId);
  const count = levels?.length ?? 0;
  if (count >= 10) throw new Error("A property can have at most 10 floors.");
  const sort = Math.max(-1, ...(levels ?? []).map((l) => l.sort)) + 1;
  const { error } = await supabase
    .from("levels")
    .insert({ property_id: propertyId, name: defaultLevelName(count), sort });
  if (error) throw new Error(error.message);
  refresh(propertyId);
}

export async function renameLevel(propertyId: string, levelId: string, name: string) {
  const clean = z.string().trim().min(1).max(60).parse(name);
  const { supabase } = await accessibleLevel(propertyId, levelId);
  const { error } = await supabase.from("levels").update({ name: clean }).eq("id", levelId);
  if (error) throw new Error(error.message);
  refresh(propertyId);
}

export async function deleteLevel(propertyId: string, levelId: string) {
  const { supabase, level } = await accessibleLevel(propertyId, levelId);
  const { count } = await supabase
    .from("levels")
    .select("id", { count: "exact", head: true })
    .eq("property_id", propertyId);
  if ((count ?? 0) <= 1) throw new Error("A property needs at least one floor.");
  await removeFloorplanFiles(supabase, levelId, level.floorplan_path);
  // Photos assigned to this floor keep existing; their level_id is cleared by the foreign key.
  const { error } = await supabase.from("levels").delete().eq("id", levelId);
  if (error) throw new Error(error.message);
  refresh(propertyId);
}
