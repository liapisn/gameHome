/**
 * Self-test for the scene camera model and lift (no model calls):
 *   1. project() agrees with the viewer's three.js photo camera (incl. shifted horizons and pitch).
 *   2. Known boxes in the upper-floor kitchen, projected into synthetic photos, lift back to the
 *      same footprint and height (target: within 2 cm with exact pixels).
 *   3. With ±4 px of pixel noise, report the error a real photo can expect.
 *   4. Every kind's size limits: clamping, the typical-size fallback, wall-hung faces, anchors.
 *   5. Merging `generic` by label, dropping overlapping duplicates, screening by room and confidence.
 *   npx tsx scripts/selftest-lift.mts
 */
import fs from "node:fs";
import * as THREE from "three";
import { type FloorPlan, ownerRoomIds } from "../src/lib/floorplan";
import {
  fitSize, KIND_LIMITS, KIND_SIZE, kindFitsRoom, liftDetection, mergeCandidates, normaliseLabel, screenItems, type Candidate,
} from "../src/lib/scene/lift";
import { photoCamera, type V3 } from "../src/lib/scene/project";
import { voteDetections } from "../src/lib/scene/detect";
import { SCENE_KINDS, type Detection, type PhotoDetection } from "../src/lib/scene/types";
import { photoCamera as threeCamera } from "../src/lib/tour/space";
import type { PhotoPose } from "../src/lib/tour/types";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "  ok " : "FAIL "} ${msg}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- 1. agreement with three.js
{
  const level = { id: "l", name: "", planId: "", elevation: 2.9, offset: [1.5, -3] as [number, number] };
  let worst = 0;
  for (const pose of [
    { x: 1, y: 2, yaw: 30, pitch: 0, hfov: 100, height: 1.3, horizon: 0.5 },
    { x: 4, y: 1, yaw: 210, pitch: 0, hfov: 85, height: 1.5, horizon: 0.58 },
    { x: 2, y: 5, yaw: 300, pitch: 6, hfov: 105, height: 1.2, horizon: 0.44 },
  ] satisfies PhotoPose[]) {
    const aspect = 2 / 3;
    const ours = photoCamera(pose, aspect);
    const cam = threeCamera(level, pose, aspect);
    for (let i = 0; i < 200; i++) {
      const p: V3 = [pose.x + Math.cos(i) * (1 + (i % 7)), pose.y + Math.sin(i * 1.3) * (1 + (i % 5)), (i % 11) * 0.25];
      const a = ours.project(p, 0.3);
      if (!a) continue;
      const w = new THREE.Vector3(p[0] + level.offset[0], level.elevation + p[2], p[1] + level.offset[1]).project(cam);
      const b = [(w.x + 1) / 2, (1 - w.y) / 2];
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]));
    }
  }
  check(worst < 1e-6, `project() matches the three.js photo camera (worst ${worst.toExponential(1)} of the frame)`);
}

// ---------------------------------------------------------------- 2–3. lift round trip
const plan: FloorPlan = JSON.parse(fs.readFileSync("src/data/plans/listing-15970-upper.json", "utf8"));
const room = plan.rooms.find((r) => r.id === "r1")!; // Kitchen: x 0–3.19, y 1.45–7.27
const ceiling = plan.ceilingHeight;
const aspect = 2491 / 3744;

interface Truth { id: string; kind: PhotoDetection["kind"]; mount: PhotoDetection["mount"]; rect: [number, number, number, number]; z: [number, number]; wall: boolean }
const truths: Truth[] = [
  { id: "fridge", kind: "fridge", mount: "floor", rect: [2.55, 1.45, 3.19, 2.1], z: [0, 1.85], wall: true },
  { id: "kitchen", kind: "kitchen", mount: "floor", rect: [0, 2.5, 0.6, 5.6], z: [0, 0.9], wall: true },
  { id: "table", kind: "diningTable", mount: "floor", rect: [1.4, 5.2, 2.4, 6.2], z: [0, 0.75], wall: false },
  { id: "art", kind: "art", mount: "wall", rect: [3.15, 4.0, 3.19, 4.8], z: [1.4, 1.9], wall: true },
];
const poses: PhotoPose[] = [
  { x: 2.3, y: 6.9, yaw: 245, pitch: 0, hfov: 100, height: 1.25, horizon: 0.51 },
  { x: 0.8, y: 6.8, yaw: 300, pitch: 0, hfov: 102, height: 1.35, horizon: 0.53 },
  { x: 2.6, y: 2.4, yaw: 130, pitch: 0, hfov: 100, height: 1.2, horizon: 0.5 },
];

