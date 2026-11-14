/**
 * Tour build jobs against Supabase with the service-role key: claim, export uploads into the
 * engine's folder layout, store results, finish. Shared by the local worker (scripts/worker.mts)
 * and the Vercel workflow (src/workflows/build-tour.ts). Server-side only; never import from the browser.
 */
import fs from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FloorPlan } from "@/lib/floorplan";
import type { BuildProgress, Manifest } from "@/lib/engine/build-tour";
import type { RoomScene } from "@/lib/scene/types";
import type { Tour } from "@/lib/tour/types";
import type { Database, Json } from "@/lib/supabase/database.types";
import { MEDIA_BUCKET } from "./media-paths";
import { TOURS_BUCKET, tourFolder } from "./tour-paths";

export type Admin = SupabaseClient<Database>;
export type JobRow = Database["public"]["Tables"]["jobs"]["Row"];

export function adminClient(): Admin {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return createClient<Database>(url, key, { auth: { persistSession: false } });
}

/** Claim one specific queued job. Null if it isn't queued any more (another worker took it). */
export async function claimJob(supabase: Admin, jobId: string, workerId: string): Promise<JobRow | null> {
  const { data: current } = await supabase.from("jobs").select("attempts").eq("id", jobId).single();
  const { data } = await supabase
    .from("jobs")
    .update({ status: "running", started_at: new Date().toISOString(), worker_id: workerId, attempts: (current?.attempts ?? 0) + 1 })
    .eq("id", jobId)
    .eq("status", "queued")
    .select()
    .maybeSingle();
  return data;
}

export async function writeJobProgress(supabase: Admin, jobId: string, progress: BuildProgress) {
  await supabase.from("jobs").update({ progress: progress as unknown as NonNullable<Json> }).eq("id", jobId);
}

export async function finishJob(supabase: Admin, jobId: string, status: "succeeded" | "failed", error?: string) {
  const { data: job } = await supabase
    .from("jobs")
    .update({ status, error: error?.slice(0, 1000) ?? null, finished_at: new Date().toISOString() })
    .eq("id", jobId)
    .select("property_id")
    .single();
  if (!job) return;
  // The property is ready if it has any tour (this one or an earlier one), otherwise back to draft.
  const { count } = await supabase.from("tours").select("id", { count: "exact", head: true }).eq("property_id", job.property_id);
  const { data: property } = await supabase.from("properties").select("status").eq("id", job.property_id).single();
  if (property?.status !== "published") {
    await supabase.from("properties").update({ status: count ? "ready" : "draft" }).eq("id", job.property_id);
  }
}

