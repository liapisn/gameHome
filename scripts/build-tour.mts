/**
 * Build a walkable photo tour for a listing: floor plans + photos → src/data/tours/<id>.json
 *
 *   npm run build:tour -- fixtures/listing-15970 --id listing-15970 --title "Marousi house"
 *     --from-cache     reuse cached photo placements (no model calls for photos already placed)
 *     --only 01,04     place only these photos (others keep their cached placement)
 *     --concurrency 4  parallel model calls
 *
 * The listing folder needs manifest.json with `levels[]` (id, name, floorplan) and `photos[]` (file).
 * Ground-truth labels in the manifest (level/room) are never sent to the model; they are only used
 * to score the result at the end.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { activeProvider } from "../src/lib/ai/structured";
import { type FloorPlan, type Point, type RoomType, polygonCentroid } from "../src/lib/floorplan";
import { parseFloorPlanImage } from "../src/lib/floorplan-parser/parse";
import { buildFloorPlan } from "../src/lib/floorplan-parser/build";
import { type Placement, placePhoto, prepareLevels } from "../src/lib/tour/place-photo";
import { solvePose } from "../src/lib/tour/solve-pose";
import { type Tour, type TourLevel, type TourPhoto, roomKey } from "../src/lib/tour/types";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: "string" },
    title: { type: "string" },
    "from-cache": { type: "boolean", default: false },
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

interface Manifest {
  levels: { id: string; name: string; floorplan: string | null; note?: string }[];
  photos: { file: string; level?: string; room?: string }[];
}
const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(listingDir, "manifest.json"), "utf8"));

const PLANS_DIR = path.resolve("src/data/plans");
const TOURS_DIR = path.resolve("src/data/tours");
const DERIVED = path.join(listingDir, ".derived");
fs.mkdirSync(TOURS_DIR, { recursive: true });

// --------------------------------------------------------------------------- media

/** Resized copies: `model` is what the vision model sees, `view` is the tour texture, `thumb` the sidebar. */
const SIZES = { model: 1600, view: 2048, thumb: 480 } as const;

async function derive(file: string) {
  const src = path.join(listingDir, file);
  const out: Record<keyof typeof SIZES, string> = { model: "", view: "", thumb: "" };
  for (const [kind, size] of Object.entries(SIZES) as [keyof typeof SIZES, number][]) {
    const dest = path.join(DERIVED, kind, file);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await sharp(src).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(dest);
    }
    out[kind] = dest;
  }
  const meta = await sharp(src).rotate().metadata();
  return { ...out, width: meta.autoOrient?.width ?? meta.width!, height: meta.autoOrient?.height ?? meta.height! };
}

// --------------------------------------------------------------------------- plans

async function ensurePlan(level: Manifest["levels"][number]): Promise<FloorPlan> {
  const planId = `${tourId}-${level.id}`;
  const planPath = path.join(PLANS_DIR, `${planId}.json`);
  if (fs.existsSync(planPath)) return JSON.parse(fs.readFileSync(planPath, "utf8"));

  console.log(`Parsing ${level.floorplan} (${level.name})…`);
  const image = path.join(listingDir, level.floorplan!);
  const result = await parseFloorPlanImage({
    imageBase64: fs.readFileSync(image).toString("base64"),
    mediaType: "image/jpeg",
    hint: `${level.name} of "${values.title}".`,
  });
  const parsedAt = new Date().toISOString();
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PLANS_DIR, `${planId}.raw.json`),
    JSON.stringify({ parsed: result.parsed, model: result.model, parsedAt }, null, 2) + "\n",
  );
  const { plan } = buildFloorPlan(result.parsed, {
    id: planId,
    title: `${values.title} · ${level.name}`,
    source: { kind: "parsed", image: path.relative(process.cwd(), image), model: result.model, parsedAt },
  });
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
  return plan;
}

/**
 * Stack levels in manifest order. Each plan has its own drawing origin, so align consecutive
 * levels on their stair wells when both have one; otherwise leave them unshifted.
 */