function synth(t: Truth, pose: PhotoPose, photoId: string, n: number, noisePx: number, rand: () => number): PhotoDetection | null {
  const cam = photoCamera(pose, aspect);
  const [x0, y0, x1, y1] = t.rect;
  const noise = () => ((rand() * 2 - 1) * noisePx) / 1000;
  const px = (p: V3): [number, number] | null => {
    const uv = cam.project(p, 0.3);
    if (!uv || uv[0] < 0 || uv[0] > 1 || uv[1] < 0 || uv[1] > 1) return null;
    return [(uv[1] + noise()) * 1000, (uv[0] + noise()) * 1000];
  };
  const corners: V3[] = [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]];
  const uvs = [...corners.map(([x, y]) => [x, y, t.z[0]] as V3), ...corners.map(([x, y]) => [x, y, t.z[1]] as V3)]
    .map((p) => cam.project(p, 0.3))
    .filter((uv): uv is [number, number] => !!uv);
  if (uvs.length < 4) return null;
  const box: [number, number, number, number] = [
    Math.max(0, Math.min(...uvs.map((u) => u[1]))) * 1000, Math.max(0, Math.min(...uvs.map((u) => u[0]))) * 1000,
    Math.min(1, Math.max(...uvs.map((u) => u[1]))) * 1000, Math.min(1, Math.max(...uvs.map((u) => u[0]))) * 1000,
  ];
  // Visible floor corners: in frame and not hidden behind the item's own body (the far corner).
  const far = corners.reduce((a, b) => (cam.depth(b) > cam.depth(a) ? b : a));
  const floorPoints: [number, number][] = [];
  const topPoints: { floorIndex: number; point: [number, number] }[] = [];
  if (t.mount === "floor") {
    for (const c of corners) {
      if (c === far) continue;
      const p = px(c);
      if (!p) continue;
      floorPoints.push(p);
      const top = px([c[0], c[1], t.z[1]]);
      if (top && topPoints.length < 2) topPoints.push({ floorIndex: floorPoints.length - 1, point: top });
    }
  }
  const faceCorners: [number, number][] = [];
  if (t.mount === "wall") {
    for (const c of [[x0, y0, t.z[0]], [x0, y1, t.z[0]], [x0, y1, t.z[1]], [x0, y0, t.z[1]]] as V3[]) {
      const p = px(c);
      if (p) faceCorners.push(p);
    }
  }
  return {
    id: `${photoId}:${n}`, faceCorners, photoId, label: t.id, kind: t.kind, mount: t.mount, builtIn: false, color: "#888888",
    material: "wood", box, floorPoints, topPoints, againstWall: t.wall,
  };
}

