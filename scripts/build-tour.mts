/**
 * Build a walkable photo tour for a listing: floor plans + photos → src/data/tours/<id>.json
 *
 *   npm run build:tour -- fixtures/listing-15970 --id listing-15970 --title "Marousi house"
 *     --from-cache     reuse cached photo placements (no model calls for photos already placed)
 *     --only 01,04     place only these photos (others keep their cached placement)
 *     --concurrency 4  parallel model calls
 *     --owner-floor    treat the manifest's `level` labels as the owner's floor assignment (hint +
 *                      hard bound on placement); without it the build is blind to them
 *
 * The listing folder needs manifest.json with `levels[]` (id, name, floorplan) and `photos[]` (file).
 * Ground-truth labels in the manifest (level/room) are never sent to the model; they are only used
 * to score the result at the end.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { activeProvider } from "../src/lib/ai/structured";
import type { RoomType } from "../src/lib/floorplan";
import { type Manifest, buildTour } from "../src/lib/engine/build-tour";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: "string" },
    title: { type: "string" },
    "from-cache": { type: "boolean", default: false },
    "owner-floor": { type: "boolean", default: false },
    only: { type: "string" },
    concurrency: { type: "string", default: "4" },
  },
});

const listingDir = positionals[0];
if (!listingDir || !values.id || !values.title) {
  console.error('Usage: build-tour.mts <listing-dir> --id <tour-id> --title "<title>" [--from-cache] [--only 01,02]');
  process.exit(1);
}
const tourId = values.id;

const PLANS_DIR = path.resolve("src/data/plans");
const TOURS_DIR = path.resolve("src/data/tours");
fs.mkdirSync(TOURS_DIR, { recursive: true });

// Fixture manifests also carry ground-truth labels (level/room per photo), used only for scoring below.
const manifest: Manifest & { photos: { file: string; level?: string; room?: string }[] } = JSON.parse(
  fs.readFileSync(path.join(listingDir, "manifest.json"), "utf8"),
);

console.log(`Building ${tourId} with ${activeProvider()}…`);
const { tour, plans, poseLog, usage } = await buildTour(listingDir, {
  id: tourId,
  title: values.title,
  log: (m) => console.log(m),
  plansDir: PLANS_DIR,
  placementsCache: path.join(TOURS_DIR, `${tourId}.placements.json`),
  reusePlacements: values["from-cache"],
  ignoreOwnerNotes: !values["owner-floor"],
  only: values.only?.split(",").map((s) => s.trim().padStart(2, "0")),
  concurrency: Number(values.concurrency),
});
if (usage.input) console.log(`Tokens: ${usage.input} in / ${usage.output} out`);

// The dev viewer resolves media relative to the repo.
tour.mediaRoot = path.relative(process.cwd(), listingDir);
const { levels, photos: tourPhotos } = tour;
const tourPath = path.join(TOURS_DIR, `${tourId}.json`);
fs.writeFileSync(tourPath, JSON.stringify(tour, null, 2) + "\n");
const mappedLevels = manifest.levels.filter((l) => l.floorplan);
const levelInputs = mappedLevels.map((l, i) => ({ id: l.id, plan: plans[i] }));

// --------------------------------------------------------------------------- score against manifest labels

const TYPE_WORDS: [RegExp, RoomType][] = [
  [/living/i, "living"],
  [/dining/i, "dining"],
  [/kitchen/i, "kitchen"],
  [/bed/i, "bedroom"],
  [/bath|shower|wc/i, "bathroom"],
  [/hall|entry|corridor/i, "hallway"],
  [/office|study/i, "office"],
  [/balcon|terrace|veranda/i, "balcony"],
  [/stor|closet/i, "storage"],
  [/stair/i, "stairs"],
];
const typeOf = (label: string) => TYPE_WORDS.find(([re]) => re.test(label))?.[1] ?? null;
const mappedIds = new Set(mappedLevels.map((l) => l.id));

let levelOk = 0;
let typeOk = 0;
let typeTotal = 0;
const misses: string[] = [];
for (const p of manifest.photos) {
  const t = tourPhotos.find((x) => x.src === p.file)!;
  if (!p.level) continue;
  const truthLevel = mappedIds.has(p.level) ? p.level : null;
  if (truthLevel === t.levelId) levelOk++;
  else misses.push(`${p.file}: level ${t.levelId ?? "none"} ≠ ${truthLevel ?? `none (${p.level})`}`);
  if (truthLevel && truthLevel === t.levelId && p.room) {
    typeTotal++;
    const plan = levelInputs.find((l) => l.id === t.levelId)!.plan;
    const predicted = plan.rooms.find((r) => r.id === t.roomId);
    const want = typeOf(p.room);
    const ok = predicted && (predicted.type === want || (want === "living" && predicted.type === "dining") || (want === "dining" && predicted.type === "living"));
    if (ok) typeOk++;
    else misses.push(`${p.file}: room ${predicted?.name ?? "none"} ≠ ${p.room}`);
  }
}

const placed = tourPhotos.filter((p) => p.pose);
console.log(`\n→ ${tourPath}`);
console.log(
  `Levels: ${levels.map((l) => `${l.id} @ ${l.elevation.toFixed(1)} m, offset (${l.offset.map((n) => n.toFixed(2)).join(", ")}), ceiling ${l.ceilingHeight ?? "plan default"}`).join(" · ")}`,
);
console.log(`Posed ${placed.length}/${tourPhotos.length} photos (${placed.filter((p) => p.confidence !== "low").length} high/medium)`);
const methods = new Map<string, number>();
for (const p of placed) methods.set(p.fit!.method, (methods.get(p.fit!.method) ?? 0) + 1);
console.log(`Pose methods: ${[...methods].map(([k, n]) => `${k} ${n}`).join(" · ")}`);
if (process.env.POSE_LOG) console.log(poseLog.join("\n"));
console.log(`vs manifest: level ${levelOk}/${manifest.photos.length} · room type ${typeOk}/${typeTotal}`);
if (misses.length) console.log(`Mismatches:\n  ${misses.join("\n  ")}`);
