/**
 * Stage 4: build a furnished room in Blender, render it from each photo's camera, colour-correct
 * it against the photos, and export the furniture as a Draco .glb.
 *
 *   npm run blender:scene -- --tour listing-15970 --room upper/r1 --selftest   # camera check, no model
 *   npm run blender:scene -- --tour listing-15970 --room upper/r1              # build + colour pass
 *     --no-color    skip the colour pass (no model calls)
 *
 * Needs src/data/scenes/<tour>/<level>-<room>.json (npm run build:scene). Writes renders, overlays
 * and room.glb to exports/<tour>/<level>-<room>/blender/; the colour pass updates the scene JSON.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { buildDollhouseScene } from "../src/lib/dollhouse-geometry";
import { type FloorPlan, polygonCentroid } from "../src/lib/floorplan";
import { sceneToGlb } from "../src/lib/glb";
import { blenderInfo, runBlender } from "../src/lib/blender/run-blender";
import { closePool } from "../src/lib/boxd/runner";
import { itemBox, pointInPolygon } from "../src/lib/scene/lift";
import { applyLook, lookPass, type LookAnswer } from "../src/lib/scene/look";
import { photoCamera, projectSegment, type V3 } from "../src/lib/scene/project";
import type { RoomScene } from "../src/lib/scene/types";
import type { Tour } from "../src/lib/tour/types";

const { values } = parseArgs({
  options: {
    tour: { type: "string" },
    room: { type: "string" },
    selftest: { type: "boolean", default: false },
    "no-color": { type: "boolean", default: false },
  },
});
if (!values.tour || !values.room) {
  console.error("Usage: blender-scene.mts --tour <id> --room <level>/<room> [--selftest] [--no-color]");
  process.exit(1);
}
const [levelId, roomId] = values.room.split("/");
const tour: Tour = JSON.parse(fs.readFileSync(`src/data/tours/${values.tour}.json`, "utf8"));
const level = tour.levels.find((l) => l.id === levelId)!;
const plan: FloorPlan = JSON.parse(fs.readFileSync(`src/data/plans/${level.planId}.json`, "utf8"));
const room = plan.rooms.find((r) => r.id === roomId)!;
const ceiling = level.ceilingHeight ?? plan.ceilingHeight;
const sceneFile = path.resolve("src/data/scenes", tour.id, `${levelId}-${roomId}.json`);
const dir = path.resolve("exports", tour.id, `${levelId}-${roomId}`, "blender");
fs.mkdirSync(dir, { recursive: true });

console.log(`Blender ${await blenderInfo()}`);

// The house shell, as the viewer builds it (with this level's measured ceiling).
const shell = path.join(dir, "shell.glb");
fs.writeFileSync(shell, await sceneToGlb(buildDollhouseScene({ ...plan, ceilingHeight: ceiling }, { ceilings: true })));

// Photos the scene's gate passed (all posed photos of the room for --selftest or before a scene exists).
const gated = fs.existsSync(sceneFile)
  ? new Set((JSON.parse(fs.readFileSync(sceneFile, "utf8")) as RoomScene).photos.filter((g) => g.gate === "pass").map((g) => g.id))
  : null;
const photos = tour.photos.filter(
  (p) => p.levelId === levelId && p.roomId === roomId && p.pose && (values.selftest || !gated || gated.has(p.id)),
);
const RENDER_W = 1280;
const cameras = photos.map((p) => ({ id: p.id, pose: p.pose!, width: RENDER_W, height: Math.round((RENDER_W * p.height) / p.width) }));

// Interior lights: a grid over the room, 2.5 m apart, just under the ceiling.
const xs = room.polygon.map((p) => p[0]);
const ys = room.polygon.map((p) => p[1]);
const lights: V3[] = [];
for (let x = Math.min(...xs) + 1.25; x < Math.max(...xs); x += 2.5)
  for (let y = Math.min(...ys) + 1.25; y < Math.max(...ys); y += 2.5) if (pointInPolygon([x, y], room.polygon)) lights.push([x, y, ceiling - 0.35]);
if (!lights.length) lights.push([...polygonCentroid(room.polygon), ceiling - 0.35]);

async function build(scene: RoomScene | null, tag: string, opts: { probes?: V3[]; glb?: boolean }) {
  const job = {
    mode: scene ? "build" : "selftest",
    shell,
    roomId,
    look: scene?.look ?? null,
    items: (scene?.items ?? []).map((i) => {
      const b = itemBox(i);
      return { id: i.id, label: i.label, kind: i.kind, color: i.color ?? null, material: i.material ?? null, box: [b.x0, b.y0, b.x1, b.y1, b.z0, b.z1] };
    }),
    cameras,
    probes: opts.probes ?? [],
    lights,
    outDir: path.join(dir, tag),
    glb: opts.glb ? path.join(dir, "room.glb") : null,
  };
  const jobFile = path.join(dir, `job-${tag}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));
  const t0 = Date.now();
  await runBlender(path.resolve("blender/build_scene.py"), [jobFile]);
  console.log(`  blender ${tag}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return JSON.parse(fs.readFileSync(path.join(job.outDir, "result.json"), "utf8")) as {
    engine: string;
    cameras: { id: string; probes: [number, number, number][]; render?: string }[];
  };
}

/** Draw the room outline (project.ts) over a render, for checking the camera by eye. */
async function outlineOver(render: string, camId: string, out: string) {
  const p = photos.find((x) => x.id === camId)!;
  const cam = photoCamera(p.pose!, p.height / p.width);
  const { width: W, height: H } = await sharp(render).metadata();
  let svg = "";
  room.polygon.forEach(([ax, ay], i) => {
    const [bx, by] = room.polygon[(i + 1) % room.polygon.length];
    for (const [a, b, color] of [
      [[ax, ay, ceiling], [bx, by, ceiling], "#ff1744"],
      [[ax, ay, 0], [bx, by, 0], "#2979ff"],
      [[ax, ay, 0], [ax, ay, ceiling], "#ffea00"],
    ] as [V3, V3, string][]) {
      for (const run of projectSegment(cam, a, b)) svg += `<polyline points="${run.map(([u, v]) => `${u * W!},${v * H!}`).join(" ")}" fill="none" stroke="${color}" stroke-width="3"/>`;
    }
  });
  await sharp(render).composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`) }]).jpeg().toFile(out);
}

if (values.selftest) {
  // Room corners at floor and ceiling, plus points through the room: Blender's camera must project
  // them exactly where project() does, including shifted horizons.
  const probes: V3[] = [];
  for (const [x, y] of room.polygon) probes.push([x, y, 0], [x, y, ceiling], [x, y, ceiling / 2]);
  for (let i = 0; i < 40; i++) probes.push([xs[0] + ((i * 0.37) % (Math.max(...xs) - Math.min(...xs))), ys[0] + ((i * 0.61) % (Math.max(...ys) - Math.min(...ys))), (i % 9) * 0.3]);
  const res = await build(null, "selftest", { probes });
  let worst = 0;
  for (const c of res.cameras) {
    const p = photos.find((x) => x.id === c.id)!;
    // The render's own aspect (its height is rounded to whole pixels).
    const shape = cameras.find((x) => x.id === c.id)!;
    const cam = photoCamera(p.pose!, shape.height / shape.width);
    let camWorst = 0;
    probes.forEach((pt, i) => {
      const ours = cam.project(pt, 0.3);
      const theirs = c.probes[i];
      if (!ours || theirs[2] < 0.3) return;
      camWorst = Math.max(camWorst, Math.hypot(ours[0] - theirs[0], ours[1] - theirs[1]) * RENDER_W);
    });
    worst = Math.max(worst, camWorst);
    console.log(`  camera ${c.id} (horizon ${p.pose!.horizon ?? 0.5}): worst ${camWorst.toFixed(3)} px of ${RENDER_W}`);
    if (c.render) await outlineOver(c.render, c.id, path.join(dir, `selftest-${c.id}.jpg`));
  }
  console.log(worst < 0.5 ? `ok: Blender's camera matches project() (worst ${worst.toFixed(3)} px)` : `FAIL: worst ${worst.toFixed(2)} px`);
  await closePool();
  process.exit(worst < 0.5 ? 0 : 1);
}

