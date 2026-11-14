/**
 * Stage 2: pixels + solved camera → boxes in metres, merged across photos.
 *
 * The model only ever pointed at pixels (detect.ts). Everything here is geometry: floor contacts
 * are intersected with the floor plane, tops with the vertical line above a contact, wall-hung
 * items with the wall plane their box sits on. Rotations stay multiples of 90° in plan axes.
 */
import { type FloorPlan, type Point, type Room } from "@/lib/floorplan";
import { furnishPlan, footprint } from "@/lib/tour/furnish";
import { type PhotoCamera } from "./project";
import type { PhotoDetection, SceneItem, SceneKind } from "./types";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
type Side = "N" | "S" | "W" | "E";

/** Typical sizes (w along the wall/front, d front-to-back, h), used when a dimension isn't visible. */
export const KIND_SIZE: Record<SceneKind, [number, number, number]> = {
  sofa: [2.0, 0.9, 0.85],
  armchair: [0.85, 0.85, 0.85],
  coffeeTable: [1.1, 0.6, 0.42],
  tvUnit: [1.6, 0.42, 0.5],
  rug: [2.0, 1.4, 0.01],
  kitchen: [2.4, 0.6, 0.9],
  fridge: [0.6, 0.65, 1.85],
  diningTable: [1.4, 0.85, 0.75],
  pendant: [0.4, 0.4, 0.3],
  sideboard: [1.6, 0.45, 0.8],
  bed: [1.6, 2.05, 0.5],
  nightstand: [0.45, 0.4, 0.55],
  wardrobe: [1.6, 0.6, 2.2],
  desk: [1.2, 0.6, 0.75],
  bookshelf: [0.9, 0.35, 1.9],
  bathtub: [1.7, 0.75, 0.55],
  shower: [0.9, 0.9, 2.0],
  toilet: [0.38, 0.65, 0.8],
  vanity: [0.8, 0.48, 0.85],
  console: [1.1, 0.35, 0.8],
  bench: [1.2, 0.4, 0.45],
  plant: [0.45, 0.45, 1.1],
  floorLamp: [0.35, 0.35, 1.6],
  art: [0.7, 0.04, 0.5],
  shelves: [1.2, 0.35, 1.8],
  generic: [0.8, 0.5, 0.8],
};

/** Kinds whose back belongs on a wall even if the model didn't say so. */
const WALL_KINDS = new Set<string>(["kitchen", "fridge", "wardrobe", "sideboard", "bookshelf", "shelves", "tvUnit", "vanity", "toilet", "bathtub", "console", "bed"]);
/** Kinds that can't be anything but floor-standing. */
const FLOOR_ONLY = new Set<string>(["sofa", "armchair", "coffeeTable", "rug", "kitchen", "fridge", "diningTable", "bed", "bathtub", "toilet", "plant", "floorLamp", "desk", "bench"]);
const ROT: Record<Side, number> = { N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 };

/** A detection lifted from one photo. */
export interface Candidate {
  det: PhotoDetection;
  rect: Rect;
  z0: number;
  z1: number;
  /** Wall the item's back is on, if any. */
  side: Side | null;
  /** Long axis of the footprint when not against a wall. */
  axis: "x" | "y";
  weight: number;
  /** Horizontal distance from the camera to the item centre. */
  dist: number;
  /** How the footprint was found, for confidence. */
  fit: "footprint" | "front-edge" | "box" | "wall" | "ceiling";
}

export interface LiftResult {
  candidate: Candidate | null;
  /** Floor points that lifted inside / outside the room (gate signal). */
  floorInside: number;
  floorOutside: number;
  reason?: string;
}

const uvOf = ([y, x]: [number, number]): [number, number] => [x / 1000, y / 1000];