for (const noisePx of [0, 4]) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const cands: Candidate[] = [];
  poses.forEach((pose, k) => {
    truths.forEach((t, n) => {
      const det = synth(t, pose, `p${k}`, n, noisePx, rand);
      if (!det) return;
      const r = liftDetection(det, photoCamera(pose, aspect), room, ceiling);
      if (r.candidate) cands.push(r.candidate);
      if (process.env.DEBUG && !noisePx) console.log(k, t.id, det.floorPoints.length, det.topPoints.length, r.reason ?? "", r.candidate && Object.values(r.candidate.rect).map((v) => v.toFixed(2)).join(","), r.candidate?.side, r.candidate?.fit);
    });
  });
  const items = mergeCandidates(cands, room, ceiling);
  console.log(`\n${noisePx ? `±${noisePx}/1000 pixel noise` : "exact pixels"}: ${cands.length} candidates → ${items.length} items`);
  check(items.length === truths.length, `${items.length} items for ${truths.length} objects (no duplicates)`);
  for (const t of truths) {
    const it = items.find((i) => i.kind === t.kind);
    if (!it) {
      check(false, `${t.id}: not recovered`);
      continue;
    }
    const across = Math.abs(Math.sin(it.rot)) > 0.5;
    const [ex, ey] = across ? [it.d, it.w] : [it.w, it.d];
    const got = [it.x - ex / 2, it.y - ey / 2, it.x + ex / 2, it.y + ey / 2];
    if (process.env.DEBUG) console.log(t.id, got.map((g) => g.toFixed(2)).join(","), "truth", t.rect.join(","));
    const err = Math.max(...got.map((g, i) => Math.abs(g - t.rect[i])));
    const top = it.elevation != null ? it.elevation + it.h / 2 : it.h;
    const herr = Math.abs(top - t.z[1]);
    const tol = noisePx ? 0.25 : 0.02;
    const msg = `${t.id}: footprint error ${(err * 100).toFixed(1)} cm, top error ${(herr * 100).toFixed(1)} cm, views ${it.seenIn.length}`;
    if (noisePx) console.log(`  ..  ${msg}`);
    else check(err <= tol && herr <= tol, msg);
  }
}

// ---------------------------------------------------------------- 4. size limits
console.log("\nsize limits");
{
  const within = (v: number, [lo, hi]: [number, number]) => v >= lo - 1e-9 && v <= hi + 1e-9;
  const bad: string[] = [];
  // Every kind, every dimension: too small, too large (clamped) and far too large (typical size).
  for (const kind of SCENE_KINDS) {
    const L = KIND_LIMITS[kind];
    const [tw, td, th] = KIND_SIZE[kind];
    const mid = (r: [number, number]) => (r[0] + r[1]) / 2;
    for (const dim of ["w", "d", "h"] as const) {
      for (const [factor, far] of [[0.6, false], [1.5, false], [2.5, true]] as const) {
        const size = { w: mid(L.w), d: mid(L.d), h: mid(L.h), [dim]: L[dim][factor < 1 ? 0 : 1] * factor };
        // Against the N wall (y = 1): width along x, depth along y.
        const s = fitSize({ x0: 1, y0: 1, x1: 1 + size.w, y1: 1 + size.d }, 0, size.h, "N", kind, "floor", 2.6);
        const [w, d, h] = [s.rect.x1 - s.rect.x0, s.rect.y1 - s.rect.y0, s.z1 - s.z0];
        const typical = { w: tw, d: td, h: th }[dim];
        const got = { w, d, h }[dim];
        const ok =
          within(w, L.w) && within(d, L.d) && within(h, L.h) && s.rect.y0 === 1 && s.z0 === 0 && s.off === far &&
          (!far || Math.abs(got - Math.min(L[dim][1], Math.max(L[dim][0], typical))) < 1e-9);
        if (!ok) bad.push(`${kind}.${dim}×${factor}: ${w.toFixed(2)}×${d.toFixed(2)}×${h.toFixed(2)} off=${s.off}`);
      }
    }
  }
  check(!bad.length, `every kind clamped into its limits, back on the wall, typical size when far off${bad.length ? `: ${bad.slice(0, 5).join("; ")}` : ""}`);

  // The cases from the committed scenes.
  const fridge = fitSize({ x0: 0, y0: 1.45, x1: 0.58, y1: 1.45 + 1.04 }, 0, 1.93, "N", "fridge", "floor", 2.6);
  check(Math.abs(fridge.rect.y1 - fridge.rect.y0 - 0.8) < 1e-9 && fridge.rect.y0 === 1.45 && !fridge.off, "fridge 1.04 m deep → 0.8 m, back stays on the wall");
  const sofa = fitSize({ x0: 0, y0: 0, x1: 2.2, y1: 0.9 }, 0, 0.36, null, "sofa", "floor", 2.6);
  check(Math.abs(sofa.z1 - 0.6) < 1e-9 && !sofa.off, "sofa 0.36 m tall → 0.6 m");
  const vanity = fitSize({ x0: 0, y0: 0, x1: 0.6, y1: 0.48 }, 0, 0.12, "N", "vanity", "floor", 2.6);
  check(Math.abs(vanity.z1 - 0.85) < 1e-9 && vanity.off, "floor vanity 0.12 m tall → typical 0.85 m, flagged");
  const mirror = fitSize({ x0: 0, y0: 3, x1: 0.35, y1: 3.09 }, 1.3, 1.39, "W", "generic", "wall", 2.6);
  const [mw, md, mh] = [mirror.rect.y1 - mirror.rect.y0, mirror.rect.x1 - mirror.rect.x0, mirror.z1 - mirror.z0];
  check(Math.abs(mw - 0.2) < 1e-9 && Math.abs(md - 0.35) < 1e-9 && Math.abs(mh - 0.2) < 1e-9 && mirror.rect.x0 === 0 && Math.abs((mirror.z0 + mirror.z1) / 2 - 1.345) < 1e-9,
    `wall cabinet 9 cm wide → face 0.2 × 0.2 m, 0.35 m thick, centre height kept (${mw.toFixed(2)}×${md.toFixed(2)}×${mh.toFixed(2)})`);
  const art = fitSize({ x0: 3.15, y0: 4, x1: 3.19, y1: 4.05 }, 1.5, 1.55, "E", "art", "wall", 2.6);
  check(Math.abs(art.rect.x1 - art.rect.x0 - 0.04) < 1e-9 && art.rect.x1 === 3.19 && art.rect.y1 - art.rect.y0 >= 0.2 - 1e-9, "picture keeps its 4 cm thickness on the wall and a 0.2 m face");
  const bed = fitSize({ x0: 0, y0: 0, x1: 1.6, y1: 2.0 }, 0, 0.5, null, "bed", "floor", 2.6);
  // x extent 1.6 is the short side: a bed's width runs along it, its 2 m length is depth.
  check(bed.alongX && !bed.off && Math.abs(bed.rect.y1 - bed.rect.y0 - 2.0) < 1e-9, "free-standing bed: width across the short side, length as depth");
  const pendant = fitSize({ x0: 0, y0: 0, x1: 0.4, y1: 0.4 }, 0.2, 2.6, null, "pendant", "ceiling", 2.6);
  check(pendant.z1 === 2.6 && Math.abs(pendant.z0 - 1.4) < 1e-9, "pendant hangs from the ceiling, drop clamped to 1.2 m");
}

