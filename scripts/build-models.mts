/**
 * Generated 3D models for a tour's furnished rooms (docs/agent-tree-plan.md).
 *
 *   npm run build:models -- --tour listing-8218                       # every furnished room + house.glb
 *   npm run build:models -- --tour listing-8218 --room main/r2        # one room
 *   npm run build:models -- --tour listing-8218 --room main/r2 --item sofa-1   # one object only
 *   npm run build:models -- --property <uuid>      # a tour built in the app: download, build, upload
 *   npm run build:models -- --property <uuid> --rescene   # … rebuilding its room scenes first (3 check
 *     rounds, DETECT_VOTES detect calls per photo) and uploading them with the models
 *   … --property <uuid> --no-upload       # build locally only: nothing is written back to the app
 *     (needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, e.g. --env-file=.env.production.local)
 *
 * Needs GEMINI_API_KEY and BOXD_API_KEY in .env.local (Blender runs on boxd, never here). Reads
 * the room scenes from src/data/scenes/<tour>/ (npm run build:scene). Output: exports/<tour>/models/.
 * Every model call and Blender run is cached there: a rerun only repeats what isn't done.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { briefForItem, itemViews, loadDetections } from "../src/lib/models3d/briefs";
import { runHouseWorker } from "../src/lib/models3d/house-worker";
import { runObjectWorker } from "../src/lib/models3d/object-worker";
import { downloadAppTour, uploadModels } from "../src/lib/models3d/app-tour";
import { runRoomWorker } from "../src/lib/models3d/room-worker";
import { closePool } from "../src/lib/boxd/runner";
import { adminClient, storeScenes } from "../src/lib/admin/jobs";
import { buildRoomScene } from "../src/lib/engine/build-scene";
import { blenderJob, slug } from "../src/lib/models3d/util";
import type { RoomScene } from "../src/lib/scene/types";
import type { Tour } from "../src/lib/tour/types";

const { values } = parseArgs({
  options: {
    tour: { type: "string" },
    property: { type: "string" },
    room: { type: "string" },
    item: { type: "string" },
    rescene: { type: "boolean", default: false },
    "no-upload": { type: "boolean", default: false },
    rounds: { type: "string", default: "3" },
  },
});
if (!values.tour && !values.property) {
  console.error("Usage: build-models.mts (--tour <id> [--room <level>/<room> [--item <id>]] | --property <uuid> [--rescene [--rounds 3]])");
  process.exit(1);
}
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const t0 = Date.now();

if (values.property) {
  // A tour built in the app: its current version from Storage, models back beside it.
  // --no-upload is a local test: a fresh folder, never one an earlier build wrote.
  const dir = path.resolve("exports", values["no-upload"] ? `app-${values.property}-local` : `app-${values.property}`);
  if (values["no-upload"] && fs.existsSync(dir)) {
    console.error(`${path.relative(process.cwd(), dir)} already exists: move it aside first (--no-upload never overwrites an earlier build).`);
    process.exit(1);
  }
  const app = await downloadAppTour(values.property, dir, { allPhotos: values.rescene });
  log(`app tour v${app.version}: ${app.scenes.length} furnished room(s), photos in ${path.relative(process.cwd(), dir)}`);
  const outRoot = path.join(dir, "models");
  const sceneRoot = path.join(dir, "scenes");
  if (values.rescene) {
    // The app built these scenes on Vercel with one check round and one detect call per photo:
    // rebuild them here with the time Vercel doesn't have, rooms in parallel.
    const rebuilt = await Promise.all(
      app.scenes.map(async (old) => {
        const key = `${old.levelId}/${old.roomId}`;
        const plan = app.plans.find((p) => p.id === app.tour.levels.find((l) => l.id === old.levelId)?.planId);
        if (!plan) return old;
        try {
          const { scene } = await buildRoomScene({
            tour: app.tour,
            plan,
            levelId: old.levelId,
            roomId: old.roomId,
            workDir: path.join(sceneRoot, `${old.levelId}-${old.roomId}`),
            rounds: Number(values.rounds),
            log: (m) => log(`[${key}] ${m.trim()}`),
          });
          if (!scene.items.some((i) => i.source === "photos")) {
            log(`[${key}] rescene found nothing from photos; keeping the app's scene`);
            return old;
          }
          log(`[${key}] rescene: score ${old.score} → ${scene.score}, ${scene.items.length} item(s)`);
          return scene;
        } catch (err) {
          log(`[${key}] rescene failed, keeping the app's scene — ${(err as Error).message.slice(0, 200)}`);
          return old;
        }
      }),
    );
    app.scenes = rebuilt;
    fs.writeFileSync(path.join(sceneRoot, "scenes.json"), JSON.stringify(rebuilt, null, 2));
    if (values["no-upload"]) log(`rescene: ${rebuilt.length} scene(s) kept locally (${path.relative(process.cwd(), sceneRoot)}/scenes.json), --no-upload`);
    else {
      await storeScenes(adminClient(), app.folder, rebuilt);
      log(`rescene: ${rebuilt.length} scene(s) stored beside the tour (${app.folder}scenes.json)`);
    }
  }
  const r = await runHouseWorker({ tour: app.tour, outRoot, log, scenes: app.scenes, plans: app.plans, sceneRoot: values.rescene ? sceneRoot : undefined });
  log(`house: ${r.summary}`);
  const house = JSON.parse(fs.readFileSync(r.house, "utf8")) as { rooms: { room: string; error: string | null }[] };
  const rooms: { levelId: string; roomId: string; glb: string }[] = [];
  for (const room of house.rooms.filter((x) => !x.error)) {
    const [levelId, roomId] = room.room.split("/");
    const full = path.join(outRoot, "rooms", `${levelId}-${roomId}`, "room.glb");
    if (!fs.existsSync(full)) continue;
    const web = full.replace(/room\.glb$/, "room-web.glb");
    await blenderJob("web_copy.py", full.replace(/room\.glb$/, "web-job.json"), { glb: full, out: web, maxTris: 60000, maxTex: 1024 });
    log(`web copy ${room.room}: ${(fs.statSync(full).size / 1e6).toFixed(1)} MB → ${(fs.statSync(web).size / 1e6).toFixed(1)} MB`);
    rooms.push({ levelId, roomId, glb: web });
  }
  // The house model, web-sized like the rooms, for the 3D model page.
  const houseFull = path.join(outRoot, "house.glb");
  let houseWeb: string | undefined;
  if (fs.existsSync(houseFull)) {
    houseWeb = path.join(outRoot, "house-web.glb");
    await blenderJob("web_copy.py", path.join(outRoot, "house-web-job.json"), { glb: houseFull, out: houseWeb, maxTris: 250000, maxTex: 1024 });
    log(`web copy house: ${(fs.statSync(houseFull).size / 1e6).toFixed(1)} MB → ${(fs.statSync(houseWeb).size / 1e6).toFixed(1)} MB`);
  }
  if (values["no-upload"]) {
    log(`--no-upload: ${rooms.length} room model(s)${houseWeb ? " and the house model" : ""} left in ${path.relative(process.cwd(), outRoot)}`);
    log(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    await closePool();
    process.exit(0);
  }
  const index = await uploadModels(app.folder, rooms, houseWeb);
  log(`uploaded ${index.rooms.length} room model(s)${index.house ? " and the house model" : ""} beside the tour (${app.folder}models.json)`);
  log(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  await closePool();
  process.exit(0);
}

const tour: Tour = JSON.parse(fs.readFileSync(`src/data/tours/${values.tour}.json`, "utf8"));
const outRoot = path.resolve("exports", tour.id, "models");

if (values.item) {
  if (!values.room) throw new Error("--item needs --room");
  const [levelId, roomId] = values.room.split("/");
  const scene: RoomScene = JSON.parse(fs.readFileSync(`src/data/scenes/${tour.id}/${levelId}-${roomId}.json`, "utf8"));
  const item = scene.items.find((i) => i.id === values.item);
  if (!item) throw new Error(`No item ${values.item} in ${values.room}: ${scene.items.map((i) => i.id).join(", ")}`);
  // Same model id as the room worker gives it, so a later room run reuses this model.
  const brief = briefForItem(tour, item, itemViews(item, loadDetections(tour.id, levelId, roomId)), path.join(outRoot, "objects"), `${levelId}-${roomId}-${slug(item.id)}`);
  log(`object ${brief.assetId}: "${brief.label}", ${brief.views.length} view(s), target ${brief.size.w.toFixed(2)}×${brief.size.d.toFixed(2)}×${brief.size.h.toFixed(2)} m`);
  const r = await runObjectWorker(brief, log);
  log(`${r.status}: ${r.reason}${r.glb ? ` → ${path.relative(process.cwd(), r.glb)}` : ""}`);
} else if (values.room) {
  const [levelId, roomId] = values.room.split("/");
  const r = await runRoomWorker({ tour, levelId, roomId, outRoot, log });
  log(`room ${values.room}: ${r.summary}`);
  await webCopies([`${levelId}-${roomId}`]);
} else {
  const r = await runHouseWorker({ tour, outRoot, log });
  log(`house: ${r.summary}`);
  const roomsDir = path.join(outRoot, "rooms");
  await webCopies(fs.existsSync(roomsDir) ? fs.readdirSync(roomsDir) : []);
}

/** Web-sized room models, which the local tour page shows (/api/tour-models, dev only). */
async function webCopies(keys: string[]) {
  await Promise.all(
    keys.map(async (key) => {
      const full = path.join(outRoot, "rooms", key, "room.glb");
      if (!fs.existsSync(full)) return;
      const web = full.replace(/room\.glb$/, "room-web.glb");
      await blenderJob("web_copy.py", full.replace(/room\.glb$/, "web-job.json"), { glb: full, out: web, maxTris: 60000, maxTex: 1024 });
      log(`web copy ${key}: ${(fs.statSync(full).size / 1e6).toFixed(1)} MB → ${(fs.statSync(web).size / 1e6).toFixed(1)} MB`);
    }),
  );
}
log(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
await closePool();
