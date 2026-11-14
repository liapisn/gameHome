"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { defaultLevelName } from "@/lib/admin/data";
import { ROOM_TYPES, type RoomType } from "@/lib/floorplan";
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
  const { data, error } = await supabase.from("properties").select("id, org_id").eq("id", propertyId).maybeSingle();
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

export async function updatePhoto(propertyId: string, mediaId: string, patch: { levelId?: string | null; hint?: string; roomType?: RoomType | null }) {
  Uuid.parse(mediaId);
  const update = z
    .object({ levelId: Uuid.nullable().optional(), hint: z.string().trim().max(120).optional(), roomType: z.enum(ROOM_TYPES).nullable().optional() })
    .parse(patch);
  const { supabase } = await accessibleProperty(propertyId);

  const { error } = await supabase
    .from("media")
    .update({
      ...(update.levelId !== undefined ? { level_id: update.levelId } : {}),
      ...(update.hint !== undefined ? { hint: update.hint || null } : {}),
      ...(update.roomType !== undefined ? { room_type: update.roomType } : {}),
    })
    .eq("id", mediaId)
    .eq("property_id", propertyId);
  if (error) throw new Error(error.message);
  refresh(propertyId);
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
    .select("id, floorplan_path")
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

  const { error } = await supabase.from("levels").update({ floorplan_path: path }).eq("id", levelId);
  if (error) throw new Error(error.message);
  refresh(propertyId);
}

export async function removeFloorplan(propertyId: string, levelId: string) {
  const { supabase, level } = await accessibleLevel(propertyId, levelId);
  await removeFloorplanFiles(supabase, levelId, level.floorplan_path);
  const { error } = await supabase.from("levels").update({ floorplan_path: null }).eq("id", levelId);
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