// ---------------------------------------------------------------- 5. labels, overlaps, screening
console.log("\nmerging and screening");
{
  check(normaliseLabel("Wall cabinets") === "wall cabinet" && normaliseLabel("left wall cabinets") === "wall cabinet", "'Wall cabinets' = 'left wall cabinets' = 'wall cabinet'");
  check(normaliseLabel("open shelves") === "open shelf" && normaliseLabel("glass") === "glass" && normaliseLabel("boxes") === "box", "singular: shelves → shelf, glass stays, boxes → box");
  check(normaliseLabel("extractor wall cabinets") !== normaliseLabel("wall cabinets"), "'extractor wall cabinets' stays its own thing");

  const kitchenRoom = { ...room, type: "kitchen" as const };
  const mk = (id: string, kind: PhotoDetection["kind"], label: string, rect: [number, number, number, number], z: [number, number], mount: PhotoDetection["mount"] = "floor", side: Candidate["side"] = null): Candidate => ({
    det: { id, photoId: id.split(":")[0], label, kind, mount, builtIn: false, color: "#888888", material: "wood", box: [0, 0, 1, 1], floorPoints: [], topPoints: [], faceCorners: [], againstWall: !!side },
    rect: { x0: rect[0], y0: rect[1], x1: rect[2], y1: rect[3] }, z0: z[0], z1: z[1], side, axis: "x", weight: 1, dist: 2,
    fit: mount === "wall" ? "wall" : "footprint",
  });
  // Two fridges in one photo, almost on top of each other: one object detected twice.
  const twice = mergeCandidates([mk("a:0", "fridge", "fridge", [2.5, 1.45, 3.15, 2.1], [0, 1.85], "floor", "N"), mk("a:1", "fridge", "fridge", [2.55, 1.45, 3.19, 2.05], [0, 1.8], "floor", "N")], kitchenRoom, ceiling);
  check(twice.length === 1 && twice[0].detections.length === 2, `overlapping same-kind items → one, keeping both detections (${twice.length})`);
  // Side by side, not overlapping: two.
  const pair = mergeCandidates([mk("a:0", "armchair", "armchair", [1, 3, 1.8, 3.8], [0, 0.85]), mk("a:1", "armchair", "armchair", [2, 3, 2.8, 3.8], [0, 0.85])], kitchenRoom, ceiling);
  check(pair.length === 2, "two armchairs side by side stay two");
  // Same generic thing seen once in each of two photos, poses 1.4 m apart: one wall cabinet run.
  const gen = mergeCandidates([
    mk("a:0", "generic", "wall cabinets", [0, 3, 0.35, 4.2], [1.4, 2.1], "wall", "W"),
    mk("b:0", "generic", "Wall cabinet", [0, 4.4, 0.35, 5.6], [1.4, 2.1], "wall", "W"),
    mk("b:1", "generic", "radiator", [0, 6, 0.1, 6.8], [0.2, 0.8], "wall", "W"),
  ], kitchenRoom, ceiling);
  check(gen.length === 2 && gen.some((i) => i.detections.length === 2 && /cabinet/i.test(i.label)), `generic merges by label: wall cabinets ×2 → 1, radiator apart (${gen.map((i) => i.label).join(", ")})`);
  // Same geometry, different generic labels seen in one photo each: not merged by identity.
  const diff = mergeCandidates([mk("a:0", "generic", "washing machine", [1, 3, 1.6, 3.6], [0, 0.85]), mk("b:0", "generic", "stool", [2.4, 3, 2.8, 3.4], [0, 0.6])], kitchenRoom, ceiling);
  check(diff.length === 2, "differently labelled generic things far apart stay apart");

  check(!kindFitsRoom("sofa", "bathroom") && !kindFitsRoom("bed", "bathroom") && !kindFitsRoom("bathtub", "kitchen"), "no sofa or bed in a bathroom, no bathtub in a kitchen");
  check(kindFitsRoom("sofa", "kitchen") && kindFitsRoom("diningTable", "living") && kindFitsRoom("bed", "office") && kindFitsRoom("plant", "bathroom"), "open-plan partners and anywhere-kinds fit");

  const ids = (id: string) => [...ownerRoomIds(plan, id)].sort().join(",");
  check(ids("r11") === "r10,r11" && ids("r2") === "r2" && ids("r7") === "r12,r7" && ids("nope") === "",
    `owner's room: living room spans into the dining room, bathroom alone, hall with stairs (${ids("r11")} · ${ids("r2")} · ${ids("r7")})`);

  const item = (kind: string, confidence: number, builtIn = false) => ({ ...pair[0], id: `${kind}-x`, kind: kind as PhotoDetection["kind"], confidence, builtIn });
  const s = screenItems([item("sofa", 0.9), item("toilet", 0.9), item("armchair", 0.3), item("vanity", 0.3, true), item("armchair", 0.45)], "bathroom");
  check(s.kept.map((i) => i.kind).join(",") === "toilet,vanity,armchair" && s.dropped.length === 2,
    `bathroom keeps toilet, built-in vanity at 0.3 and armchair at 0.45; drops sofa and a 0.3 guess (${s.dropped.map((d) => d.reason).join("; ")})`);
}

