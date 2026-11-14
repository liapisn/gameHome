/**
 * Camera resection in plan space from horizontal bearings.
 *
 * Each landmark is a known plan point plus where it appears horizontally in the photo
 * (u ∈ [0,1], left→right). For a level rectilinear camera at (x, y) facing yaw with
 * horizontal FOV h, a point at bearing β satisfies
 *     tan(β − yaw) = (2u − 1) · tan(h/2)
 * When the landmark's floor contact is visible (v ∈ [0,1], top→bottom) it also gives range:
 * listing photos are shot level (pitch ≈ 0, verticals corrected), so a floor point at forward
 * distance f below a lens at height c appears at  (2v − 1) · tan(vfov/2) = c / f.
 * We solve (x, y, yaw, hfov, c) by minimising angular residuals with Nelder–Mead, regularised
 * towards the model's own estimate so a few landmarks still give a stable answer.
 */
import type { Point } from "@/lib/floorplan";

export interface Landmark {
  point: Point;
  /** Horizontal image position, 0 = left edge, 1 = right edge. */
  u: number;
  /** Vertical image position where this vertical edge meets the floor, 0 = top, 1 = bottom. */
  v?: number | null;
}

export interface PoseEstimate {
  x: number;
  y: number;
  /** Degrees, plan space (0 = +x, 90 = +y). */
  yaw: number;
  hfov: number;
  /** Lens height above the floor, meters. */
  height: number;
}

export interface SolveOptions {
  /** Photo height / width. Needed for floor-contact (v) residuals. */
  aspect: number;
  /** Image row of the horizon (0.5 for an unshifted level photo). */
  horizon?: number;
  /** Room outline; the camera is pushed back inside it. */
  polygon?: Point[];
  /** Prior std-devs: position (m), yaw (deg), hfov (deg), height (m). */
  prior?: { pos: number; yaw: number; hfov: number; height: number };
  hfovRange?: [number, number];
}

export interface SolveResult extends PoseEstimate {
  rmsDeg: number;
  residualsDeg: number[];
}

const DEG = Math.PI / 180;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Where a plan point (and its floor contact) appears in the photo, or null if behind the camera. */
export function project(pose: PoseEstimate, p: Point, aspect: number, horizon = 0.5): { u: number; v: number } | null {
  const dx = p[0] - pose.x;
  const dy = p[1] - pose.y;
  const rel = wrap(Math.atan2(dy, dx) - pose.yaw * DEG);
  if (Math.abs(rel) >= Math.PI / 2) return null;
  const halfH = Math.tan((pose.hfov * DEG) / 2);
  const forward = Math.hypot(dx, dy) * Math.cos(rel);
  return { u: (Math.tan(rel) / halfH + 1) / 2, v: horizon + pose.height / forward / (halfH * aspect) / 2 };
}

/** Angular residuals (radians): one per landmark for u, plus one per landmark with a floor contact. */
function residuals(params: number[], lms: Landmark[], aspect: number, horizon: number): number[] {
  const [x, y, yaw, hfov, height] = params;
  const halfH = Math.tan(hfov / 2);
  const halfV = halfH * aspect;
  const out: number[] = [];
  for (const lm of lms) {
    const dx = lm.point[0] - x;
    const dy = lm.point[1] - y;
    const rel = wrap(Math.atan2(dy, dx) - yaw);
    // Points behind the camera are heavily penalised instead of wrapping silently.
    if (Math.abs(rel) >= Math.PI / 2) {
      out.push(Math.PI);
      if (lm.v != null) out.push(Math.PI);
      continue;
    }
    out.push(wrap(rel - Math.atan((2 * lm.u - 1) * halfH)));
    if (lm.v != null) {
      const forward = Math.hypot(dx, dy) * Math.cos(rel);
      out.push(Math.atan(height / forward) - Math.atan(2 * (lm.v - horizon) * halfV));
    }
  }
  return out;
}

function pointInPolygon([px, py]: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToPolygon([px, py]: Point, poly: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - py));
  }
  return best;
}

