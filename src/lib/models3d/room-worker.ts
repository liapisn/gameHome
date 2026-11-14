/**
 * Room worker: a furnished room (RoomScene) → its items as generated 3D models, placed where the
 * photos show them and turned to face the way they do. See docs/agent-tree-plan.md.
 *
 *   1. Group items that are copies of one product; one model per group. A dining table also gets
 *      one chair model, placed for every chair.
 *   2. Brief and run every object worker at once.
 *   3. Place each model at its item (positions stay as measured from the photos). Fitted kitchens
 *      and wardrobes stay built to measure; pictures become framed planes with their photo crop;
 *      a model that failed keeps the item's box.
 *   4. Orientation: render the room from each photo's camera with every model turned 0°, 90°,
 *      180°, 270°; per item, the model picks which turn faces the way the photo shows.
 *   5. Render beside every photo, check, export room.glb and room.json.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { buildDollhouseScene } from "@/lib/dollhouse-geometry";
import { type FloorPlan, polygonCentroid } from "@/lib/floorplan";
import { sceneToGlb } from "@/lib/glb";
import { itemBox, pointInPolygon } from "@/lib/scene/lift";
import type { V3 } from "@/lib/scene/project";
import type { RoomScene, SceneItem } from "@/lib/scene/types";
import type { Tour } from "@/lib/tour/types";
import { BUILT_TO_MEASURE, PICTURE, briefForItem, chairBrief, chairPlacements, itemViews, loadDetections } from "./briefs";
import { pickTurn, sameModels } from "./critic";
import { fitFor, runObjectWorker } from "./object-worker";
import { cropViews } from "./reference";
import type { ObjectBrief, ObjectResult } from "./types";
import { blenderJob, cachedJson, pool, slug } from "./util";

/** Object workers in flight at once (each runs two generators). */
const OBJECT_CONCURRENCY = 8;
const RENDER_W = 1024;

export interface RoomRun {
  tour: Tour;
  levelId: string;
  roomId: string;
  outRoot: string;
  log: (m: string) => void;
  /** Object results already made elsewhere (the house worker shares assets across rooms). */
  objectsDir?: string;
  /** The room's scene and plan when they don't come from src/data (a tour downloaded from the app). */
  scene?: RoomScene;
  plan?: FloorPlan;
}

interface Placement {
  id: string;
  label: string;
  kind: string;
  assetId: string;
  x: number;
  y: number;
  z: number;
  rot: number;
  /** Uniform scale from the model's built size to this copy's size. */
  scale: number;
  floor: boolean;
  /** Turn found by the orientation check, degrees. */
  turn: number;
  /** Views of this copy, to judge its orientation. */
  views: SceneItem["views"];
}