// ---------------------------------------------------------------- 6. lift guard (span, outside the room)
{
  console.log("\nlift guard");
  // The first photo that sees at least two of the item's floor corners.
  const guard = (t: Truth) => {
    // Plus one photo from the room's far end, looking down its length.
    for (const pose of [{ x: 1.6, y: 7.2, yaw: 270, pitch: -10, hfov: 110, height: 1.5, horizon: 0.5 }, ...poses]) {
      const det = synth(t, pose, "g", 0, 0, () => 0.5);
      if (det && det.floorPoints.length >= 2) return liftDetection(det, photoCamera(pose, aspect), room, ceiling);
    }
    return null;
  };
  const sofa = guard({ id: "sofa", kind: "sofa", mount: "floor", rect: [1.2, 1.5, 2.1, 6.0], z: [0, 0.8], wall: false });
  check(!!sofa && !sofa.candidate && sofa.reason === "floor points span too far", `a sofa spanning 4.5 m is dropped (${sofa?.reason ?? "no detection"})`);
  const kitchen = guard({ id: "kitchen", kind: "kitchen", mount: "floor", rect: [0, 1.5, 0.6, 6.0], z: [0, 0.9], wall: true });
  check(!!kitchen?.candidate, `a kitchen run spanning 4.5 m is kept (${kitchen?.reason ?? "ok"})`);
  const rug = guard({ id: "rug", kind: "rug", mount: "floor", rect: [0.1, 2.0, 3.1, 6.0], z: [0, 0.01], wall: false });
  check(!!rug?.candidate, `a 3 × 4 m rug (5 m diagonal) is kept (${rug?.reason ?? "ok"})`);
  const chair = guard({ id: "chair", kind: "armchair", mount: "floor", rect: [2.9, 3.0, 3.7, 3.8], z: [0, 0.9], wall: false });
  check(!!chair && !chair.candidate && chair.reason === "floor points outside the room", `an armchair with most points outside the room is dropped (${chair?.reason ?? "no detection"})`);
}

