/**
 * The tour engine as a library: a listing folder in → a Tour plus its floor plans out.
 *
 *   <folder>/manifest.json   { levels: [{ id, name, floorplan, note? }], photos: [{ file, hint?, level? }] }
 *   <folder>/floorplans/…    one drawing per level that has a plan
 *   <folder>/photos/…        photos (JPEG/PNG/WebP), in display order
 *
 * Used by the `build:tour` CLI (fixtures, with plan + placement caches) and by the admin worker
 * (owner uploads, no caches). `hint` and `level` are owner notes passed to the model as context;
 * nothing else in the manifest is sent (fixtures keep ground-truth labels there for scoring).
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { type FloorPlan, type Point, polygonCentroid } from "@/lib/floorplan";
import { parseFloorPlanImage } from "@/lib/floorplan-parser/parse";
import { buildFloorPlan } from "@/lib/floorplan-parser/build";
import { estimatePose } from "@/lib/tour/estimate-pose";
import { type Placement, placePhoto, prepareLevels } from "@/lib/tour/place-photo";
import { type Tour, type TourLevel, type TourPhoto, roomKey } from "@/lib/tour/types";

export interface ManifestLevel {
  id: string;
  name: string;
  floorplan: string | null;
  /** What's there, for levels without a plan ("second unit, 2 bedrooms…"). */
  note?: string;
}

export interface ManifestPhoto {
  file: string;
  /** Owner's free-text note, e.g. "kitchen" or "view from the balcony". */
  hint?: string;
  /** Owner's floor assignment: a level id from the manifest. */
  level?: string;
}

export interface Manifest {
  levels: ManifestLevel[];
  photos: ManifestPhoto[];
}

export interface BuildProgress {
  step: "plans" | "photos" | "poses" | "furnish" | "done";
  label: string;
  done: number;
  total: number;
}

export interface BuildTourOptions {
  id: string;
  title: string;
  onProgress?: (p: BuildProgress) => void;
  log?: (message: string) => void;
  /** Cache parsed plans here as <id>-<level>.json (+ .raw.json); without it every run re-parses. */
  plansDir?: string;
  /** JSON file caching photo placements between runs. */
  placementsCache?: string;
  /** Reuse cached placements instead of calling the model again. */
  reusePlacements?: boolean;
  /** Re-place only these photo ids (file name without extension), keeping the rest cached. */
  only?: string[];
  concurrency?: number;
}

export interface BuildTourResult {
  tour: Tour;
  plans: FloorPlan[];
  /** One line per posed photo: method and fit quality. */
  poseLog: string[];
  usage: { input: number; output: number };
}

type CacheEntry = { placement: Placement; model: string; at: string };

/** Resized copies: `model` is what the vision model sees, `view` the dev texture, `thumb` the sidebar. */
const SIZES = { model: 1600, view: 2048, thumb: 480 } as const;

