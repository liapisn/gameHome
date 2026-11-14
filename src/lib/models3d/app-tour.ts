/**
 * Models for a tour built in the app: download its current version from Storage into the layout the
 * workers read, and upload each room's model beside tour.json (models/<level>-<room>.glb and
 * models.json), where the Tour page finds them.
 */
import fs from "node:fs";
import path from "node:path";
import type { FloorPlan } from "@/lib/floorplan";
import { adminClient } from "@/lib/admin/jobs";
import { MEDIA_BUCKET } from "@/lib/admin/media-paths";
import { type PlanPaths, TOURS_BUCKET, photoMediaId } from "@/lib/admin/tour-paths";
import type { RoomScene } from "@/lib/scene/types";
import type { Tour } from "@/lib/tour/types";

type Admin = ReturnType<typeof adminClient>;

/** What the Tour page reads: one model per room, keyed by roomKey. */
export interface ModelsIndex {
  builtAt: string;
  rooms: { levelId: string; roomId: string; path: string; bytes: number }[];
}

export interface AppTour {
  tour: Tour;
  plans: FloorPlan[];
  scenes: RoomScene[];
  /** Storage folder of this tour version (ends with "/"). */
  folder: string;
  version: number;
}

async function readJson<T>(supabase: Admin, p: string): Promise<T> {
  const { data, error } = await supabase.storage.from(TOURS_BUCKET).download(p);
  if (error || !data) throw new Error(`Could not load ${p}: ${error?.message ?? "no data"}`);
  return JSON.parse(await data.text()) as T;
}

/** The property's current tour, its plans and scenes, and the photos the scenes use, under `dir`. */
export async function downloadAppTour(propertyId: string, dir: string): Promise<AppTour> {
  const supabase = adminClient();
  const { data: row, error } = await supabase
    .from("tours")
    .select("version, tour_path, plan_paths")
    .eq("property_id", propertyId)
    .eq("is_current", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) throw new Error("This property has no tour yet: generate one in the app first.");
  const folder = row.tour_path.replace(/[^/]+$/, "");
  const tour = await readJson<Tour>(supabase, row.tour_path);
  const plans = await Promise.all((row.plan_paths as unknown as PlanPaths).map((p) => readJson<FloorPlan>(supabase, p.path)));
  const { data: blob } = await supabase.storage.from(TOURS_BUCKET).download(`${folder}scenes.json`);
  if (!blob) throw new Error("This tour has no furnished rooms (scenes.json): generate it with furnishing on.");
  const scenes = JSON.parse(await blob.text()) as RoomScene[];

  // Photos of the furnished rooms, at the paths the tour names them (photos/<media id>.webp).
  const wanted = new Set(scenes.flatMap((s) => s.photos.filter((g) => g.gate === "pass").map((g) => g.id)));
  const photos = tour.photos.filter((p) => wanted.has(p.id));
  const ids = photos.map((p) => photoMediaId(p.src)).filter((x): x is string => !!x);
  const { data: media } = await supabase.from("media").select("id, storage_path").eq("property_id", propertyId).in("id", ids);
  for (const p of photos) {
    const out = path.join(dir, p.src);
    if (fs.existsSync(out)) continue;
    const m = media?.find((x) => x.id === photoMediaId(p.src));
    if (!m) continue;
    const { data, error: dlError } = await supabase.storage.from(MEDIA_BUCKET).download(m.storage_path);
    if (dlError || !data) throw new Error(`Could not download ${p.src}: ${dlError?.message}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(await data.arrayBuffer()));
  }
  fs.mkdirSync(dir, { recursive: true });
  const local: Tour = { ...tour, mediaRoot: dir };
  fs.writeFileSync(path.join(dir, "tour.json"), JSON.stringify(local, null, 2));
  return { tour: local, plans, scenes, folder, version: row.version };
}

/** Upload room models beside the tour and the index the Tour page reads. */
export async function uploadModels(folder: string, rooms: { levelId: string; roomId: string; glb: string }[]): Promise<ModelsIndex> {
  const supabase = adminClient();
  const index: ModelsIndex = { builtAt: new Date().toISOString(), rooms: [] };
  for (const r of rooms) {
    const p = `${folder}models/${r.levelId}-${r.roomId}.glb`;
    const body = fs.readFileSync(r.glb);
    const { error } = await supabase.storage.from(TOURS_BUCKET).upload(p, body, { contentType: "model/gltf-binary", upsert: true });
    if (error) throw new Error(`Upload ${p}: ${error.message}`);
    index.rooms.push({ levelId: r.levelId, roomId: r.roomId, path: p, bytes: body.length });
  }
  const { error } = await supabase.storage
    .from(TOURS_BUCKET)
    .upload(`${folder}models.json`, JSON.stringify(index, null, 2), { contentType: "application/json", upsert: true });
  if (error) throw new Error(`Upload models.json: ${error.message}`);
  return index;
}