export async function runRoomWorker(run: RoomRun): Promise<{ summary: string; roomGlb: string | null; report: string }> {
  const { tour, levelId, roomId, log } = run;
  const say = (m: string) => log(`[${levelId}/${roomId}] ${m}`);
  const key = `${levelId}-${roomId}`;
  const dir = path.join(run.outRoot, "rooms", key);
  const objectsDir = run.objectsDir ?? path.join(run.outRoot, "objects");
  fs.mkdirSync(dir, { recursive: true });

  const scene: RoomScene = run.scene ?? JSON.parse(fs.readFileSync(path.resolve("src/data/scenes", tour.id, `${key}.json`), "utf8"));
  const level = tour.levels.find((l) => l.id === levelId)!;
  const plan: FloorPlan = run.plan ?? JSON.parse(fs.readFileSync(path.resolve("src/data/plans", `${level.planId}.json`), "utf8"));
  const room = plan.rooms.find((r) => r.id === roomId)!;
  const ceiling = level.ceilingHeight ?? plan.ceilingHeight;
  const detections = loadDetections(tour.id, levelId, roomId);
  const gated = new Set(scene.photos.filter((g) => g.gate === "pass").map((g) => g.id));
  const photos = tour.photos.filter((p) => p.levelId === levelId && p.roomId === roomId && p.pose && gated.has(p.id));
  const items = scene.items.map((i) => ({ ...i, views: itemViews(i, detections).filter((v) => gated.has(v.photoId)) }));

  // ------------------------------------------------------------------ 1. what gets a model
  const generated = items.filter((i) => !BUILT_TO_MEASURE.has(i.kind) && !PICTURE.has(i.kind));
  const firstCrops = new Map<string, string | null>();
  for (const i of generated) {
    if (!i.views.length) {
      firstCrops.set(i.id, null);
      continue;
    }
    // One crop per item, enough to tell copies of one product apart.
    const b = briefForItem(tour, i, i.views, path.join(dir, "identity"));
    const [c] = await cropViews({ ...b, views: b.views.slice(0, 1) });
    firstCrops.set(i.id, c ?? null);
  }
  const groups = await cachedJson(path.join(dir, "same-models.json"), () =>
    sameModels(generated.map((i) => ({ id: i.id, label: i.label, kind: String(i.kind), crop: firstCrops.get(i.id) ?? null }))),
  );
  // Copies must be one kind of thing; anything else stays on its own.
  const groupOf = new Map<string, string[]>();
  for (const g of groups) {
    const kinds = new Set(g.map((id) => generated.find((i) => i.id === id)?.kind));
    if (kinds.size === 1) for (const id of g) groupOf.set(id, g);
  }

  const briefs = new Map<string, ObjectBrief>();
  const assetFor = new Map<string, string>();
  for (const i of generated) {
    const group = groupOf.get(i.id) ?? [i.id];
    const lead = group.map((id) => generated.find((x) => x.id === id)!).sort((a, b) => b.views.length - a.views.length)[0];
    const assetId = `${key}-${slug(lead.id)}`;
    assetFor.set(i.id, assetId);
    if (!briefs.has(assetId)) {
      // Every copy's views help: they all show the same product.
      const views = group.flatMap((id) => generated.find((x) => x.id === id)!.views);
      briefs.set(assetId, briefForItem(tour, lead, views, objectsDir, assetId));
    }
  }
  const tables = generated.filter((i) => i.kind === "diningTable" && (i.chairs ?? 0) > 0);
  for (const t of tables) {
    const b = chairBrief(tour, t, t.views, objectsDir);
    b.assetId = `${key}-${slug(t.id)}-chair`;
    b.workDir = path.join(objectsDir, b.assetId);
    briefs.set(b.assetId, b);
  }
  say(`${items.length} item(s): ${briefs.size} model(s) to make for ${generated.length} item(s)${tables.length ? ` + chairs` : ""}, ${items.length - generated.length} built to measure or pictures`);

  // ------------------------------------------------------------------ 2. object workers, all at once
  const results = new Map<string, ObjectResult>();
  await pool([...briefs.values()], OBJECT_CONCURRENCY, async (b) => {
    const r = await runObjectWorker(b, log).catch((err): ObjectResult => ({ assetId: b.assetId, status: "failed", attempts: 0, reason: (err as Error).message }));
    results.set(b.assetId, r);
    say(`model ${b.assetId}: ${r.status} (${r.attempts} attempt(s)) — ${r.reason}`);
  });

  // ------------------------------------------------------------------ 3. placements
  const placements: Placement[] = [];
  for (const i of generated) {
    const r = results.get(assetFor.get(i.id)!);
    if (r?.status !== "ok" || !r.glb || !r.size) continue;
    const b = itemBox(i);
    const fit = fitFor({ w: i.w, d: i.d, h: i.h });
    const scale = fit === "flat" ? Math.max(i.w, i.d) / Math.max(r.size.w, r.size.d, 1e-3) : i.h / Math.max(r.size.h, 1e-3);
    placements.push({ id: i.id, label: i.label, kind: String(i.kind), assetId: r.assetId, x: i.x, y: i.y, z: b.z0, rot: i.rot, scale, floor: b.z0 < 0.02, turn: 0, views: i.views });
  }
  for (const t of tables) {
    const r = results.get(`${key}-${slug(t.id)}-chair`);
    if (r?.status !== "ok" || !r.glb) continue;
    chairPlacements(t).forEach((c, n) =>
      placements.push({ id: `${t.id}-chair-${n + 1}`, label: "dining chair", kind: "generic", assetId: r.assetId, x: c.x, y: c.y, z: 0, rot: c.rot, scale: 1, floor: true, turn: 0, views: [] }),
    );
  }

  // Pictures: the largest crop of each, on a framed plane.
  const pictures = new Map<string, string>();
  for (const i of items.filter((x) => PICTURE.has(x.kind) && x.views.length)) {
    const [crop] = await cropViews({ ...briefForItem(tour, i, i.views, path.join(dir, "pictures")) });
    if (crop) pictures.set(i.id, crop);
  }

  // ------------------------------------------------------------------ Blender job
  const shell = path.join(dir, "shell.glb");
  if (!fs.existsSync(shell)) fs.writeFileSync(shell, await sceneToGlb(buildDollhouseScene({ ...plan, ceilingHeight: ceiling }, { ceilings: true })));
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  const lights: V3[] = [];
  for (let x = Math.min(...xs) + 1.25; x < Math.max(...xs); x += 2.5)
    for (let y = Math.min(...ys) + 1.25; y < Math.max(...ys); y += 2.5) if (pointInPolygon([x, y], room.polygon)) lights.push([x, y, ceiling - 0.35]);
  if (!lights.length) lights.push([...polygonCentroid(room.polygon), ceiling - 0.35]);
  const cameras = photos.map((p) => ({ id: p.id, pose: p.pose!, width: RENDER_W, height: Math.round((RENDER_W * p.height) / p.width) }));

  const jobItems = () => {
    const placed = new Set(placements.map((p) => p.id));
    const out: Record<string, unknown>[] = [];
    for (const p of placements) {
      const r = results.get(p.assetId)!;
      out.push({ id: p.id, label: p.label, kind: p.kind, asset: r.glb, pos: [p.x, p.y, p.z], rot: p.rot + (p.turn * Math.PI) / 180, scale: p.scale, floor: p.floor });
    }
    for (const i of items) {
      if (placed.has(i.id)) continue;
      const b = itemBox(i);
      const box = [b.x0, b.y0, b.x1, b.y1, b.z0, b.z1];
      if (pictures.has(i.id)) out.push({ id: i.id, label: i.label, kind: i.kind, image: pictures.get(i.id), size: [i.w, i.h], box, rot: i.rot });
      else out.push({ id: i.id, label: i.label, kind: i.kind, color: i.color ?? null, material: i.material ?? null, box });
    }
    return out;
  };
  const build = async (tag: string, opts: { turnAll?: number; glb?: boolean }) => {
    const outDir = path.join(dir, tag);
    await blenderJob("build_scene.py", path.join(dir, `job-${tag}.json`), {
      mode: "build",
      shell,
      roomId,
      look: scene.look ?? null,
      items: jobItems(),
      turnAll: opts.turnAll ?? 0,
      roomBox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      cameras,
      probes: [],
      lights,
      outDir,
      glb: opts.glb ? path.join(dir, "room.glb") : null,
    });
    return JSON.parse(fs.readFileSync(path.join(outDir, "result.json"), "utf8")) as {
      cameras: { id: string; render?: string }[];
      checks: { id: string; FLOAT?: number; OUT?: number[] }[];
    };
  };

  // ------------------------------------------------------------------ 4. orientation
  const judged = placements.filter((p) => p.views?.length);
  if (judged.length && cameras.length) {
    say(`orientation: rendering every model at 0°, 90°, 180°, 270° from ${cameras.length} camera(s)`);
    const turns = [0, 90, 180, 270];
    const renders: Record<number, Record<string, string>> = {};
    for (const t of turns) {
      const res = await build(`turn-${t}`, { turnAll: t });
      renders[t] = Object.fromEntries(res.cameras.map((c) => [c.id, c.render!]));
    }
    await pool(judged, 6, async (p) => {
      // The photo where this copy is largest.
      const area = (b: number[]) => (b[2] - b[0]) * (b[3] - b[1]);
      const view = [...p.views!].filter((v) => renders[0][v.photoId]).sort((a, b) => area(b.box) - area(a.box))[0];
      if (!view) return;
      const photo = tour.photos.find((x) => x.id === view.photoId)!;
      const cropOf = async (file: string, out: string) => {
        const m = await sharp(file).rotate().metadata();
        const [W, H] = (m.orientation ?? 1) >= 5 ? [m.height!, m.width!] : [m.width!, m.height!];
        const [y0, x0, y1, x1] = view.box.map((n) => n / 1000);
        const px = 0.25 * (x1 - x0);
        const py = 0.25 * (y1 - y0);
        const left = Math.max(0, Math.floor((x0 - px) * W));
        const top = Math.max(0, Math.floor((y0 - py) * H));
        await sharp(file)
          .rotate()
          .extract({ left, top, width: Math.max(8, Math.min(W, Math.ceil((x1 + px) * W)) - left), height: Math.max(8, Math.min(H, Math.ceil((y1 + py) * H)) - top) })
          .jpeg({ quality: 88 })
          .toFile(out);
        return out;
      };
      const odir = path.join(dir, "orientation", p.id);
      fs.mkdirSync(odir, { recursive: true });
      const photoCrop = await cropOf(path.resolve(tour.mediaRoot, photo.src), path.join(odir, "photo.jpg"));
      const renderCrops = await Promise.all(turns.map((t) => cropOf(renders[t][view.photoId], path.join(odir, `turn-${t}.jpg`))));
      const v = await cachedJson(path.join(odir, "verdict.json"), () => pickTurn(p.label, photoCrop, renderCrops));
      p.turn = v.turn ?? 0;
      say(`turn ${p.id}: ${v.turn ?? "unclear, kept"}°${v.wrongModel ? " (looks like the wrong model)" : ""} — ${v.reason}`);
    });
    // Copies of a group that no photo judged keep the turn of their judged sibling.
    for (const p of placements) if (!p.views?.length && p.kind !== "generic") p.turn = placements.find((q) => q.assetId === p.assetId && q.views?.length)?.turn ?? 0;
  }

  // ------------------------------------------------------------------ 5. final build, checks, photo | render
  const final = await build("final", { glb: true });
  const problems = final.checks.filter((c) => c.FLOAT != null || c.OUT);
  for (const c of final.cameras) {
    const p = photos.find((x) => x.id === c.id)!;
    const render = await sharp(c.render!).jpeg().toBuffer();
    const { width: W, height: H } = await sharp(render).metadata();
    const photoBuf = await sharp(path.resolve(tour.mediaRoot, p.src)).rotate().resize(W, H).jpeg().toBuffer();
    await sharp({ create: { width: W! * 2, height: H!, channels: 3, background: "#000" } })
      .composite([{ input: photoBuf, left: 0, top: 0 }, { input: render, left: W!, top: 0 }])
      .jpeg({ quality: 85 })
      .toFile(path.join(dir, `compare-${c.id}.jpg`));
  }

  const report = {
    tour: tour.id,
    room: `${levelId}/${roomId}`,
    builtAt: new Date().toISOString(),
    models: [...results.values()],
    placements: placements.map((p) => ({ id: p.id, assetId: p.assetId, turn: p.turn, scale: Math.round(p.scale * 1000) / 1000 })),
    builtToMeasure: items.filter((i) => BUILT_TO_MEASURE.has(i.kind)).map((i) => i.id),
    pictures: [...pictures.keys()],
    standIns: generated.filter((i) => !placements.some((p) => p.id === i.id)).map((i) => ({ id: i.id, reason: results.get(assetFor.get(i.id)!)?.reason ?? "no model" })),
    checks: final.checks,
    compare: final.cameras.map((c) => path.join(dir, `compare-${c.id}.jpg`)),
  };
  const reportFile = path.join(dir, "room.json");
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  const ok = [...results.values()].filter((r) => r.status === "ok").length;
  return {
    summary: `${ok}/${results.size} model(s) made, ${placements.length} placed, ${report.standIns.length} stand-in(s), ${problems.length} placement problem(s) → ${path.relative(process.cwd(), path.join(dir, "room.glb"))}`,
    roomGlb: path.join(dir, "room.glb"),
    report: reportFile,
  };
}
