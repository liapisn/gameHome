"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import sharp from "sharp";
import { z } from "zod";
import { defaultLevelName, requireSession } from "@/lib/admin/data";
import { MAX_PHOTOS_PER_PROPERTY, MEDIA_BUCKET, floorplanPath, photoPath, thumbPathFor } from "@/lib/admin/media-paths";
import { fetchProspertyListing, prospertyListingId } from "@/lib/import/prosperty";
import { startPlanRead } from "@/lib/admin/start-plan-read";

/*
 * A Prosperty import runs as a few short steps that the page calls in turn, so it can show
 * where it is (an import of 25 photos takes a minute or two):
 *   startProspertyImport → importProspertyPhotos (in batches) → importProspertyFloorplans
 * The last step also starts reading the plans into rooms in the background; once every floor
 * is read, the photos' rooms are estimated from them (src/workflows/read-plan.ts).
 */

/** Prosperty serves its images from this CDN only; no other URL is ever fetched. */
const IMAGE_HOST = "d1klmnstaodrbh.cloudfront.net";
/** Most photos one importProspertyPhotos call takes; they're processed in parallel. */
const PHOTO_BATCH = 4;

const ImageUrl = z.url().refine((u) => {
  const url = new URL(u);
  return url.protocol === "https:" && url.hostname === IMAGE_HOST;
}, "Not a Prosperty image");

type Supabase = Awaited<ReturnType<typeof requireSession>>["supabase"];
type Encoded = { data: Buffer; width: number; height: number; bytes: number };

export type ImportPlan = {
  propertyId: string;
  title: string;
  summary: string;
  photoUrls: string[];
  floorplanUrls: string[];
};

