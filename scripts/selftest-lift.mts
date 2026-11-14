/**
 * Self-test for the scene camera model and lift (no model calls):
 *   1. project() agrees with the viewer's three.js photo camera (incl. shifted horizons and pitch).
 *   2. Known boxes in the upper-floor kitchen, projected into synthetic photos, lift back to the
 *      same footprint and height (target: within 2 cm with exact pixels).
 *   3. With ±4 px of pixel noise, report the error a real photo can expect.
 *   npx tsx scripts/selftest-lift.mts
 */
import fs from "node:fs";
import * as THREE from "three";
import type { FloorPlan } from "../src/lib/floorplan";
import { liftDetection, mergeCandidates, type Candidate } from "../src/lib/scene/lift";
import { photoCamera, type V3 } from "../src/lib/scene/project";
import type { PhotoDetection } from "../src/lib/scene/types";
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

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