function stackLevels(levels: { id: string; name: string; plan: FloorPlan }[]): TourLevel[] {
  const stairs = (plan: FloorPlan): Point | null => {
    const room = plan.rooms.find((r) => r.type === "stairs");
    return room ? polygonCentroid(room.polygon) : null;
  };
  const out: TourLevel[] = [];
  let elevation = 0;
  let offset: Point = [0, 0];
  levels.forEach((level, i) => {
    if (i > 0) {
      const prev = levels[i - 1];
      elevation += prev.plan.ceilingHeight + 0.3; // slab
      const a = stairs(prev.plan);
      const b = stairs(level.plan);
      if (a && b) offset = [offset[0] + a[0] - b[0], offset[1] + a[1] - b[1]];
    }
    out.push({ id: level.id, name: level.name, planId: level.plan.id, elevation, offset });
  });
  return out;
}

// --------------------------------------------------------------------------- run

const mappedLevels = manifest.levels.filter((l) => l.floorplan);
const plans = await Promise.all(mappedLevels.map(ensurePlan));
const levelInputs = await Promise.all(
  mappedLevels.map(async (l, i) => ({
    id: l.id,
    name: l.name,
    plan: plans[i],
    drawing: (await sharp(path.join(listingDir, l.floorplan!)).resize(2048, 2048, { fit: "inside" }).jpeg({ quality: 90 }).toBuffer()).toString("base64"),
  })),
);
// Listing-level context only (never the per-photo labels).
const otherAreas = manifest.levels.filter((l) => !l.floorplan).map((l) => (l.note ? `${l.name}: ${l.note}` : l.name));
const prepared = prepareLevels(levelInputs, otherAreas);

const cachePath = path.join(TOURS_DIR, `${tourId}.placements.json`);
type CacheEntry = { placement: Placement; model: string; at: string };
const cache: Record<string, CacheEntry> = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};
const only = values.only?.split(",").map((s) => s.trim().padStart(2, "0"));

const photos = manifest.photos;
const media = new Map<string, Awaited<ReturnType<typeof derive>>>();
for (const p of photos) media.set(p.file, await derive(p.file));

const todo = photos.filter((p) => {
  const id = path.parse(p.file).name;
  if (only) return only.includes(id);
  return !(values["from-cache"] && cache[p.file]);
});

console.log(`Placing ${todo.length} of ${photos.length} photos with ${activeProvider()}…`);
let done = 0;
let tokensIn = 0;
let tokensOut = 0;
const queue = [...todo];
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        const res = await placePhoto(prepared, {
          name: path.basename(p.file),
          base64: fs.readFileSync(media.get(p.file)!.model).toString("base64"),
        });
        cache[p.file] = { placement: res.data, model: res.model, at: new Date().toISOString() };
        tokensIn += res.usage.input;
        tokensOut += res.usage.output;
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n"); // checkpoint
        console.log(`  [${++done}/${todo.length}] ${p.file} → ${res.data.levelId}/${res.data.roomId ?? "-"} (${res.data.confidence})`);
      } catch (err) {
        console.error(`  [${++done}/${todo.length}] ${p.file} FAILED: ${(err as Error).message}`);
      }
    }
  }),
);
if (todo.length) console.log(`Tokens: ${tokensIn} in / ${tokensOut} out`);

// --------------------------------------------------------------------------- assemble

const levels = stackLevels(levelInputs);
const tourPhotos: TourPhoto[] = [];
const looks: Tour["looks"] = {};
const models = new Set<string>();

