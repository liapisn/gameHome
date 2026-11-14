/**
 * Position search by edge alignment ("render and compare" on edges).
 *
 * With heading, field of view and horizon known from vanishing points, a camera position, lens
 * height and ceiling height predict exactly where the room's outline appears: the wall/ceiling
 * junctions (rarely hidden by furniture), the wall/floor junctions and the vertical corners.
 * Each hypothesis is scored by sampling along those projected lines and measuring how much image
 * gradient runs across them, minus a background level, so predicting outline where the photo has
 * no matching edge costs score. No line-to-feature correspondences are needed.
 */
import type { Point, Room } from "@/lib/floorplan";

const DEG = Math.PI / 180;

export interface Gradient {
  gx: Float32Array;
  gy: Float32Array;
  width: number;
  height: number;
  /** Typical gradient magnitude response, subtracted per sample. */
  baseline: number;
}

/** Bilinear downscale of a grayscale image to a new width. */
export function resizeGray(gray: Uint8Array, width: number, height: number, newWidth: number) {
  const scale = width / newWidth;
  const newHeight = Math.round(height / scale);
  const out = new Uint8Array(newWidth * newHeight);
  for (let y = 0; y < newHeight; y++) {
    const sy = Math.min(height - 1.001, (y + 0.5) * scale - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const fy = sy - y0;
    for (let x = 0; x < newWidth; x++) {
      const sx = Math.min(width - 1.001, (x + 0.5) * scale - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const fx = sx - x0;
      const a = gray[y0 * width + x0];
      const b = gray[y0 * width + x0 + 1];
      const c = gray[(y0 + 1) * width + x0];
      const d = gray[(y0 + 1) * width + x0 + 1];
      out[y * newWidth + x] = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    }
  }
  return { data: out, width: newWidth, height: newHeight };
}

/** Gaussian-blurred Sobel gradient. Blur widens the basin of attraction for the coarse search. */
export function gradientField(gray: Uint8Array, width: number, height: number, sigma: number): Gradient {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const ks = k.reduce((s, v) => s + v, 0);
  const tmp = new Float32Array(width * height);
  const img = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += gray[y * width + Math.min(width - 1, Math.max(0, x + i))] * k[i + r];
      tmp[y * width + x] = s / ks;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[Math.min(height - 1, Math.max(0, y + i)) * width + x] * k[i + r];
      img[y * width + x] = s / ks;
    }
  }
  const gx = new Float32Array(width * height);
  const gy = new Float32Array(width * height);
  let sum = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const a = (yy: number, xx: number) => img[yy * width + xx];
      const vx = a(y - 1, x + 1) + 2 * a(y, x + 1) + a(y + 1, x + 1) - a(y - 1, x - 1) - 2 * a(y, x - 1) - a(y + 1, x - 1);
      const vy = a(y + 1, x - 1) + 2 * a(y + 1, x) + a(y + 1, x + 1) - a(y - 1, x - 1) - 2 * a(y - 1, x) - a(y - 1, x + 1);
      gx[y * width + x] = vx;
      gy[y * width + x] = vy;
      sum += Math.hypot(vx, vy);
    }
  }
  // A randomly oriented line picks up ~2/π of the mean magnitude.
  const baseline = ((sum / (width * height)) * 2) / Math.PI;
  return { gx, gy, width, height, baseline };
}

export interface CameraHypothesis {
  x: number;
  y: number;
  yaw: number;
  hfov: number;
  height: number;
  ceiling: number;
}

interface Seg3 {
  a: [number, number, number];
  b: [number, number, number];
  weight: number;
}

/** The room's outline as 3D segments: ceiling and floor junctions, plus vertical corners. */
function outline(room: Room, ceiling: number): Seg3[] {
  const segs: Seg3[] = [];
  const poly = room.polygon;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    segs.push({ a: [ax, ay, ceiling], b: [bx, by, ceiling], weight: 1 }); // ceiling junction: rarely occluded
    segs.push({ a: [ax, ay, 0], b: [bx, by, 0], weight: 0.5 }); // floor junction: often hidden by furniture
    segs.push({ a: [ax, ay, 0], b: [ax, ay, ceiling], weight: 0.7 }); // corner
  }
  return segs;
}

/** Project a 3D plan point (x, y, z) to normalized image coords, or null if behind the camera. */
function projectPoint(c: CameraHypothesis, aspect: number, horizon: number, p: [number, number, number]) {
  const dx = p[0] - c.x;
  const dy = p[1] - c.y;
  const cos = Math.cos(c.yaw * DEG);
  const sin = Math.sin(c.yaw * DEG);
  const forward = dx * cos + dy * sin;
  if (forward < 0.15) return null;
  const lateral = -dx * sin + dy * cos; // + is to the right in the image (plan y is down)
  const tanH = Math.tan((c.hfov * DEG) / 2);
  return {
    u: 0.5 + (0.5 * lateral) / (forward * tanH),
    v: horizon + (0.5 * (c.height - p[2])) / (forward * tanH * aspect),
  };
}