export async function buildTour(folder: string, opts: BuildTourOptions): Promise<BuildTourResult> {
  const log = opts.log ?? (() => {});
  const progress = opts.onProgress ?? (() => {});
  const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
  const derivedDir = path.join(folder, ".derived");

  // ------------------------------------------------------------------ plans
  const mapped = manifest.levels.filter((l) => l.floorplan);
  if (!mapped.length) throw new Error("At least one floor needs a floor plan.");
  let plansDone = 0;
  progress({ step: "plans", label: "Reading floor plans", done: 0, total: mapped.length });

  const ensurePlan = async (level: ManifestLevel): Promise<FloorPlan> => {
    const planId = `${opts.id}-${level.id}`;
    const cached = opts.plansDir && path.join(opts.plansDir, `${planId}.json`);
    if (cached && fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, "utf8"));

    log(`Parsing ${level.floorplan} (${level.name})…`);
    const image = path.join(folder, level.floorplan!);
    const jpeg = await sharp(image).rotate().jpeg({ quality: 92 }).toBuffer();
    const result = await parseFloorPlanImage({
      imageBase64: jpeg.toString("base64"),
      mediaType: "image/jpeg",
      hint: `${level.name} of "${opts.title}".`,
    });
    const parsedAt = new Date().toISOString();
    const { plan } = buildFloorPlan(result.parsed, {
      id: planId,
      title: `${opts.title} · ${level.name}`,
      source: { kind: "parsed", image: path.basename(image), model: result.model, parsedAt },
    });
    if (opts.plansDir) {
      fs.mkdirSync(opts.plansDir, { recursive: true });
      fs.writeFileSync(
        path.join(opts.plansDir, `${planId}.raw.json`),
        JSON.stringify({ parsed: result.parsed, model: result.model, parsedAt }, null, 2) + "\n",
      );
      fs.writeFileSync(cached!, JSON.stringify(plan, null, 2) + "\n");
    }
    return plan;
  };

  const plans = await Promise.all(
    mapped.map(async (l) => {
      const plan = await ensurePlan(l);
      progress({ step: "plans", label: "Reading floor plans", done: ++plansDone, total: mapped.length });
      return plan;
    }),
  );
  const levelInputs = await Promise.all(
    mapped.map(async (l, i) => ({
      id: l.id,
      name: l.name,
      plan: plans[i],
      drawing: (
        await sharp(path.join(folder, l.floorplan!)).resize(2048, 2048, { fit: "inside" }).jpeg({ quality: 90 }).toBuffer()
      ).toString("base64"),
    })),
  );
  // Listing-level context only: areas that exist but have no plan.
  const otherAreas = manifest.levels.filter((l) => !l.floorplan).map((l) => (l.note ? `${l.name}: ${l.note}` : l.name));
  const prepared = prepareLevels(levelInputs, otherAreas);

  // ------------------------------------------------------------------ media
  const derive = async (file: string) => {
    const src = path.join(folder, file);
    const out: Record<keyof typeof SIZES, string> = { model: "", view: "", thumb: "" };
    for (const [kind, size] of Object.entries(SIZES) as [keyof typeof SIZES, number][]) {
      const dest = path.join(derivedDir, kind, file);
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await sharp(src).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(dest);
      }
      out[kind] = dest;
    }
    const meta = await sharp(src).rotate().metadata();
    return { ...out, width: meta.autoOrient?.width ?? meta.width!, height: meta.autoOrient?.height ?? meta.height! };
  };
  const media = new Map<string, Awaited<ReturnType<typeof derive>>>();
  for (const p of manifest.photos) media.set(p.file, await derive(p.file));

  // ------------------------------------------------------------------ placement
  const cache: Record<string, CacheEntry> =
    opts.placementsCache && fs.existsSync(opts.placementsCache) ? JSON.parse(fs.readFileSync(opts.placementsCache, "utf8")) : {};
  const idOf = (file: string) => path.parse(file).name;
  const todo = manifest.photos.filter((p) =>
    opts.only ? opts.only.includes(idOf(p.file)) : !(opts.reusePlacements && cache[p.file]),
  );

  const levelName = new Map(manifest.levels.map((l) => [l.id, l.name]));
  const ownerHint = (p: ManifestPhoto) =>
    [
      p.level && levelName.has(p.level) ? `The owner filed this photo under "${levelName.get(p.level)}".` : "",
      p.hint ? `The owner's note: "${p.hint}".` : "",
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  let placed = 0;
  let failures = 0;
  let lastError = "";
  const usage = { input: 0, output: 0 };
  progress({ step: "photos", label: "Placing photos", done: 0, total: todo.length });
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: opts.concurrency ?? 4 }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        try {
          const res = await placePhoto(prepared, {
            name: path.basename(p.file),
            base64: fs.readFileSync(media.get(p.file)!.model).toString("base64"),
            hint: ownerHint(p),
          });
          cache[p.file] = { placement: res.data, model: res.model, at: new Date().toISOString() };
          usage.input += res.usage.input;
          usage.output += res.usage.output;
          if (opts.placementsCache) fs.writeFileSync(opts.placementsCache, JSON.stringify(cache, null, 2) + "\n");
          log(`  ${p.file} → ${res.data.levelId}/${res.data.roomId ?? "-"} (${res.data.confidence})`);
        } catch (err) {
          failures++;
          lastError = (err as Error).message;
          log(`  ${p.file} FAILED: ${lastError}`);
        }
        progress({ step: "photos", label: "Placing photos", done: ++placed, total: todo.length });
      }
    }),
  );
  // A few flaky photos are tolerable; all of them failing means credentials or quota.
  if (todo.length && failures === todo.length) throw new Error(`Every photo failed to place. Last error: ${lastError}`);

  // ------------------------------------------------------------------ poses + assembly
  const levels = stackLevels(levelInputs);
  const tourPhotos: TourPhoto[] = [];
  const poseLog: string[] = [];
  const looks: Tour["looks"] = {};
  const models = new Set<string>();
  let posed = 0;

  for (const p of manifest.photos) {
    progress({ step: "poses", label: "Solving camera positions", done: posed++, total: manifest.photos.length });
    const entry = cache[p.file];
    const m = media.get(p.file)!;
    const base = { id: idOf(p.file), src: p.file, width: m.width, height: m.height };
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
      const { data, info } = await sharp(path.join(folder, p.file)).rotate().resize(1200).grayscale().raw().toBuffer({ resolveWithObject: true });
      const outcome = estimatePose(
        { data: new Uint8Array(data), width: info.width, height: info.height },
        pl,
        level.plan,
        prepared.features.get(level.id)!,
      );
      if (outcome) {
        pose = outcome.pose;
        fit = outcome.fit;
        if (!outcome.precise) confidence = "low";
        const detail =
          fit.rmsDeg != null
            ? `rms ${fit.rmsDeg}° · ${fit.landmarks} lm`
            : fit.score != null
              ? `score ${fit.score} · margin ${fit.margin ?? "n/a"} · ceiling ${fit.ceiling} m`
              : "";
        poseLog.push(`  ${p.file.padEnd(14)} ${fit.method.padEnd(14)} ${detail}`);
      }
    }
    if (level && room) {
      const k = roomKey(level.id, room.id);
      if (!looks[k] || pl.confidence === "high") looks[k] = pl.look;
    }
    tourPhotos.push({ ...base, caption: pl.caption, levelId: level ? level.id : null, roomId: room ? room.id : null, location: pl.location, confidence, pose, fit });
  }

  // Measured ceiling height per level: the median of edge-aligned fits, when there are enough.
  for (const level of levels) {
    const ceilings = tourPhotos
      .filter((p) => p.levelId === level.id && p.fit?.method === "edges" && p.fit.ceiling)
      .map((p) => p.fit!.ceiling!)
      .sort((a, b) => a - b);
    if (ceilings.length >= 3) level.ceilingHeight = +ceilings[Math.floor(ceilings.length / 2)].toFixed(2);
  }
  progress({ step: "done", label: "Done", done: 1, total: 1 });

  return {
    tour: {
      id: opts.id,
      title: opts.title,
      mediaRoot: folder,
      levels,
      photos: tourPhotos,
      looks,
      builtAt: new Date().toISOString(),
      model: [...models].join(", "),
    },
    plans,
    poseLog,
    usage,
  };
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
