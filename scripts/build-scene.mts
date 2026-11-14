/**
 * Furnish rooms from their photos: gate → detect → lift → check loop → src/data/scenes/<tour>/<level>-<room>.json
 *
 *   npm run build:scene -- --tour listing-15970 --room upper/r1
 *   npm run build:scene -- --tour listing-15970 --all
 *     --rounds 3     check-loop rounds (0 = detect + lift only)
 *     --fresh        ignore cached model answers
 *     --concurrency 4  rooms built in parallel
 *     --gate-model   also ask the model to check each photo's placement (see eval-gate.mts)
 *
 * Model answers, overlays and a top-down view go to exports/<tour>/<level>-<room>/ (not in git).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { activeProvider } from "../src/lib/ai/structured";
import type { FloorPlan } from "../src/lib/floorplan";
import { buildRoomScene, scenePhotos, sceneRooms } from "../src/lib/engine/build-scene";
import type { Tour } from "../src/lib/tour/types";

const { values } = parseArgs({
  options: {
    tour: { type: "string" },
    room: { type: "string", multiple: true },
    all: { type: "boolean", default: false },
    rounds: { type: "string", default: "3" },
    fresh: { type: "boolean", default: false },
    "gate-model": { type: "boolean", default: false },
    concurrency: { type: "string", default: "4" },
  },
});
if (!values.tour || (!values.room?.length && !values.all)) {
  console.error("Usage: build-scene.mts --tour <id> (--room <level>/<room> … | --all) [--rounds 3] [--fresh] [--gate-model]");
  process.exit(1);
}

const tour: Tour = JSON.parse(fs.readFileSync(`src/data/tours/${values.tour}.json`, "utf8"));
const plans = new Map(
  tour.levels.map((l) => [l.id, JSON.parse(fs.readFileSync(`src/data/plans/${l.planId}.json`, "utf8")) as FloorPlan]),
);

const rooms = values.all ? sceneRooms(tour) : values.room!;

const outDir = path.resolve("src/data/scenes", tour.id);
fs.mkdirSync(outDir, { recursive: true });
console.log(`Furnishing ${rooms.length} room(s) of ${tour.id} with ${activeProvider()}…`);

let calls = 0;
async function furnish(key: string) {
  const [levelId, roomId] = key.split("/");
  const plan = plans.get(levelId);
  // Rooms run in parallel: prefix every line with the room.
  const say = (m: string) => console.log(`[${key}] ${m.trim()}`);
  if (!plan || !scenePhotos(tour, levelId, roomId).length) {
    say("no posed photos, skipped");
    return;
  }
  const t0 = Date.now();
  const { scene, usage } = await buildRoomScene({
    tour,
    plan,
    levelId,
    roomId,
    workDir: path.resolve("exports", tour.id, `${levelId}-${roomId}`),
    rounds: Number(values.rounds),
    fresh: values.fresh,
    modelGate: values["gate-model"],
    log: say,
  });
  calls += usage;
  const file = path.join(outDir, `${levelId}-${roomId}.json`);
  if (scene.items.some((i) => i.source === "photos")) {
    fs.writeFileSync(file, JSON.stringify(scene, null, 2) + "\n");
    say(`→ ${path.relative(process.cwd(), file)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  } else {
    if (fs.existsSync(file)) fs.rmSync(file);
    say("→ nothing from photos (all photos gated out?), no scene written");
  }
}

const queue = [...rooms];
const t0 = Date.now();
await Promise.all(
  Array.from({ length: Math.max(1, Number(values.concurrency)) }, async () => {
    for (let key = queue.shift(); key; key = queue.shift()) await furnish(key);
  }),
);
console.log(`${calls} model call(s), ${((Date.now() - t0) / 1000).toFixed(0)} s`);