export function pointInPolygon([x, y]: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToPolygon([x, y]: Point, poly: Point[]) {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

/** Inside, or within `tol` of the outline. */
export const nearRoom = (p: Point, room: Room, tol = 0.25) => pointInPolygon(p, room.polygon) || distToPolygon(p, room.polygon) <= tol;

const bboxOf = (poly: Point[]): Rect => ({
  x0: Math.min(...poly.map((p) => p[0])),
  y0: Math.min(...poly.map((p) => p[1])),
  x1: Math.max(...poly.map((p) => p[0])),
  y1: Math.max(...poly.map((p) => p[1])),
});

/** Axis-aligned polygon edges with the side of the room they bound. */
function roomFaces(room: Room) {
  const faces: { side: Side; at: number; from: number; to: number }[] = [];
  const poly = room.polygon;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (Math.abs(a[1] - b[1]) < 1e-6) {
      // Horizontal edge: room is on the side the probe lands inside.
      const inBelow = pointInPolygon([mid[0], mid[1] + 0.05], poly);
      faces.push({ side: inBelow ? "N" : "S", at: a[1], from: Math.min(a[0], b[0]), to: Math.max(a[0], b[0]) });
    } else if (Math.abs(a[0] - b[0]) < 1e-6) {
      const inRight = pointInPolygon([mid[0] + 0.05, mid[1]], poly);
      faces.push({ side: inRight ? "W" : "E", at: a[0], from: Math.min(a[1], b[1]), to: Math.max(a[1], b[1]) });
    }
  }
  return faces;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Snap a footprint's back to the nearest parallel wall face. `extrapolated`: the back edge was guessed. */
function snapToWall(rect: Rect, room: Room, maxGap: number, depth: number, extrapolated: boolean, prefer?: Side): { rect: Rect; side: Side } | null {
  let best: { side: Side; gap: number; at: number } | null = null;
  for (const f of roomFaces(room)) {
    const horizontal = f.side === "N" || f.side === "S";
    const [a0, a1] = horizontal ? [rect.x0, rect.x1] : [rect.y0, rect.y1];
    const overlap = Math.min(a1, f.to) - Math.max(a0, f.from);
    if (overlap < Math.min(0.2, (a1 - a0) * 0.3)) continue;
    // Gap between the rect's back face and the wall face, measured into the room.
    const back = f.side === "N" ? rect.y0 : f.side === "S" ? rect.y1 : f.side === "W" ? rect.x0 : rect.x1;
    const gap = f.side === "N" || f.side === "W" ? back - f.at : f.at - back;
    const near = extrapolated ? Math.abs(gap) - 0.1 : Math.abs(gap);
    if (near > maxGap) continue;
    const score = near - (prefer === f.side ? 0.15 : 0);
    if (!best || score < best.gap) best = { side: f.side, gap: score, at: f.at };
  }
  if (!best) return null;
  const r = { ...rect };
  const s = best.side;
  // Front face stays where it was measured when the back was extrapolated; otherwise translate.
  if (s === "N") {
    if (extrapolated) r.y1 = Math.max(r.y1, best.at + depth * 0.6);
    else r.y1 += best.at - r.y0;
    r.y0 = best.at;
  } else if (s === "S") {
    if (extrapolated) r.y0 = Math.min(r.y0, best.at - depth * 0.6);
    else r.y0 += best.at - r.y1;
    r.y1 = best.at;
  } else if (s === "W") {
    if (extrapolated) r.x1 = Math.max(r.x1, best.at + depth * 0.6);
    else r.x1 += best.at - r.x0;
    r.x0 = best.at;
  } else {
    if (extrapolated) r.x0 = Math.min(r.x0, best.at - depth * 0.6);
    else r.x0 += best.at - r.x1;
    r.x1 = best.at;
  }
  return { rect: r, side: s };
}

/** Keep a rect inside the room's bounding box, shrinking it if it's bigger. */
function clampRect(r: Rect, room: Room): Rect {
  const b = bboxOf(room.polygon);
  const out = { ...r };
  for (const [lo, hi, blo, bhi] of [["x0", "x1", b.x0, b.x1], ["y0", "y1", b.y0, b.y1]] as const) {
    const size = Math.min(out[hi] - out[lo], bhi - blo);
    if (out[lo] < blo) out[lo] = blo;
    if (out[hi] > bhi) out[hi] = bhi;
    if (out[hi] - out[lo] < size) {
      if (out[lo] === blo) out[hi] = blo + size;
      else out[lo] = bhi - size;
    }
  }
  return out;
}

/** Lift one detection seen from `cam` into the room. */
export function liftDetection(det: PhotoDetection, cam: PhotoCamera, room: Room, ceiling: number): LiftResult {
  const kind = det.kind as SceneKind;
  const [dw, dd, dh] = KIND_SIZE[kind] ?? KIND_SIZE.generic;
  const mount = FLOOR_ONLY.has(kind) ? "floor" : det.mount;
  const [cx, cy] = [cam.eye[0], cam.eye[1]];
  const [by0, bx0, by1, bx1] = det.box.map((n) => n / 1000);

  if (mount === "wall") return liftWall(det, cam, room, ceiling, dd, bx0, by0, bx1, by1);
  if (mount === "ceiling") {
    const top = cam.onPlane((bx0 + bx1) / 2, by0, ceiling);
    if (!top || !nearRoom([top[0], top[1]], room, 0.3)) return { candidate: null, floorInside: 0, floorOutside: 0, reason: "ceiling point outside room" };
    const bottom = cam.heightAbove((bx0 + bx1) / 2, by1, [top[0], top[1]]) ?? ceiling - 0.6;
    const half = dw / 2;
    return {
      candidate: {
        det, rect: { x0: top[0] - half, y0: top[1] - half, x1: top[0] + half, y1: top[1] + half },
        z0: clamp(bottom, 0.3, ceiling - 0.1), z1: ceiling, side: null, axis: "x",
        weight: 1 / Math.max(1, Math.hypot(top[0] - cx, top[1] - cy)) ** 2, dist: Math.hypot(top[0] - cx, top[1] - cy), fit: "ceiling",
      },
      floorInside: 0, floorOutside: 0,
    };
  }

  // Floor items.
  const floor: Point[] = [];
  const floorIdx: number[] = [];
  let inside = 0;
  let outside = 0;
  det.floorPoints.forEach((px, i) => {
    const [u, v] = uvOf(px);
    const p = cam.onPlane(u, v, 0);
    if (!p || Math.hypot(p[0] - cx, p[1] - cy) > 15) return;
    if (nearRoom([p[0], p[1]], room)) inside++;
    else outside++;
    floor.push([p[0], p[1]]);
    floorIdx.push(i);
  });

  let rect: Rect;
  let fit: Candidate["fit"];
  let extrapolated = false;
  let pts = floor.filter((p) => nearRoom(p, room, 0.5));
  // Seen through an opening: its contacts are in another room. Leave it to that room's photos.
  if (floor.length >= 2 && pts.length === 0) {
    return { candidate: null, floorInside: inside, floorOutside: outside, reason: "outside the room" };
  }

  if (pts.length >= 2) {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const ex = rect.x1 - rect.x0;
    const ey = rect.y1 - rect.y0;
    const long = Math.max(ex, ey);
    const short = Math.min(ex, ey);
    if (long < 0.12) {
      pts = [[(rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2]];
    } else if (pts.length === 2 || short < 0.18) {
      // Only the front edge is visible: extend the known depth away from the camera.
      extrapolated = true;
      fit = "front-edge";
      const along: "x" | "y" = ex >= ey ? "x" : "y";
      const depth = kind === "rug" ? Math.max(short, dd * 0.7) : dd;
      if (along === "x") {
        const mid = (rect.y0 + rect.y1) / 2;
        const away = mid >= cy ? 1 : -1;
        rect = away > 0 ? { ...rect, y0: mid, y1: mid + depth } : { ...rect, y0: mid - depth, y1: mid };
      } else {
        const mid = (rect.x0 + rect.x1) / 2;
        const away = mid >= cx ? 1 : -1;
        rect = away > 0 ? { ...rect, x0: mid, x1: mid + depth } : { ...rect, x0: mid - depth, x1: mid };
      }
    } else {
      fit = "footprint";
    }
  }
  if (pts.length < 2) {
    // No usable footprint: put the box's bottom centre on the floor and use typical sizes.
    // A box cut off by the bottom of the frame has no floor contact in view.
    if (!pts[0] && by1 > 0.985) {
      return { candidate: null, floorInside: inside, floorOutside: outside, reason: "cut off by the frame" };
    }
    const bottom = pts[0] ? [pts[0][0], pts[0][1], 0] : cam.onPlane((bx0 + bx1) / 2, by1, 0);
    if (!bottom || Math.hypot(bottom[0] - cx, bottom[1] - cy) > 15) {
      return { candidate: null, floorInside: inside, floorOutside: outside, reason: "no floor contact" };
    }
    if (!nearRoom([bottom[0], bottom[1]], room, 0.5)) {
      return { candidate: null, floorInside: inside, floorOutside: outside, reason: "outside the room" };
    }
    const f = Math.max(0.3, cam.depth([bottom[0], bottom[1], 0]));
    const visibleW = clamp((bx1 - bx0) * 2 * Math.tan((cam.pose.hfov * Math.PI) / 360) * f, 0.2, 4);
    // Long axis: the plan axis closest to the image's horizontal.
    const yaw = (cam.pose.yaw * Math.PI) / 180;
    const along: "x" | "y" = Math.abs(Math.sin(yaw)) > Math.abs(Math.cos(yaw)) ? "x" : "y";
    const w = Math.max(visibleW * 0.9, Math.min(dw, visibleW * 1.2));
    const half = w / 2;
    if (along === "x") {
      const away = Math.sin(yaw) > 0 ? 1 : -1;
      rect = { x0: bottom[0] - half, x1: bottom[0] + half, y0: away > 0 ? bottom[1] : bottom[1] - dd, y1: away > 0 ? bottom[1] + dd : bottom[1] };
    } else {
      const away = Math.cos(yaw) > 0 ? 1 : -1;
      rect = { y0: bottom[1] - half, y1: bottom[1] + half, x0: away > 0 ? bottom[0] : bottom[0] - dd, x1: away > 0 ? bottom[0] + dd : bottom[0] };
    }
    extrapolated = true;
    fit = "box";
  }
  const cut = bx0 < 0.01 || bx1 > 0.99 || by1 > 0.99;

  // Height: tops measured above their floor contact, else the typical height.
  const tops: number[] = [];
  for (const t of det.topPoints) {
    const k = floorIdx.indexOf(t.floorIndex);
    if (k < 0) continue;
    const [u, v] = uvOf(t.point);
    const z = cam.heightAbove(u, v, floor[k]);
    if (z != null && z > 0.02 && z < ceiling + 0.1) tops.push(z);
  }
  let h = tops.length ? median(tops) : dh;
  if (kind === "rug") h = 0.01;
  h = clamp(h, 0.01, ceiling);

  let side: Side | null = null;
  if (det.againstWall || WALL_KINDS.has(kind)) {
    // Built-ins stand against walls; far contacts can be ~1 m off, so let them reach further.
    const reach = det.againstWall ? (det.builtIn || WALL_KINDS.has(kind) ? 1.0 : 0.55) : 0.35;
    const snapped = snapToWall(rect!, room, reach, dd, extrapolated);
    if (snapped) {
      rect = snapped.rect;
      side = snapped.side;
    }
  }
  rect = clampRect(rect!, room);
  const centre: Point = [(rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2];
  const dist = Math.hypot(centre[0] - cx, centre[1] - cy);
  return {
    candidate: {
      det, rect, z0: 0, z1: h, side,
      axis: rect.x1 - rect.x0 >= rect.y1 - rect.y0 ? "x" : "y",
      weight: (fit! === "box" || (cut && fit! !== "footprint") ? 0.3 : 1) / Math.max(1, dist) ** 2, dist, fit: fit!,
    },
    floorInside: inside,
    floorOutside: outside,
  };
}

function liftWall(det: PhotoDetection, cam: PhotoCamera, room: Room, ceiling: number, depth: number, bx0: number, by0: number, bx1: number, by1: number): LiftResult {
  // Which wall face does the box sit on? The first face the box-centre ray hits.
  const uc = (bx0 + bx1) / 2;
  const vc = (by0 + by1) / 2;
  let hit: { face: ReturnType<typeof roomFaces>[number]; t: number } | null = null;
  for (const face of roomFaces(room)) {
    const horizontal = face.side === "N" || face.side === "S";
    const a: Point = horizontal ? [face.from, face.at] : [face.at, face.from];
    const b: Point = horizontal ? [face.to, face.at] : [face.at, face.to];
    const p = cam.onVertical(uc, vc, a, b);
    if (!p) continue;
    const along = horizontal ? p[0] : p[1];
    if (along < face.from - 0.3 || along > face.to + 0.3) continue;
    const t = Math.hypot(p[0] - cam.eye[0], p[1] - cam.eye[1]);
    if (!hit || t < hit.t) hit = { face, t };
  }
  if (!hit) return { candidate: null, floorInside: 0, floorOutside: 0, reason: "no wall behind box" };
  const { face } = hit;
  const horizontal = face.side === "N" || face.side === "S";
  const inward = face.side === "N" || face.side === "W" ? 1 : -1;
  // The visible face stands `depth` in front of the wall (art: a few cm, wall cabinets: ~35 cm).
  const frontAt = face.at + inward * depth;
  const a: Point = horizontal ? [face.from, frontAt] : [frontAt, face.from];
  const b: Point = horizontal ? [face.to, frontAt] : [frontAt, face.to];
  // Face corners when given (exact); else the box's mid-lines (bounds of an oblique face overshoot).
  const pts = (det.faceCorners.length >= 2
    ? det.faceCorners.map(uvOf)
    : ([[bx0, vc], [bx1, vc], [uc, by0], [uc, by1]] as [number, number][])
  ).map(([u, v]) => cam.onVertical(u, v, a, b)).filter((p): p is NonNullable<typeof p> => !!p);
  if (pts.length < 2) return { candidate: null, floorInside: 0, floorOutside: 0, reason: "box edge misses wall" };
  const alongs = pts.map((p) => (horizontal ? p[0] : p[1]));
  const s0 = Math.max(face.from, Math.min(...alongs));
  const s1 = Math.min(face.to, Math.max(...alongs));
  if (s1 - s0 < 0.05) return { candidate: null, floorInside: 0, floorOutside: 0, reason: "box off the wall's ends" };
  const z0 = clamp(Math.min(...pts.map((p) => p[2])), 0, ceiling - 0.05);
  const z1 = clamp(Math.max(...pts.map((p) => p[2])), z0 + 0.05, ceiling);
  const cut = bx0 < 0.01 || bx1 > 0.99 || by0 < 0.01 || by1 > 0.99;
  const d0 = face.at;
  const d1 = face.at + inward * depth;
  const rect: Rect = horizontal
    ? { x0: s0, x1: s1, y0: Math.min(d0, d1), y1: Math.max(d0, d1) }
    : { y0: s0, y1: s1, x0: Math.min(d0, d1), x1: Math.max(d0, d1) };
  const dist = hit.t;
  return {
    candidate: { det, rect, z0, z1, side: face.side, axis: horizontal ? "x" : "y", weight: (cut ? 0.3 : 1) / Math.max(1, dist) ** 2, dist, fit: cut ? "box" : "wall" },
    floorInside: 0,
    floorOutside: 0,
  };
}

// --------------------------------------------------------------------------- merge

const rectIou = (a: Rect, b: Rect) => {
  const iw = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const ih = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = iw * ih;
  const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return union > 0 ? inter / union : 0;
};
/** Share of the smaller rect covered by the other. */
const rectCover = (a: Rect, b: Rect) => {
  const iw = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const ih = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const small = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  return small > 0 ? (iw * ih) / small : 0;
};
const centreGap = (a: Rect, b: Rect) => Math.hypot((a.x0 + a.x1 - b.x0 - b.x1) / 2, (a.y0 + a.y1 - b.y0 - b.y1) / 2);

const sameThing = (a: Candidate, b: Candidate) => {
  if (a.det.kind !== b.det.kind) return false;
  const vertical = Math.abs((a.z0 + a.z1) / 2 - (b.z0 + b.z1) / 2) < 0.6;
  // Views disagree by more for big things far away; scale the allowance with size.
  const size = Math.max(Math.hypot(a.rect.x1 - a.rect.x0, a.rect.y1 - a.rect.y0), Math.hypot(b.rect.x1 - b.rect.x0, b.rect.y1 - b.rect.y0));
  const sameWall = a.side != null && a.side === b.side;
  return vertical && (rectIou(a.rect, b.rect) > 0.1 || rectCover(a.rect, b.rect) > 0.5 || centreGap(a.rect, b.rect) < Math.max(0.6, size * (sameWall ? 0.5 : 0.35)));
};

/**
 * Keep sizes plausible for the kind: depth within [0.6, 1.6] × typical (far contacts stretch it),
 * width at least half the typical. Against a wall the back stays put and the front moves.
 */
function sanitize(r: Rect, side: Side | null, kind: SceneKind, mount: string): Rect {
  if (mount !== "floor" || kind === "rug") return r;
  const [dw, dd] = KIND_SIZE[kind] ?? KIND_SIZE.generic;
  const out = { ...r };
  const alongX = side ? side === "N" || side === "S" : r.x1 - r.x0 >= r.y1 - r.y0;
  const [wLo, wHi, dLo, dHi] = alongX ? (["x0", "x1", "y0", "y1"] as const) : (["y0", "y1", "x0", "x1"] as const);
  const depth = out[dHi] - out[dLo];
  const want = clamp(depth, dd * 0.6, dd * 1.6);
  if (want !== depth) {
    if (side === "N" || side === "W") out[dHi] = out[dLo] + want;
    else if (side === "S" || side === "E") out[dLo] = out[dHi] - want;
    else {
      const m = (out[dLo] + out[dHi]) / 2;
      [out[dLo], out[dHi]] = [m - want / 2, m + want / 2];
    }
  }
  const width = out[wHi] - out[wLo];
  if (width < dw * 0.5) {
    const m = (out[wLo] + out[wHi]) / 2;
    [out[wLo], out[wHi]] = [m - dw * 0.25, m + dw * 0.25];
  }
  return out;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Merge candidates from all photos into items. Detections in the same photo never merge. */
export function mergeCandidates(cands: Candidate[], room: Room, ceiling: number): SceneItem[] {
  const clusters: Candidate[][] = [];
  const free = (cl: Candidate[], c: Candidate) => !cl.some((o) => o.det.photoId === c.det.photoId);
  // Good fits first; rough box-only fits then join the nearest same-kind item if one is close.
  const sorted = [...cands].sort((a, b) => Number(a.fit === "box") - Number(b.fit === "box") || b.weight - a.weight);
  for (const c of sorted) {
    let home = clusters.find((cl) => free(cl, c) && cl.some((o) => sameThing(o, c)));
    if (!home && c.fit === "box") {
      home = clusters
        .filter((cl) => free(cl, c) && cl[0].det.kind === c.det.kind && centreGap(cl[0].rect, c.rect) < 0.8 + Math.hypot(cl[0].rect.x1 - cl[0].rect.x0, cl[0].rect.y1 - cl[0].rect.y0) / 2)
        .sort((a, b) => centreGap(a[0].rect, c.rect) - centreGap(b[0].rect, c.rect))[0];
    }
    if (home) home.push(c);
    else clusters.push([c]);
  }

  // Identity across photos when poses disagree: if no photo shows two of a kind, every photo's one
  // is the same object (one fridge, one dining table); built-ins on the same wall are one run.
  const perPhoto = new Map<string, number>();
  for (const c of cands) {
    const k = `${c.det.kind}|${c.det.photoId}`;
    perPhoto.set(k, (perPhoto.get(k) ?? 0) + 1);
  }
  const single = (kind: string) => ![...perPhoto.entries()].some(([k, n]) => k.startsWith(`${kind}|`) && n > 1);
  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i];
        const b = clusters[j];
        if (a[0].det.kind !== b[0].det.kind || a.some((x) => b.some((y) => x.det.photoId === y.det.photoId))) continue;
        const gap = centreGap(a[0].rect, b[0].rect);
        const sameWall = a[0].side != null && a[0].side === b[0].side && a[0].det.builtIn && b[0].det.builtIn;
        if ((single(a[0].det.kind) && gap < 2.5 && a[0].det.mount === b[0].det.mount) || (sameWall && gap < 2.0)) {
          a.push(...b);
          clusters.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  const RANK: Record<Candidate["fit"], number> = { footprint: 3, "front-edge": 2, wall: 2, ceiling: 1, box: 0 };
  const counts = new Map<string, number>();
  return clusters.map((all) => {
    // Geometry from the best kind of fit in the cluster only; weaker fits still count as views.
    const best = Math.max(...all.map((c) => RANK[c.fit]));
    const top = all.filter((c) => RANK[c.fit] === best);
    // Poses of different photos don't agree perfectly: take the nearest view's geometry, averaged
    // only with views that agree with it, rather than smearing inconsistent views together.
    const lead = top.reduce((a, b) => (b.weight > a.weight ? b : a));
    const cl = top.filter((c) => c === lead || centreGap(c.rect, lead.rect) < 0.35);
    const W = cl.reduce((s, c) => s + c.weight, 0);
    const avg = (f: (c: Candidate) => number) => cl.reduce((s, c) => s + f(c) * c.weight, 0) / W;
    // Wall side and axis by weighted vote.
    const vote = <T,>(f: (c: Candidate) => T) => {
      const m = new Map<T, number>();
      for (const c of cl) m.set(f(c), (m.get(f(c)) ?? 0) + c.weight);
      return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };
    const side = vote((c) => c.side);
    let rect: Rect = { x0: avg((c) => c.rect.x0), y0: avg((c) => c.rect.y0), x1: avg((c) => c.rect.x1), y1: avg((c) => c.rect.y1) };
    if (side) {
      // Re-snap the averaged back face onto its wall.
      const snapped = snapToWall(rect, room, 0.6, KIND_SIZE[lead.det.kind as SceneKind]?.[1] ?? 0.5, false, side);
      if (snapped && snapped.side === side) rect = snapped.rect;
    }
    rect = clampRect(sanitize(rect, side, lead.det.kind as SceneKind, lead.det.mount), room);
    const z0 = avg((c) => c.z0);
    const z1 = Math.min(ceiling, avg((c) => c.z1));
    const ex = rect.x1 - rect.x0;
    const ey = rect.y1 - rect.y0;
    // Furnishing frame: w along local x, d along local z (front). rot from the wall side, else long axis.
    let rot: number;
    let w: number;
    let d: number;
    if (side) {
      rot = ROT[side];
      [w, d] = side === "N" || side === "S" ? [ex, ey] : [ey, ex];
    } else {
      const axis = ex >= ey ? "x" : "y";
      rot = axis === "x" ? 0 : Math.PI / 2;
      [w, d] = axis === "x" ? [ex, ey] : [ey, ex];
    }
    const kind = lead.det.kind;
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    const id = `${kind}-${n}`;
    const views = new Set(all.map((c) => c.det.photoId)).size;
    const fitQ = Math.max(...cl.map((c) => ({ footprint: 1, "front-edge": 0.85, wall: 0.85, ceiling: 0.7, box: 0.55 })[c.fit]));
    const confidence = Math.round(Math.min(1, (views >= 3 ? 0.9 : views === 2 ? 0.75 : 0.55) * fitQ) * 100) / 100;
    const wallHung = lead.det.mount === "wall" && kind !== "kitchen";
    const item: SceneItem = {
      id,
      kind,
      label: lead.det.label,
      x: (rect.x0 + rect.x1) / 2,
      y: (rect.y0 + rect.y1) / 2,
      rot, w, d,
      h: wallHung || lead.fit === "ceiling" ? z1 - z0 : z1,
      seed: hash(id + lead.det.label),
      color: lead.det.color,
      material: lead.det.material,
      builtIn: lead.det.builtIn,
      source: "photos",
      seenIn: [...new Set(all.map((c) => c.det.photoId))],
      detections: all.map((c) => c.det.id),
      confidence,
    };
    if (wallHung) item.elevation = (z0 + z1) / 2;
    if (lead.fit === "ceiling") item.ceiling = ceiling;
    if (kind === "kitchen") item.uppers = false;
    if (kind === "diningTable") item.chairs = Math.max(2, Math.min(8, 2 * Math.round(Math.max(w, d) / 0.6)));
    return item;
  });
}

/** Rule-based items for this room where no detected item stands, for parts of the room no photo shows. */
export function fillFromRules(plan: FloorPlan, room: Room, items: SceneItem[]): SceneItem[] {
  const others = new Set(plan.rooms.filter((r) => r.id !== room.id).map((r) => r.id));
  const seenKinds = new Set(items.map((i) => i.kind));
  const taken = items.filter((i) => !i.elevation).map((i) => footprint(i));
  return furnishPlan(plan, others)
    .filter((f) => !seenKinds.has(f.kind) && f.kind !== "rug" && f.kind !== "pendant")
    .filter((f) => !taken.some((t) => {
      const r = footprint(f);
      return r.x0 < t.x1 + 0.1 && t.x0 < r.x1 + 0.1 && r.y0 < t.y1 + 0.1 && t.y0 < r.y1 + 0.1;
    }))
    .map((f) => ({ ...f, label: f.kind, source: "rules" as const, seenIn: [], detections: [], confidence: 0.3 }));
}

/** Footprint + height range of an item, for overlays and scoring. */
export function itemBox(i: Pick<SceneItem, "x" | "y" | "w" | "d" | "h" | "rot" | "elevation" | "ceiling" | "kind">) {
  const r = footprint(i);
  if (i.elevation != null) return { ...r, z0: i.elevation - i.h / 2, z1: i.elevation + i.h / 2 };
  if (i.kind === "pendant" && i.ceiling) return { ...r, z0: i.ceiling - i.h, z1: i.ceiling };
  return { ...r, z0: 0, z1: i.h };
}