async function download(url: string): Promise<Buffer> {
  const res = await fetch(ImageUrl.parse(url), { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Image download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Same sizes and quality as the browser uploader (lib/image-resize). */
async function encode(input: Buffer, maxSide: number, quality: number): Promise<Encoded> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, bytes: info.size };
}

async function upload(supabase: Supabase, path: string, file: Encoded) {
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(path, file.data, { contentType: "image/webp" });
  if (error) throw new Error(error.message);
}

/** A property of the signed-in user's org (RLS decides), or throw. */
async function ownProperty(propertyId: string) {
  z.uuid().parse(propertyId);
  const { supabase, org } = await requireSession();
  const { data, error } = await supabase.from("properties").select("id").eq("id", propertyId).eq("org_id", org.id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Property not found");
  return { supabase, orgId: org.id };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (e: unknown): { ok: false; error: string } => ({
  ok: false,
  error: e instanceof Error ? e.message : "Something went wrong.",
});

/** Step 1: read the listing and create the property with its details and floors. */
export async function startProspertyImport(link: string): Promise<Result<ImportPlan>> {
  const listingId = prospertyListingId(link);
  if (!listingId) return { ok: false, error: "Paste a link like theprosperty.com/listings/16042" };
  try {
    const listing = await fetchProspertyListing(listingId);
    const { supabase, org } = await requireSession();
    const { data: property, error } = await supabase
      .from("properties")
      .insert({
        org_id: org.id,
        title: listing.title.slice(0, 120),
        kind: listing.kind,
        city: listing.city,
        area: listing.area,
        lat: listing.lat,
        lng: listing.lng,
        total_area_m2: listing.totalAreaM2 != null && listing.totalAreaM2 <= 10000 ? listing.totalAreaM2 : null,
        bedrooms: listing.bedrooms,
        bathrooms: listing.bathrooms,
        description: listing.description,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);

    const { error: levelsError } = await supabase
      .from("levels")
      .insert(
        Array.from({ length: listing.levels }, (_, i) => ({ property_id: property.id, name: defaultLevelName(i), sort: i })),
      );
    if (levelsError) throw new Error(levelsError.message);
    revalidatePath("/app");

    const summary = [
      listing.totalAreaM2 && `${listing.totalAreaM2} m²`,
      listing.bedrooms != null && `${listing.bedrooms} bed`,
      listing.bathrooms != null && `${listing.bathrooms} bath`,
      [listing.area, listing.city].filter(Boolean).join(", "),
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      ok: true,
      value: {
        propertyId: property.id,
        title: listing.title,
        summary,
        photoUrls: listing.photoUrls.slice(0, MAX_PHOTOS_PER_PROPERTY),
        floorplanUrls: listing.floorplanUrls.slice(0, listing.levels),
      },
    };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Step 2, once per batch: copy these photos (download, encode full + thumb, upload) and record
 * them from position `startSort`, keeping listing order. Returns how many were saved.
 */
export async function importProspertyPhotos(
  propertyId: string,
  urls: string[],
  startSort: number,
): Promise<Result<{ saved: number; failed: number }>> {
  try {
    const parsed = z.array(ImageUrl).min(1).max(PHOTO_BATCH).parse(urls);
    const sortFrom = z.number().int().min(0).max(MAX_PHOTOS_PER_PROPERTY).parse(startSort);
    const { supabase, orgId } = await ownProperty(propertyId);

    const results = await Promise.allSettled(
      parsed.map(async (url) => {
        const source = await download(url);
        const [full, thumb] = await Promise.all([encode(source, 2560, 85), encode(source, 480, 75)]);
        const path = photoPath(orgId, propertyId, randomUUID());
        await Promise.all([upload(supabase, path, full), upload(supabase, thumbPathFor(path), thumb)]);
        return { path, full };
      }),
    );
    const rows = results.flatMap((r, i) =>
      r.status === "fulfilled"
        ? [
            {
              property_id: propertyId,
              kind: "photo" as const,
              storage_path: r.value.path,
              width: r.value.full.width,
              height: r.value.full.height,
              bytes: r.value.full.bytes,
              sort: sortFrom + i,
            },
          ]
        : [],
    );
    if (rows.length) {
      const { error } = await supabase.from("media").insert(rows);
      if (error) throw new Error(error.message);
    }
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length) console.error(`Prosperty import ${propertyId}: ${failed.length} photo(s) failed`, failed);
    return { ok: true, value: { saved: rows.length, failed: failed.length } };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Step 3: copy the floor plans, the n-th plan onto the n-th floor, then start reading them into
 * rooms; after the last read the photos' rooms are estimated. Both carry on after the page leaves.
 */
export async function importProspertyFloorplans(propertyId: string, urls: string[]): Promise<Result<{ saved: number }>> {
  try {
    const parsed = z.array(ImageUrl).max(10).parse(urls);
    const { supabase, orgId } = await ownProperty(propertyId);
    const { data: levels, error } = await supabase
      .from("levels")
      .select("id")
      .eq("property_id", propertyId)
      .order("sort");
    if (error) throw new Error(error.message);

    const copied: { levelId: string; path: string }[] = [];
    for (const [i, url] of parsed.slice(0, levels.length).entries()) {
      // Plans keep more resolution so printed dimensions stay legible for the parser.
      const file = await encode(await download(url), 4096, 92);
      const path = floorplanPath(orgId, propertyId, randomUUID());
      await upload(supabase, path, file);
      const { error: mediaError } = await supabase.from("media").insert({
        property_id: propertyId,
        level_id: levels[i].id,
        kind: "floorplan",
        storage_path: path,
        width: file.width,
        height: file.height,
        bytes: file.bytes,
      });
      if (mediaError) throw new Error(mediaError.message);
      const { error: levelError } = await supabase.from("levels").update({ floorplan_path: path }).eq("id", levels[i].id);
      if (levelError) throw new Error(levelError.message);
      copied.push({ levelId: levels[i].id, path });
    }
    for (const { levelId, path } of copied) await startPlanRead(supabase, propertyId, levelId, path, { estimatePhotos: true });
    revalidatePath(`/app/properties/${propertyId}`, "layout");
    return { ok: true, value: { saved: copied.length } };
  } catch (e) {
    return fail(e);
  }
}