// ---------------------------------------------------------------- voting three detect runs
{
  console.log("\nvoting three detect runs (docs/library-full-plan.md, Part C)");
  const sofa = (fp: [number, number][], box: [number, number, number, number]): Detection => ({
    label: "sofa", kind: "sofa", mount: "floor", builtIn: false, color: "#888888", material: "fabric", box,
    floorPoints: fp, topPoints: [{ floorIndex: 0, point: [fp[0][0] - 200, fp[0][1]] }], faceCorners: [], againstWall: true,
  });
  const lamp: Detection = { ...sofa([[600, 900]], [200, 850, 620, 950]), label: "lamp", kind: "floorLamp", topPoints: [] };
  const runs = [
    { cameraRoom: "living" as const, items: [sofa([[800, 300], [810, 600]], [500, 280, 820, 620]), lamp] },
    { cameraRoom: "living" as const, items: [sofa([[804, 304], [806, 598]], [502, 282, 818, 618])] },
    { cameraRoom: "bedroom" as const, items: [sofa([[800, 300], [610, 600]], [498, 279, 821, 622])] },
  ];
  const v = voteDetections(runs);
  const s = v.items.find((i) => i.kind === "sofa");
  check(v.items.length === 1 && !!s, `an item seen in one run only is dropped (${v.items.map((i) => i.label).join(", ")})`);
  const p = s?.floorPoints[1];
  check(!!p && Math.hypot(p[0] - 808, p[1] - 599) <= 5, `a floor point 200 units off in one run is outvoted (${JSON.stringify(p)})`);
  check(v.cameraRoom === "living", `cameraRoom by majority (${v.cameraRoom})`);
  check(voteDetections([runs[0]]).items.length === 2, "one run passes through unchanged");
  const ottoman = (label: string): Detection => ({ ...sofa([[700, 100]], [550, 60, 720, 160]), kind: "generic", label, topPoints: [] });
  const named = voteDetections([{ cameraRoom: "living", items: [ottoman("cream ottoman")] }, { cameraRoom: "living", items: [ottoman("cube ottoman")] }, { cameraRoom: "living", items: [ottoman("cream cube ottoman")] }]);
  check(named.items.length === 1, `one generic object named differently by each run is kept (${named.items.length})`);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
