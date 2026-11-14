/**
 * The one camera model shared by the scene pipeline, overlays and self-tests.
 *
 * Plan space: meters, x → right, y → down, z up from the level's floor. A photo's pose gives the
 * lens position (x, y, height), yaw (0 = +x, 90 = +y), pitch (> 0 looks up), horizontal FOV, and
 * the image row of the horizon (off-axis frustum for vertically corrected photos), exactly as
 * `photoCamera()` in tour/space.ts sets up the three.js camera.
 *
 * Image coordinates are normalised: u, v ∈ [0, 1], u → right, v → down.
 */
import type { Point } from "@/lib/floorplan";
import type { PhotoPose } from "@/lib/tour/types";

export type V3 = [number, number, number];

const DEG = Math.PI / 180;

export interface PhotoCamera {
  pose: PhotoPose;
  /** Image height / width. */
  aspect: number;
  /** Lens position in plan space (z = lens height). */
  eye: V3;
  /** Plan point → image (u, v), or null when it is less than `near` in front of the lens. */
  project(p: V3, near?: number): [number, number] | null;
  /** Depth of a plan point along the viewing direction. */
  depth(p: V3): number;
  /** Unit ray direction through image point (u, v). */
  ray(u: number, v: number): V3;
  /** Where the ray through (u, v) meets the horizontal plane at height z; null if it never does in front. */
  onPlane(u: number, v: number, z?: number): V3 | null;
  /** Where the ray through (u, v) meets the vertical plane through segment a–b (unbounded along it). */
  onVertical(u: number, v: number, a: Point, b: Point): V3 | null;
  /** Height of the point on the ray through (u, v) that passes closest to the vertical line through `at`. */
  heightAbove(u: number, v: number, at: Point): number | null;
}

export function photoCamera(pose: PhotoPose, aspect: number): PhotoCamera {
  const yaw = pose.yaw * DEG;
  const pitch = (pose.pitch ?? 0) * DEG;
  const tH = Math.tan((pose.hfov * DEG) / 2);
  const tV = tH * aspect;
  const horizon = pose.horizon ?? 0.5;
  const eye: V3 = [pose.x, pose.y, pose.height];

  // Camera basis in plan space. Level: forward = (cos ψ, sin ψ, 0), right = (−sin ψ, cos ψ, 0), up = z.
  const f0: V3 = [Math.cos(yaw), Math.sin(yaw), 0];
  const right: V3 = [-Math.sin(yaw), Math.cos(yaw), 0];
  const fwd: V3 = [f0[0] * Math.cos(pitch), f0[1] * Math.cos(pitch), Math.sin(pitch)];
  const up: V3 = [-f0[0] * Math.sin(pitch), -f0[1] * Math.sin(pitch), Math.cos(pitch)];

  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

  const depth = (p: V3) => dot(sub(p, eye), fwd);

  const project = (p: V3, near = 0.15): [number, number] | null => {
    const d = sub(p, eye);
    const f = dot(d, fwd);
    if (f < near) return null;
    const l = dot(d, right);
    const h = dot(d, up);
    return [0.5 + (0.5 * l) / (f * tH), horizon - (0.5 * h) / (f * tV)];
  };

  const ray = (u: number, v: number): V3 => {
    const a = (u - 0.5) * 2 * tH;
    const b = -(v - horizon) * 2 * tV;
    const r: V3 = [fwd[0] + right[0] * a + up[0] * b, fwd[1] + right[1] * a + up[1] * b, fwd[2] + right[2] * a + up[2] * b];
    const n = Math.hypot(...r);
    return [r[0] / n, r[1] / n, r[2] / n];
  };

  const onPlane = (u: number, v: number, z = 0): V3 | null => {
    const r = ray(u, v);
    if (Math.abs(r[2]) < 1e-9) return null;
    const t = (z - eye[2]) / r[2];
    if (t <= 0) return null;
    return [eye[0] + r[0] * t, eye[1] + r[1] * t, z];
  };

  const onVertical = (u: number, v: number, a: Point, b: Point): V3 | null => {
    const r = ray(u, v);
    // Plane normal (horizontal), perpendicular to a–b.
    const n: [number, number] = [-(b[1] - a[1]), b[0] - a[0]];
    const denom = n[0] * r[0] + n[1] * r[1];
    if (Math.abs(denom) < 1e-9) return null;
    const t = (n[0] * (a[0] - eye[0]) + n[1] * (a[1] - eye[1])) / denom;
    if (t <= 0) return null;
    return [eye[0] + r[0] * t, eye[1] + r[1] * t, eye[2] + r[2] * t];
  };

  const heightAbove = (u: number, v: number, at: Point): number | null => {
    const r = ray(u, v);
    const hx = r[0];
    const hy = r[1];
    const hh = hx * hx + hy * hy;
    if (hh < 1e-9) return null;
    // Ray parameter where its horizontal projection passes closest to `at`.
    const t = ((at[0] - eye[0]) * hx + (at[1] - eye[1]) * hy) / hh;
    if (t <= 0) return null;
    return eye[2] + r[2] * t;
  };

  return { pose, aspect, eye, project, depth, ray, onPlane, onVertical, heightAbove };
}

/** Points along a 3D segment, projected, split wherever the segment passes behind the lens. */
export function projectSegment(cam: PhotoCamera, a: V3, b: V3, steps = 40): [number, number][][] {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = cam.project([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    if (p) run.push(p);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs.filter((r) => r.length > 1);
}

/** The 8 corners of an axis-aligned plan box. */
export function boxCorners(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): V3[] {
  return [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
}

export const BOX_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * 2D bounds [u0, v0, u1, v1] of a box as seen in the photo, clipped to the frame (edges sampled so
 * parts behind the lens are handled). Null when nothing of it is in view.
 */
export function projectedBounds(cam: PhotoCamera, corners: V3[]): [number, number, number, number] | null {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const [i, j] of BOX_EDGES) {
    for (const run of projectSegment(cam, corners[i], corners[j], 24)) {
      for (const [u, v] of run) {
        u0 = Math.min(u0, u); v0 = Math.min(v0, v); u1 = Math.max(u1, u); v1 = Math.max(v1, v);
      }
    }
  }
  if (!Number.isFinite(u0)) return null;
  const c = (x: number) => Math.max(0, Math.min(1, x));
  const b: [number, number, number, number] = [c(u0), c(v0), c(u1), c(v1)];
  return b[2] - b[0] > 0.005 && b[3] - b[1] > 0.005 ? b : null;
}

export function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = iw * ih;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}