async function download(supabase: Admin, from: string, dest: string) {
  const { data, error } = await supabase.storage.from(MEDIA_BUCKET).download(from);
  if (error || !data) throw new Error(`Could not download ${from}: ${error?.message ?? "no data"}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await data.arrayBuffer()));
}

export interface ExportedProperty {
  id: string;
  orgId: string;
  title: string;
  manifest: Manifest;
  /** Folder holding the floors' stored plans as the engine's plan cache (`plansDir` of buildPlans/buildTour). */
  plansDir: string;
  /** Floors whose plan was already stored (read on upload or by an earlier build). */
  storedPlans: string[];
}

/** Plan id the engine gives a floor: `${propertyId}-${levelId}` (see engine/build-tour.ts). */
const planIdOf = (propertyId: string, levelId: string) => `${propertyId}-${levelId}`;

/**
 * Store plans a build had to read (floors whose plan wasn't read on upload), so later builds and
 * photo tagging use the same rooms. Never overwrites a plan stored meanwhile.
 */
export async function saveNewPlans(supabase: Admin, property: Pick<ExportedProperty, "id" | "storedPlans">, plans: FloorPlan[]) {
  for (const plan of plans) {
    const levelId = plan.id.slice(property.id.length + 1);
    if (!plan.id.startsWith(`${property.id}-`) || property.storedPlans.includes(levelId)) continue;
    await supabase.from("levels").update({ plan: plan as unknown as Json }).eq("id", levelId).is("plan", null);
  }
}

/**
 * Export a property's uploads into `dir` in the engine's folder layout (manifest.json,
 * floorplans/, photos/). `photos` limits which photo files are downloaded (by manifest file
 * name); the manifest always lists them all.
 */
export async function exportProperty(
  supabase: Admin,
  propertyId: string,
  dir: string,
  opts: { photos?: string[]; floorplans?: boolean } = {},
): Promise<ExportedProperty> {
  const { data: p, error } = await supabase
    .from("properties")
    .select("id, org_id, title, levels ( id, name, sort, floorplan_path, plan ), media ( id, kind, storage_path, level_id, hint, room_type, room_id, sort )")
    .eq("id", propertyId)
    .single();
  if (error || !p) throw new Error(`Property not found: ${error?.message ?? propertyId}`);

  const levels = [...p.levels].sort((a, b) => a.sort - b.sort);
  const photos = p.media.filter((m) => m.kind === "photo").sort((a, b) => a.sort - b.sort);
  const fileOf = (id: string) => `photos/${id}.webp`;
  const manifest: Manifest = {
    levels: levels.map((l) => ({
      id: l.id,
      name: l.name,
      floorplan: l.floorplan_path ? `floorplans/${l.id}.webp` : null,
      ...(l.floorplan_path ? {} : { note: "a floor of this property without a floor plan" }),
    })),
    // Photo files are named after their media row, so the tour's `src` maps straight back to Storage.
    photos: photos.map((m) => ({
      file: fileOf(m.id),
      hint: m.hint ?? undefined,
      level: m.level_id ?? undefined,
      roomType: m.room_type ?? undefined,
      // A room id only means something on the stored plan it was picked from.
      roomId: m.room_id && levels.some((l) => l.id === m.level_id && l.plan) ? m.room_id : undefined,
    })),
  };
  if (opts.floorplans !== false) {
    for (const l of levels) if (l.floorplan_path) await download(supabase, l.floorplan_path, path.join(dir, `floorplans/${l.id}.webp`));
  }
  const queue = photos.filter((m) => !opts.photos || opts.photos.includes(fileOf(m.id)));
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let m = queue.shift(); m; m = queue.shift()) await download(supabase, m.storage_path, path.join(dir, fileOf(m.id)));
    }),
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  // Stored plans go where the engine looks for cached ones, so a build reuses them instead of
  // reading the drawing again (and keeps the room ids photos may be tagged with).
  const plansDir = path.join(dir, "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  const storedPlans: string[] = [];
  for (const l of levels) {
    if (!l.floorplan_path || !l.plan) continue;
    fs.writeFileSync(path.join(plansDir, `${planIdOf(p.id, l.id)}.json`), JSON.stringify(l.plan));
    storedPlans.push(l.id);
  }
  return { id: p.id, orgId: p.org_id, title: p.title, manifest, plansDir, storedPlans };
}

/** Store a built tour as the property's next version and make it current. */
export async function storeTour(
  supabase: Admin,
  opts: { property: Pick<ExportedProperty, "id" | "orgId">; jobId: string; tour: Tour; plans: FloorPlan[] },
): Promise<{ version: number; folder: string }> {
  const { data: last } = await supabase
    .from("tours")
    .select("version")
    .eq("property_id", opts.property.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = (last?.version ?? 0) + 1;
  const folder = tourFolder(opts.property.orgId, opts.property.id, version);
  const upload = (name: string, body: unknown) => uploadTourFile(supabase, folder, name, body);
  const tourPath = await upload("tour.json", { ...opts.tour, mediaRoot: "" });
  const planPaths = [];
  for (const plan of opts.plans) planPaths.push({ planId: plan.id, path: await upload(`plan-${plan.id}.json`, plan) });

  await supabase.from("tours").update({ is_current: false }).eq("property_id", opts.property.id).eq("is_current", true);
  const { error } = await supabase.from("tours").insert({
    property_id: opts.property.id,
    job_id: opts.jobId,
    version,
    tour_path: tourPath,
    plan_paths: planPaths as unknown as NonNullable<Json>,
    is_current: true,
  });
  if (error) throw new Error(`Saving tour: ${error.message}`);
  return { version, folder };
}

export async function uploadTourFile(supabase: Admin, folder: string, name: string, body: unknown) {
  const { error } = await supabase.storage
    .from(TOURS_BUCKET)
    .upload(`${folder}${name}`, JSON.stringify(body), { contentType: "application/json", upsert: true });
  if (error) throw new Error(`Upload ${name}: ${error.message}`);
  return `${folder}${name}`;
}

/** Furniture from photos, stored beside tour.json (the Tour page loads it if present). */
export const storeScenes = (supabase: Admin, folder: string, scenes: RoomScene[]) => uploadTourFile(supabase, folder, "scenes.json", scenes);