function nelderMead(f: (v: number[]) => number, start: number[], steps: number[], iterations = 600): number[] {
  const n = start.length;
  let simplex = [start, ...steps.map((s, i) => start.map((v, j) => (j === i ? v + s : v)))];
  let values = simplex.map(f);
  for (let it = 0; it < iterations; it++) {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    simplex = order.map(([, i]) => simplex[i]);
    values = order.map(([v]) => v);
    if (values[n] - values[0] < 1e-12) break;

    const centroid = start.map((_, j) => simplex.slice(0, n).reduce((s, p) => s + p[j], 0) / n);
    const along = (t: number) => centroid.map((c, j) => c + t * (simplex[n][j] - c));
    const reflected = along(-1);
    const fr = f(reflected);
    if (fr < values[0]) {
      const expanded = along(-2);
      const fe = f(expanded);
      [simplex[n], values[n]] = fe < fr ? [expanded, fe] : [reflected, fr];
    } else if (fr < values[n - 1]) {
      [simplex[n], values[n]] = [reflected, fr];
    } else {
      const contracted = along(0.5);
      const fc = f(contracted);
      if (fc < values[n]) {
        [simplex[n], values[n]] = [contracted, fc];
      } else {
        simplex = simplex.map((p) => p.map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])));
        values = simplex.map(f);
      }
    }
  }
  return simplex[values.indexOf(Math.min(...values))];
}

export function solvePose(landmarks: Landmark[], initial: PoseEstimate, opts: SolveOptions): SolveResult {
  const prior = opts.prior ?? { pos: 1.5, yaw: 25, hfov: 15, height: 0.3 };
  const [hMin, hMax] = (opts.hfovRange ?? [40, 120]).map((d) => d * DEG);
  const sigmaObs = 2 * DEG; // landmark pick noise
  const horizon = opts.horizon ?? 0.5;

  const x0 = [initial.x, initial.y, initial.yaw * DEG, initial.hfov * DEG, initial.height];
  const cost = (v: number[]) => {
    let c = 0;
    for (const r of residuals(v, landmarks, opts.aspect, horizon)) c += (r / sigmaObs) ** 2;
    c += ((v[0] - x0[0]) / prior.pos) ** 2 + ((v[1] - x0[1]) / prior.pos) ** 2;
    c += (wrap(v[2] - x0[2]) / (prior.yaw * DEG)) ** 2;
    c += ((v[3] - x0[3]) / (prior.hfov * DEG)) ** 2;
    c += ((v[4] - x0[4]) / prior.height) ** 2;
    if (v[4] < 0.5 || v[4] > 2.2) c += 1e4;
    if (v[3] < hMin) c += ((hMin - v[3]) / (1 * DEG)) ** 2;
    if (v[3] > hMax) c += ((v[3] - hMax) / (1 * DEG)) ** 2;
    if (opts.polygon && !pointInPolygon([v[0], v[1]], opts.polygon)) {
      c += (distanceToPolygon([v[0], v[1]], opts.polygon) / 0.05) ** 2;
    }
    return c;
  };

  // Multi-start: the cost is multi-modal when landmarks are few, so seed around the estimate.
  let best = x0;
  let bestCost = cost(x0);
  const offsets: Point[] = [[0, 0], [0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]];
  for (const [ox, oy] of offsets) {
    for (const dYaw of [0, -15, 15]) {
      for (const dFov of [0, -15, 15]) {
        const seed = [x0[0] + ox, x0[1] + oy, x0[2] + dYaw * DEG, x0[3] + dFov * DEG, x0[4]];
        const v = nelderMead(cost, seed, [0.4, 0.4, 8 * DEG, 8 * DEG, 0.15], 1200);
        const cv = cost(v);
        if (cv < bestCost) [best, bestCost] = [v, cv];
      }
    }
  }

  const res = residuals(best, landmarks, opts.aspect, horizon).map((r) => r / DEG);
  return {
    x: best[0],
    y: best[1],
    yaw: ((best[2] / DEG) % 360 + 360) % 360,
    hfov: best[3] / DEG,
    height: best[4],
    rmsDeg: res.length ? Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length) : 0,
    residualsDeg: res,
  };
}
