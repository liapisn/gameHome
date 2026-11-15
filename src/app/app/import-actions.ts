"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import sharp from "sharp";
import { defaultLevelName, requireSession } from "@/lib/admin/data";
import { MAX_PHOTOS_PER_PROPERTY, MEDIA_BUCKET, floorplanPath, photoPath, thumbPathFor } from "@/lib/admin/media-paths";
import { fetchProspertyListing, prospertyListingId } from "@/lib/import/prosperty";
import type { FormState } from "./actions";

/** Prosperty serves its images from this CDN only; anything else in the payload is not fetched. */
const IMAGE_HOST = "d1klmnstaodrbh.cloudfront.net";
const PARALLEL = 4;

type Supabase = Awaited<ReturnType<typeof requireSession>>["supabase"];
type Encoded = { data: Buffer; width: number; height: number; bytes: number };

async function download(url: string): Promise<Buffer> {
  if (new URL(url).hostname !== IMAGE_HOST) throw new Error(`Unexpected image host in ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
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

/** Map with at most `limit` in flight, keeping order; a failed item becomes an Error. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<(R | Error)[]> {
  const out: (R | Error)[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
      }
    }),
  );
  return out;
}

/**
 * Create a property from a Prosperty listing link: details, floors, all photos and the
 * floor plan(s), copied into our storage. Reading the plan stays a separate step.
 */
export async function importFromProsperty(_prev: FormState, formData: FormData): Promise<FormState> {
  const link = String(formData.get("url") ?? "");
  const listingId = prospertyListingId(link);
  if (!listingId) return { fieldErrors: { url: "Paste a link like theprosperty.com/listings/16042" } };

  let listing;
  try {
    listing = await fetchProspertyListing(listingId);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not read the listing." };
  }

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
  if (error) return { error: error.message };

  const { data: levels, error: levelsError } = await supabase
    .from("levels")
    .insert(
      Array.from({ length: listing.levels }, (_, i) => ({ property_id: property.id, name: defaultLevelName(i), sort: i })),
    )
    .select("id, sort");
  if (levelsError) return { error: levelsError.message };
  levels.sort((a, b) => a.sort - b.sort);

  // Photos: download, encode full + thumb, upload; record the ones that made it, in listing order.
  const photos = await mapLimited(listing.photoUrls.slice(0, MAX_PHOTOS_PER_PROPERTY), PARALLEL, async (url) => {
    const source = await download(url);
    const [full, thumb] = await Promise.all([encode(source, 2560, 85), encode(source, 480, 75)]);
    const path = photoPath(org.id, property.id, randomUUID());
    await Promise.all([upload(supabase, path, full), upload(supabase, thumbPathFor(path), thumb)]);
    return { path, full };
  });
  const saved = photos.filter((p): p is Exclude<typeof p, Error> => !(p instanceof Error));
  if (saved.length) {
    const { error: mediaError } = await supabase.from("media").insert(
      saved.map((p, sort) => ({
        property_id: property.id,
        kind: "photo" as const,
        storage_path: p.path,
        width: p.full.width,
        height: p.full.height,
        bytes: p.full.bytes,
        sort,
      })),
    );
    if (mediaError) return { error: mediaError.message };
  }

  // Floor plans: the n-th plan goes on the n-th floor. Plans keep more resolution for the parser.
  const plans = await mapLimited(listing.floorplanUrls.slice(0, levels.length), PARALLEL, async (url) => {
    const file = await encode(await download(url), 4096, 92);
    const path = floorplanPath(org.id, property.id, randomUUID());
    await upload(supabase, path, file);
    return { path, file };
  });
  for (const [i, plan] of plans.entries()) {
    if (plan instanceof Error) continue;
    const levelId = levels[i].id;
    const { error: planMediaError } = await supabase.from("media").insert({
      property_id: property.id,
      level_id: levelId,
      kind: "floorplan",
      storage_path: plan.path,
      width: plan.file.width,
      height: plan.file.height,
      bytes: plan.file.bytes,
    });
    if (planMediaError) return { error: planMediaError.message };
    const { error: levelError } = await supabase.from("levels").update({ floorplan_path: plan.path }).eq("id", levelId);
    if (levelError) return { error: levelError.message };
  }

  const failed = [...photos, ...plans].filter((p) => p instanceof Error);
  if (failed.length) console.error(`Prosperty import ${listingId}: ${failed.length} image(s) failed`, failed);

  revalidatePath("/app");
  redirect(`/app/properties/${property.id}`);
}
