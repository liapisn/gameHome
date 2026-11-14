/** Offline check of the pose solver: synthetic cameras in a 6×4.5 m room, noisy picks, bad initial guesses.
 *   npx tsx scripts/selftest-pose.mts
 */
import { type Landmark, project, solvePose } from "../src/lib/tour/solve-pose";
import type { Point } from "../src/lib/floorplan";

let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;

const room: Point[] = [[0, 0], [6, 0], [6, 4.5], [0, 4.5]];
// Corners plus door/window jambs along the walls.
const features: Point[] = [...room, [2, 0], [3.6, 0], [6, 1.5], [6, 2.7], [1, 4.5], [1.9, 4.5], [0, 2], [0, 3.4]];

const ASPECT = 2 / 3;
const cases = [
  { x: 1.0, y: 1.0, yaw: 35, hfov: 90, height: 1.3 },
  { x: 5.2, y: 3.8, yaw: 210, hfov: 100, height: 1.1 },
  { x: 3.0, y: 4.0, yaw: 270, hfov: 75, height: 1.5 },
  { x: 0.6, y: 3.9, yaw: 330, hfov: 110, height: 1.2 },
];

let worst = { pos: 0, yaw: 0, fov: 0 };
for (const truth of cases) {
  for (const nLm of [3, 5]) {
    const visible: Landmark[] = features.flatMap((point) => {
      const uv = project(truth, point, ASPECT);
      if (!uv || uv.u < 0.03 || uv.u > 0.97) return [];
      return [{ point, u: uv.u, v: uv.v <= 0.99 ? uv.v : null }];
    });
    // ±1% pick noise in u, ±1.5% in v
    const lms = visible.slice(0, nLm).map((l) => ({ ...l, u: l.u + rand() * 0.01, v: l.v == null ? null : l.v + rand() * 0.015 }));
    const init = {
      x: truth.x + rand() * 1.2, y: truth.y + rand() * 1.2, yaw: truth.yaw + rand() * 20,
      hfov: truth.hfov + rand() * 15, height: 1.3,
    };
    const s = solvePose(lms, init, { polygon: room, aspect: ASPECT });
    const dPos = Math.hypot(s.x - truth.x, s.y - truth.y);
    const dYaw = Math.abs(((s.yaw - truth.yaw + 540) % 360) - 180);
    const dFov = Math.abs(s.hfov - truth.hfov);
    const dH = Math.abs(s.height - truth.height);
    // With < 3 landmarks the problem is under-determined (4 equations, 5 unknowns): report, don't assert.
    if (lms.length >= 3) {
      worst = { pos: Math.max(worst.pos, dPos), yaw: Math.max(worst.yaw, dYaw), fov: Math.max(worst.fov, dFov) };
    }
    const initErr = Math.hypot(init.x - truth.x, init.y - truth.y);
    console.log(
      `${nLm} lm (${lms.length} visible) · init off ${initErr.toFixed(2)} m → pos ${dPos.toFixed(2)} m · yaw ${dYaw.toFixed(1)}° · fov ${dFov.toFixed(1)}° · h ${dH.toFixed(2)} m · rms ${s.rmsDeg.toFixed(2)}°`,
    );
  }
}
console.log(`\nworst (≥3 landmarks): pos ${worst.pos.toFixed(2)} m · yaw ${worst.yaw.toFixed(1)}° · fov ${worst.fov.toFixed(1)}°`);
if (worst.pos > 0.5 || worst.yaw > 4) process.exit(1);
