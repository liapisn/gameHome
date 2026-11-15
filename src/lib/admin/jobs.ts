/**
 * Tour build jobs against Supabase with the service-role key: claim, export uploads into the
 * engine's folder layout, store results, finish. Shared by the local worker (scripts/worker.mts)
 * and the Vercel workflow (src/workflows/build-tour.ts). Server-side only; never import from the browser.
 */
import fs from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { type FloorPlan, uniqueRoomNames } from "@/lib/floorplan";
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
    .select("id, org_id, title, levels ( id, name, sort, floorplan_path, plan ), media ( id, kind, storage_path, level_id, hint, room_type, room_id, room_estimate, sort )")
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
    photos: photos.map((m) => {
      // The owner's room or kind of room, else the estimated room (shown to the owner, who left it as it was).
      // A room id only means something on the stored plan it was picked from.
      const est = m.room_estimate as { levelId: string | null; roomId: string | null } | null;
      const useEst = !m.room_id && !m.room_type && !!est?.levelId && !!est.roomId && (!m.level_id || m.level_id === est.levelId);
      const level = useEst ? est!.levelId! : m.level_id;
      const roomId = useEst ? est!.roomId! : m.room_id;
      return {
        file: fileOf(m.id),
        hint: m.hint ?? undefined,
        level: level ?? undefined,
        roomType: m.room_type ?? undefined,
        roomId: roomId && levels.some((l) => l.id === level && l.plan) ? roomId : undefined,
      };
    }),
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

// ---------------------------------------------------------------------------- plan reads

/** Job type of a floor plan read (src/workflows/read-plan.ts); tour builds are "build_tour". */
export const READ_PLAN = "read_plan";

/** What a read_plan job keeps in `progress`: which floor and drawing it reads. */
export interface ReadPlanProgress {
  levelId: string;
  floorplanPath: string;
  label: string;
  /** Estimate the photos' rooms once this and the property's other such reads are done (Prosperty import). */
  estimatePhotos?: boolean;
}

// ---------------------------------------------------------------------------- room estimates

/** Job type of estimating the photos' rooms after the import's plan reads. Runs inside the last read. */
export const ESTIMATE_ROOMS = "estimate_rooms";

/** Photos one estimate step handles (in parallel), as on the photos page. */
export const ESTIMATE_BATCH = 6;

export interface EstimateRoomsProgress {
  label: string;
  done: number;
  total: number;
}

/**
 * After a read that asked to estimate photos (`estimatePhotos`): if it was the property's last
 * such read still under way, and some floor now has rooms, start an estimate_rooms job for the
 * photos without a room the owner picked. Returns the job and the photos, or null if not (yet).
 */
export async function startEstimatesAfterRead(
  supabase: Admin,
  readJob: Pick<JobRow, "id" | "property_id" | "progress">,
): Promise<{ jobId: string; mediaIds: string[] } | null> {
  if (!(readJob.progress as unknown as ReadPlanProgress).estimatePhotos) return null;
  const propertyId = readJob.property_id;
  const { data: others } = await supabase
    .from("jobs")
    .select("progress")
    .eq("property_id", propertyId)
    .eq("type", READ_PLAN)
    .in("status", ["queued", "running"])
    .neq("id", readJob.id);
  if (others?.some((o) => (o.progress as unknown as ReadPlanProgress).estimatePhotos)) return null;
  return startEstimateJob(supabase, propertyId);
}

/**
 * Start an estimate_rooms job (status running, so the local worker never claims it) for the
 * photos without a room the owner picked, if some floor has rooms. Null if there's nothing to do.
 * Used after the import's plan reads, and by a Matterport import, whose plans need no read.
 */
export async function startEstimateJob(supabase: Admin, propertyId: string): Promise<{ jobId: string; mediaIds: string[] } | null> {
  const { data: planned } = await supabase.from("levels").select("id").eq("property_id", propertyId).not("plan", "is", null).limit(1);
  if (!planned?.length) return null;
  const { data: photos, error } = await supabase
    .from("media")
    .select("id")
    .eq("property_id", propertyId)
    .eq("kind", "photo")
    .is("room_id", null)
    .is("room_type", null)
    .order("sort");
  if (error) throw new Error(error.message);
  if (!photos.length) return null;

  const progress: EstimateRoomsProgress = { label: "Estimating rooms", done: 0, total: photos.length };
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .insert({
      property_id: propertyId,
      type: ESTIMATE_ROOMS,
      status: "running",
      started_at: new Date().toISOString(),
      progress: progress as unknown as NonNullable<Json>,
    })
    .select("id")
    .single();
  if (jobError || !job) throw new Error(jobError?.message ?? "Could not start estimating rooms.");
  return { jobId: job.id, mediaIds: photos.map((p) => p.id) };
}

export async function writeEstimateProgress(supabase: Admin, jobId: string, done: number, total: number) {
  const progress: EstimateRoomsProgress = { label: "Estimating rooms", done, total };
  await supabase.from("jobs").update({ progress: progress as unknown as NonNullable<Json> }).eq("id", jobId);
}

/** Finish a plan read. Unlike a tour build, it leaves the property's status alone. */
export async function finishReadJob(supabase: Admin, jobId: string, status: "succeeded" | "failed", error?: string) {
  await supabase
    .from("jobs")
    .update({ status, error: error?.slice(0, 1000) ?? null, finished_at: new Date().toISOString() })
    .eq("id", jobId);
}

/** Store a floor's freshly read plan, unless its drawing was replaced meanwhile; photo room tags on the floor are cleared. */
export async function storeReadPlan(supabase: Admin, levelId: string, floorplanPath: string, plan: FloorPlan): Promise<boolean> {
  // Room names are unique across the whole home, not just this floor: a second floor's
  // "Bedroom" carries on the numbering of the first.
  const { data: level } = await supabase.from("levels").select("property_id").eq("id", levelId).maybeSingle();
  if (level) {
    const { data: others } = await supabase.from("levels").select("plan").eq("property_id", level.property_id).neq("id", levelId);
    uniqueRoomNames(plan.rooms, (others ?? []).flatMap((o) => (o.plan as unknown as FloorPlan | null)?.rooms.map((r) => r.name) ?? []));
  }
  const { data, error } = await supabase
    .from("levels")
    .update({ plan: plan as unknown as Json })
    .eq("id", levelId)
    .eq("floorplan_path", floorplanPath)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) return false;
  const { error: tagError } = await supabase.from("media").update({ room_id: null }).eq("level_id", levelId).not("room_id", "is", null);
  if (tagError) throw new Error(tagError.message);
  return true;
}
