/**
 * Tour build on Vercel: a durable workflow started by the Generate button (generate/actions.ts),
 * so no worker has to be running. Each step is a short, retried function invocation; steps don't
 * share a disk, so each exports the uploads it needs from Storage into its own temp folder and
 * passes plans and placements on as step results.
 *
 *   claim → plans → place photos (batches of 4, in parallel) → assemble + store tour
 *         → furnish rooms (in parallel; skip with TOUR_FURNISH=0) → store scenes → finish
 *
 * Same engine and storage layout as the local worker (scripts/worker.mts).
 */
import path from "node:path";
import { FatalError } from "workflow";
import { adminClient, claimJob, exportProperty, finishJob, saveNewPlans, storeScenes, storeTour, writeJobProgress } from "@/lib/admin/jobs";
import { removeWorkdir, workdir } from "@/lib/admin/workdir";
import type { FloorPlan } from "@/lib/floorplan";
import { buildRoomScene, scenePhotos, sceneRooms } from "@/lib/engine/build-scene";
import { type BuildProgress, type Placements, assembleTour, buildPlans, placePhotos, prepareBuild } from "@/lib/engine/build-tour";
import type { RoomScene } from "@/lib/scene/types";
import type { Tour } from "@/lib/tour/types";

const BATCH = 4;

export async function buildTourWorkflow(jobId: string) {
  "use workflow";

  const job = await claim(jobId);
  if (!job) return { skipped: true };

  try {
    const { plans, files, title } = await readPlans(jobId, job.propertyId);

    const batches: string[][] = [];
    for (let i = 0; i < files.length; i += BATCH) batches.push(files.slice(i, i + BATCH));
    let placed = 0;
    await progress(jobId, { step: "photos", label: "Placing photos", done: 0, total: files.length });
    const results = await Promise.all(
      batches.map(async (b) => {
        const r = await placeBatch(job.propertyId, title, plans, b);
        placed += b.length;
        await progress(jobId, { step: "photos", label: "Placing photos", done: placed, total: files.length });
        return r;
      }),
    );
    const placements: Placements = Object.assign({}, ...results.map((r) => r.placements));
    if (!Object.keys(placements).length) {
      throw new FatalError(`Every photo failed to place. Last error: ${results.map((r) => r.lastError).find(Boolean) ?? "unknown"}`);
    }

    const stored = await assemble(jobId, job.propertyId, title, plans, placements);

    if (stored.furnish && stored.rooms.length) {
      let furnished = 0;
      await progress(jobId, { step: "furnish", label: "Furnishing rooms from photos", done: 0, total: stored.rooms.length });
      const scenes = await Promise.all(
        stored.rooms.map(async (room) => {
          // A room that fails is skipped; the tour is already stored.
          const scene = await furnishRoom(job.propertyId, stored.tour, plans, room).catch(() => null);
          furnished++;
          await progress(jobId, { step: "furnish", label: "Furnishing rooms from photos", done: furnished, total: stored.rooms.length });
          return scene;
        }),
      );
      await saveScenes(stored.folder, scenes.filter((s): s is RoomScene => !!s));
    }

    await progress(jobId, { step: "done", label: "Done", done: 1, total: 1 });
    await finish(jobId, "succeeded");
    return { version: stored.version };
  } catch (err) {
    await finish(jobId, "failed", (err as Error).message || String(err));
    throw err;
  }
}

// ---------------------------------------------------------------------------- steps

async function claim(jobId: string): Promise<{ propertyId: string } | null> {
  "use step";
  const job = await claimJob(adminClient(), jobId, `vercel-workflow:${jobId.slice(0, 8)}`);
  return job ? { propertyId: job.property_id } : null;
}

async function progress(jobId: string, p: BuildProgress) {
  "use step";
  await writeJobProgress(adminClient(), jobId, p);
}

async function finish(jobId: string, status: "succeeded" | "failed", error?: string) {
  "use step";
  await finishJob(adminClient(), jobId, status, error);
}

async function readPlans(jobId: string, propertyId: string): Promise<{ plans: FloorPlan[]; files: string[]; title: string }> {
  "use step";
  const supabase = adminClient();
  const dir = workdir();
  try {
    const property = await exportProperty(supabase, propertyId, dir, { photos: [] });
    // Floors whose plan was read on upload reuse it; the rest are read now and stored.
    const plans = await buildPlans(dir, {
      id: property.id,
      title: property.title,
      plansDir: property.plansDir,
      onProgress: (p) => void writeJobProgress(supabase, jobId, p),
    });
    await saveNewPlans(supabase, property, plans);
    return { plans, files: property.manifest.photos.map((p) => p.file), title: property.title };
  } finally {
    removeWorkdir(dir);
  }
}

async function placeBatch(propertyId: string, title: string, plans: FloorPlan[], files: string[]) {
  "use step";
  const dir = workdir();
  try {
    await exportProperty(adminClient(), propertyId, dir, { photos: files });
    const prep = await prepareBuild(dir, plans);
    const r = await placePhotos(dir, prep, files, { id: propertyId, title, concurrency: BATCH });
    return { placements: r.placements, lastError: r.lastError };
  } finally {
    removeWorkdir(dir);
  }
}

async function assemble(jobId: string, propertyId: string, title: string, plans: FloorPlan[], placements: Placements) {
  "use step";
  const supabase = adminClient();
  const dir = workdir();
  try {
    const property = await exportProperty(supabase, propertyId, dir);
    const prep = await prepareBuild(dir, plans);
    let last = 0;
    const result = await assembleTour(dir, prep, plans, placements, {
      id: property.id,
      title,
      onProgress: (p) => {
        if (Date.now() - last < 1000) return;
        last = Date.now();
        void writeJobProgress(supabase, jobId, p);
      },
    });
    const { version, folder } = await storeTour(supabase, { property, jobId, tour: result.tour, plans });
    return {
      version,
      folder,
      tour: { ...result.tour, mediaRoot: "" } as Tour,
      rooms: sceneRooms(result.tour),
      furnish: process.env.TOUR_FURNISH !== "0",
    };
  } finally {
    removeWorkdir(dir);
  }
}

async function furnishRoom(propertyId: string, tour: Tour, plans: FloorPlan[], room: string): Promise<RoomScene | null> {
  "use step";
  const [levelId, roomId] = room.split("/");
  const plan = plans.find((p) => p.id === tour.levels.find((l) => l.id === levelId)?.planId);
  if (!plan) return null;
  const dir = workdir();
  try {
    const photos = scenePhotos(tour, levelId, roomId).map((p) => p.src);
    await exportProperty(adminClient(), propertyId, dir, { photos, floorplans: false });
    const { scene } = await buildRoomScene({
      tour: { ...tour, mediaRoot: dir },
      plan,
      levelId,
      roomId,
      workDir: path.join(dir, "work"),
      // One check round keeps a room well inside a function invocation.
      rounds: 1,
    });
    return scene.items.some((i) => i.source === "photos") ? scene : null;
  } finally {
    removeWorkdir(dir);
  }
}

async function saveScenes(folder: string, scenes: RoomScene[]) {
  "use step";
  if (!scenes.length) return;
  await storeScenes(adminClient(), folder, scenes);
}