for (const p of photos) {
  const entry = cache[p.file];
  const m = media.get(p.file)!;
  const id = path.parse(p.file).name;
  const base = { id, src: p.file, width: m.width, height: m.height };
  if (!entry) {
    tourPhotos.push({ ...base, caption: "", levelId: null, roomId: null, location: "unplaced", confidence: "low", pose: null, fit: null });
    continue;
  }
  models.add(entry.model);
  const pl = entry.placement;
  const level = levelInputs.find((l) => l.id === pl.levelId);
  const room = level?.plan.rooms.find((r) => r.id === pl.roomId);

  let pose: TourPhoto["pose"] = null;
  let fit: TourPhoto["fit"] = null;
  let confidence = pl.confidence;
  if (level && pl.estimate) {
    const features = prepared.features.get(level.id)!;
    const landmarks = pl.landmarks
      .filter((lm) => features.has(lm.featureId) && lm.u >= 0 && lm.u <= 1)
      .map((lm) => ({ point: features.get(lm.featureId)!.point, u: lm.u, v: lm.v != null && lm.v > 0.5 && lm.v <= 1 ? lm.v : null }));
    const initial = {
      x: pl.estimate.x,
      y: pl.estimate.y,
      yaw: pl.estimate.yawDeg,
      hfov: pl.estimate.hfovDeg,
      height: pl.estimate.cameraHeight,
    };
    const spread = landmarks.length ? Math.max(...landmarks.map((l) => l.u)) - Math.min(...landmarks.map((l) => l.u)) : 0;
    let solved = false;
    if (landmarks.length >= 3 && spread >= 0.2) {
      const s = solvePose(landmarks, initial, {
        polygon: room?.polygon,
        aspect: m.height / m.width,
        prior: { pos: 1.5, yaw: 25, hfov: 12, height: 0.15 },
        hfovRange: [55, 115],
      });
      // Reject fits that only "work" by leaving the room's plausible envelope.
      const moved = Math.hypot(s.x - initial.x, s.y - initial.y);
      if (s.rmsDeg <= 4 && moved <= 2.5 && s.height >= 0.9 && s.height <= 1.8) {
        pose = { x: s.x, y: s.y, yaw: s.yaw, pitch: 0, hfov: s.hfov, height: s.height };
        fit = { method: "resection", landmarks: landmarks.length, rmsDeg: +s.rmsDeg.toFixed(2) };
        if (s.rmsDeg > 2.5) confidence = "low";
        solved = true;
      }
    }
    if (!solved) {
      pose = { ...initial, pitch: 0 };
      fit = { method: "model-estimate", landmarks: landmarks.length, rmsDeg: null };
      confidence = "low";
    }
    const r = (n: number, d = 2) => +n.toFixed(d);
    pose = pose && { x: r(pose.x), y: r(pose.y), yaw: r(pose.yaw, 1), pitch: 0, hfov: r(pose.hfov, 1), height: r(pose.height) };
  }
  if (level && room) {
    const k = roomKey(level.id, room.id);
    if (!looks[k] || pl.confidence === "high") looks[k] = pl.look;
  }
  tourPhotos.push({
    ...base,
    caption: pl.caption,
    levelId: level ? level.id : null,
    roomId: room ? room.id : null,
    location: pl.location,
    confidence,
    pose,
    fit,
  });
}

const tour: Tour = {
  id: tourId,
  title: values.title,
  mediaRoot: path.relative(process.cwd(), listingDir),
  levels,
  photos: tourPhotos,
  looks,
  builtAt: new Date().toISOString(),
  model: [...models].join(", "),
};
const tourPath = path.join(TOURS_DIR, `${tourId}.json`);
fs.writeFileSync(tourPath, JSON.stringify(tour, null, 2) + "\n");

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
console.log(`Levels: ${levels.map((l) => `${l.id} @ ${l.elevation.toFixed(1)} m, offset (${l.offset.map((n) => n.toFixed(2)).join(", ")})`).join(" · ")}`);
console.log(`Posed ${placed.length}/${tourPhotos.length} photos (${placed.filter((p) => p.confidence !== "low").length} high/medium)`);
console.log(`vs manifest: level ${levelOk}/${manifest.photos.length} · room type ${typeOk}/${typeTotal}`);
if (misses.length) console.log(`Mismatches:\n  ${misses.join("\n  ")}`);