if (!fs.existsSync(sceneFile)) {
  console.error(`No scene at ${path.relative(process.cwd(), sceneFile)}: run npm run build:scene first`);
  await closePool();
  process.exit(1);
}
let scene: RoomScene = JSON.parse(fs.readFileSync(sceneFile, "utf8"));
let res = await build(scene, "render", { glb: true });

if (!values["no-color"]) {
  // Nearest cameras first: their answers win where photos disagree.
  const answers: LookAnswer[] = [];
  for (const c of res.cameras) {
    const p = photos.find((x) => x.id === c.id)!;
    const photoJpeg = await sharp(path.join(tour.mediaRoot, p.src)).rotate().resize(1280).jpeg({ quality: 85 }).toBuffer();
    const { answer } = await lookPass({ photoJpeg, renderPng: fs.readFileSync(c.render!), scene });
    console.log(`  colour ${c.id}: ${answer.items.map((i) => `${i.id}→${i.color} ${i.material}`).join(", ") || "no changes"}${answer.floor ? `; floor ${answer.floor}` : ""}${answer.walls ? `; walls ${answer.walls}` : ""}`);
    answers.push(answer);
  }
  const applied = applyLook(scene, answers);
  console.log(`  colour pass: ${applied.changes} change(s)`);
  if (applied.changes) {
    scene = applied.scene;
    fs.writeFileSync(sceneFile, JSON.stringify(scene, null, 2) + "\n");
    res = await build(scene, "render-color", { glb: true });
  }
}

// Photo | render side by side, per camera.
for (const c of res.cameras) {
  const p = photos.find((x) => x.id === c.id)!;
  const render = await sharp(c.render!).jpeg().toBuffer();
  const { width: W, height: H } = await sharp(render).metadata();
  const photo = await sharp(path.join(tour.mediaRoot, p.src)).rotate().resize(W, H).jpeg().toBuffer();
  await sharp({ create: { width: W! * 2, height: H!, channels: 3, background: "#000" } })
    .composite([{ input: photo, left: 0, top: 0 }, { input: render, left: W!, top: 0 }])
    .jpeg({ quality: 85 })
    .toFile(path.join(dir, `compare-${c.id}.jpg`));
}
console.log(`  → ${path.relative(process.cwd(), path.join(dir, "room.glb"))} (${(fs.statSync(path.join(dir, "room.glb")).size / 1024).toFixed(0)} KB) · compare-*.jpg in ${path.relative(process.cwd(), dir)}`);
await closePool();