export function scoreHypothesis(
  g: Gradient,
  room: Room,
  c: CameraHypothesis,
  horizon: number,
  samplesPerSeg = 24,
): { score: number; samples: number } {
  const aspect = g.height / g.width;
  let score = 0;
  let samples = 0;
  for (const s of outline(room, c.ceiling)) {
    let prev: { u: number; v: number } | null = null;
    for (let i = 0; i <= samplesPerSeg; i++) {
      const t = i / samplesPerSeg;
      const p = projectPoint(c, aspect, horizon, [
        s.a[0] + (s.b[0] - s.a[0]) * t,
        s.a[1] + (s.b[1] - s.a[1]) * t,
        s.a[2] + (s.b[2] - s.a[2]) * t,
      ]);
      if (!p) {
        prev = null;
        continue;
      }
      if (prev && p.u > 0.01 && p.u < 0.99 && p.v > 0.01 && p.v < 0.99) {
        // Normal of the projected line at this sample, in pixels.
        const lx = (p.u - prev.u) * g.width;
        const ly = (p.v - prev.v) * g.height;
        const len = Math.hypot(lx, ly);
        if (len > 0.5) {
          const px = Math.round(p.u * (g.width - 1));
          const py = Math.round(p.v * (g.height - 1));
          const i2 = py * g.width + px;
          const across = Math.abs((g.gx[i2] * -ly + g.gy[i2] * lx) / len);
          score += s.weight * (Math.min(across, 6 * g.baseline) - g.baseline);
          samples++;
        }
      }
      prev = p;
    }
  }
  return { score: score / g.baseline, samples };
}

/**
 * Soft priors on lens and ceiling height. Without visible floor lines, moving the camera back
 * while raising the ceiling fits the ceiling junction almost equally well; typical listing
 * photography (~1.3 m tripod) and ceilings (~2.75 m) break that tie.
 */
const PRIOR_WEIGHT = 6;
function prior(c: CameraHypothesis): number {
  if (c.height < 0.8 || c.height > 2 || c.ceiling < 2.3 || c.ceiling > 3.6 || c.hfov < 60 || c.hfov > 120) return Infinity;
  return PRIOR_WEIGHT * (((c.height - 1.3) / 0.2) ** 2 + ((c.ceiling - 2.75) / 0.25) ** 2);
}

export interface EdgeAlignResult extends CameraHypothesis {
  score: number;
  /** Best score from a clearly different position (> 1 m away), or null in rooms too small to have one. */
  runnerUp: number | null;
}

/** Photographers stand in the room, not inside or against a wall: keep the lens this far from walls. */
const WALL_CLEARANCE = 0.3;

function distanceToOutline([px, py]: Point, poly: Point[]): number {
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

function standable(p: Point, poly: Point[]): boolean {
  return insidePolygon(p, poly) && distanceToOutline(p, poly) >= WALL_CLEARANCE;
}

function insidePolygon([px, py]: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Search position, lens height and ceiling height for each candidate heading.
 * @param coarse heavily blurred gradient for the grid search
 * @param fine lightly blurred gradient for refinement
 */
export function edgeAlign(
  coarse: Gradient,
  fine: Gradient,
  room: Room,
  yaws: number[],
  hfov: number,
  horizon: number,
): EdgeAlignResult | null {
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const step = Math.max(0.2, Math.max(x1 - x0, y1 - y0) / 24);

  const scored: { c: CameraHypothesis; s: number }[] = [];
  for (const yaw of yaws) {
    for (let x = x0 + step / 2; x < x1; x += step) {
      for (let y = y0 + step / 2; y < y1; y += step) {
        if (!standable([x, y], room.polygon)) continue;
        for (let height = 1.0; height <= 1.71; height += 0.15) {
          for (let ceiling = 2.5; ceiling <= 3.31; ceiling += 0.2) {
            const c = { x, y, yaw, hfov, height, ceiling };
            scored.push({ c, s: scoreHypothesis(coarse, room, c, horizon, 10).score - prior(c) });
          }
        }
      }
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.s - a.s);

  // Refine the best few distinct candidates by coordinate descent on the fine field.
  const refined: { c: CameraHypothesis; s: number }[] = [];
  for (const cand of scored.slice(0, 40)) {
    if (refined.some((r) => Math.hypot(r.c.x - cand.c.x, r.c.y - cand.c.y) < 0.4 && r.c.yaw === cand.c.yaw)) continue;
    let c = { ...cand.c };
    const objective = (h: CameraHypothesis) => scoreHypothesis(fine, room, h, horizon).score - prior(h);
    let s = objective(c);
    const steps: [keyof CameraHypothesis, number][] = [
      ["x", 0.1],
      ["y", 0.1],
      ["height", 0.05],
      ["ceiling", 0.05],
      ["yaw", 0.5],
      ["hfov", 0.75],
    ];
    for (let round = 0; round < 4; round++) {
      let improved = false;
      for (const [k, d] of steps) {
        for (const dir of [-1, 1]) {
          for (let n = 0; n < 6; n++) {
            const next = { ...c, [k]: c[k] + dir * d / (round + 1) };
            if (k === "x" || k === "y") {
              if (!standable([next.x, next.y], room.polygon)) break;
            }
            const ns = objective(next);
            if (ns <= s) break;
            c = next;
            s = ns;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    refined.push({ c, s });
    if (refined.length >= 6) break;
  }
  refined.sort((a, b) => b.s - a.s);
  const best = refined[0];
  const runnerUp = refined.find((r) => Math.hypot(r.c.x - best.c.x, r.c.y - best.c.y) > 1)?.s ?? null;
  return { ...best.c, score: best.s, runnerUp };
}
