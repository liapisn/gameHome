/**
 * Import a local listing folder (fixtures layout) into an organization, exactly as if an owner had
 * uploaded it through the admin UI: property → floors with plans → photos in order, all resized
 * the same way the browser does (WebP; photos 2560 px + 480 px thumbs, plans 4096 px).
 *
 *   npx tsx --env-file=.env.local scripts/import-listing.mts fixtures/listing-15970 \
 *     --org "nikos's workspace" --title "Marousi house" --kind house --city Marousi
 *
 * Only levels that have a floor plan become floors. Ground-truth labels in the manifest are NOT
 * copied (no hints, no floor assignment), so the engine sees what a real owner upload looks like.
 * Uses the service-role key: run locally, never in the browser or on Vercel.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/lib/supabase/database.types";
import { MEDIA_BUCKET, floorplanPath, photoPath, thumbPathFor } from "../src/lib/admin/media-paths";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    org: { type: "string" },
    title: { type: "string" },
    kind: { type: "string", default: "house" },
    city: { type: "string" },
  },
});
const dir = positionals[0];
if (!dir || !values.org || !values.title) {
  console.error('Usage: import-listing.mts <listing-dir> --org "<org name or id>" --title "<title>" [--kind house] [--city X]');
  process.exit(1);
}

const supabase = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

interface Manifest {
  levels: { id: string; name: string; floorplan: string | null }[];
  photos: { file: string }[];
}
const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

const { data: orgs, error: orgError } = await supabase.from("organizations").select("id, name");
if (orgError) throw orgError;
const org = orgs.find((o) => o.id === values.org || o.name === values.org);
if (!org) throw new Error(`No organization "${values.org}". Have: ${orgs.map((o) => o.name).join(", ")}`);

async function upload(storagePath: string, body: Buffer) {
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(storagePath, body, { contentType: "image/webp" });
  if (error) throw new Error(`${storagePath}: ${error.message}`);
}
const webp = (file: string, maxSide: number, quality: number) =>
  sharp(file)
    .rotate()
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });

const { data: property, error: propError } = await supabase
  .from("properties")
  .insert({ org_id: org.id, title: values.title, kind: values.kind as Database["public"]["Enums"]["property_kind"], city: values.city ?? null })
  .select("id")
  .single();
if (propError) throw propError;
console.log(`Property ${property.id} in ${org.name}`);

const planned = manifest.levels.filter((l) => l.floorplan);
for (const [sort, level] of planned.entries()) {
  const { data: row, error } = await supabase
    .from("levels")
    .insert({ property_id: property.id, name: level.name, sort })
    .select("id")
    .single();
  if (error) throw error;
  const { data, info } = await webp(path.join(dir, level.floorplan!), 4096, 90);
  const p = floorplanPath(org.id, property.id, randomUUID());
  await upload(p, data);
  const { error: mErr } = await supabase.from("media").insert({
    property_id: property.id,
    level_id: row.id,
    kind: "floorplan",
    storage_path: p,
    width: info.width,
    height: info.height,
    bytes: info.size,
  });
  if (mErr) throw mErr;
  const { error: lErr } = await supabase.from("levels").update({ floorplan_path: p }).eq("id", row.id);
  if (lErr) throw lErr;
  console.log(`  floor "${level.name}" with plan (${info.width}×${info.height})`);
}

let done = 0;
const rows: Database["public"]["Tables"]["media"]["Insert"][] = [];
const queue = manifest.photos.map((ph, sort) => ({ ...ph, sort }));
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let ph = queue.shift(); ph; ph = queue.shift()) {
      const src = path.join(dir, ph.file);
      const [full, thumb] = await Promise.all([webp(src, 2560, 85), webp(src, 480, 75)]);
      const p = photoPath(org.id, property.id, randomUUID());
      await Promise.all([upload(p, full.data), upload(thumbPathFor(p), thumb.data)]);
      rows.push({
        property_id: property.id,
        kind: "photo",
        storage_path: p,
        width: full.info.width,
        height: full.info.height,
        bytes: full.info.size,
        sort: ph.sort,
      });
      process.stdout.write(`\r  photos ${++done}/${manifest.photos.length}`);
    }
  }),
);
const { error: insertError } = await supabase.from("media").insert(rows.sort((a, b) => a.sort! - b.sort!));
if (insertError) throw insertError;
console.log(`\nDone: /app/properties/${property.id}`);
