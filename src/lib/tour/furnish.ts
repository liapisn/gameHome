/**
 * Virtual staging: lays out furniture for a floor plan from room types alone.
 *
 * Pure layout, no three.js: items are axis-aligned boxes in plan space (meters, x → right,
 * y → down) with a rotation about world Y that is a multiple of 90°. Each item's local frame has
 * its back at -z and its front facing +z, so "against a wall" means back to the wall, facing in.
 * The renderer (components/tour/Furnishings.tsx) turns kinds into meshes.
 */
import { type FloorPlan, type Point, type Room, polygonArea } from "@/lib/floorplan";

export type FurnishingKind =
  | "sofa"
  | "armchair"
  | "coffeeTable"
  | "tvUnit"
  | "rug"
  | "kitchen"
  | "fridge"
  | "diningTable"
  | "pendant"
  | "sideboard"
  | "bed"
  | "nightstand"
  | "wardrobe"
  | "desk"
  | "bookshelf"
  | "bathtub"
  | "shower"
  | "toilet"
  | "vanity"
  | "console"
  | "bench"
  | "plant"
  | "floorLamp"
  | "art"
  | "bistroSet"
  | "railing"
  | "shelves";

export interface Furnishing {
  id: string;
  kind: FurnishingKind;
  /** Footprint center in plan space. */
  x: number;
  y: number;
  /** Rotation about world Y (radians). 0 faces +y on the plan. */
  rot: number;
  /** Width (local x), depth (local z), height. */
  w: number;
  d: number;
  h: number;
  /** For wall-hung items: height of the item's center above the floor. */
  elevation?: number;
  /** Deterministic seed for colors and generated artwork. */
  seed: number;
  /** Kitchen run: draw wall cabinets above (no window behind). */
  uppers?: boolean;
  /** Dining table: number of chairs. */
  chairs?: number;
  /** Ceiling height, for items hung from it. */
  ceiling?: number;
  /** Stands on a balcony slab (drawn slightly below the interior floor). */
  onBalcony?: boolean;
}

type Side = "N" | "S" | "W" | "E";
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** Something occupying a stretch of a wall over a height band. */
interface WallBlock {
  s: number;
  e: number;
  y0: number;
  y1: number;
}
interface SideInfo {
  side: Side;
  /** Along-wall range of the room's bounding box. */
  from: number;
  to: number;
  /** Inner face of the wall, in the perpendicular coordinate. */
  face: number;
  blocks: WallBlock[];
}

const DOOR_CLEARANCE = 0.85;
const ROT: Record<Side, number> = { N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 };

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function pointInPolygon([x, y]: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const rectOf = (cx: number, cy: number, sx: number, sy: number): Rect => ({
  x0: cx - sx / 2,
  y0: cy - sy / 2,
  x1: cx + sx / 2,
  y1: cy + sy / 2,
});

/** Plan-space footprint of an item (rotations are multiples of 90°). */
export function footprint(f: Pick<Furnishing, "x" | "y" | "w" | "d" | "rot">): Rect {
  const across = Math.abs(Math.sin(f.rot)) > 0.5;
  return rectOf(f.x, f.y, across ? f.d : f.w, across ? f.w : f.d);
}

class RoomLayout {
  readonly items: Furnishing[] = [];
  readonly obstacles: Rect[];
  readonly sides: SideInfo[];
  readonly bbox: Rect;
  readonly area: number;
  private n = 0;
  readonly rand: () => number;

  constructor(
    readonly room: Room,
    readonly plan: FloorPlan,
    doorZones: Rect[],
  ) {
    const xs = room.polygon.map((p) => p[0]);
    const ys = room.polygon.map((p) => p[1]);
    this.bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    this.area = polygonArea(room.polygon);
    this.obstacles = doorZones.filter((z) => overlaps(z, this.bbox));
    this.sides = (["N", "S", "W", "E"] as const).map((s) => this.sideInfo(s));
    this.rand = rng(hash(room.id));
  }

  private sideInfo(side: Side): SideInfo {
    const b = this.bbox;
    const horizontal = side === "N" || side === "S";
    const line = side === "N" ? b.y0 : side === "S" ? b.y1 : side === "W" ? b.x0 : b.x1;
    const inward = side === "N" || side === "W" ? 1 : -1;
    const [from, to] = horizontal ? [b.x0, b.x1] : [b.y0, b.y1];
    let half = 0.06;
    const blocks: WallBlock[] = [];
    for (const wall of this.plan.walls) {
      const [ax, ay] = wall.a;
      const [bx, by] = wall.b;
      const aligned = horizontal ? Math.abs(ay - by) < 0.05 : Math.abs(ax - bx) < 0.05;
      const coord = horizontal ? ay : ax;
      if (!aligned || Math.abs(coord - line) > 0.2) continue;
      const lo = Math.min(horizontal ? ax : ay, horizontal ? bx : by);
      const hi = Math.max(horizontal ? ax : ay, horizontal ? bx : by);
      if (hi <= from || lo >= to) continue;
      half = Math.max(half, wall.thickness / 2);
      const len = Math.hypot(bx - ax, by - ay);
      for (const o of this.plan.openings) {
        if (o.wallId !== wall.id) continue;
        const t0 = o.offset / len;
        const t1 = (o.offset + o.width) / len;
        const p0 = horizontal ? ax + (bx - ax) * t0 : ay + (by - ay) * t0;
        const p1 = horizontal ? ax + (bx - ax) * t1 : ay + (by - ay) * t1;
        // A window blocks what would stand in front of it; a door blocks the full height.
        blocks.push({ s: Math.min(p0, p1) - 0.05, e: Math.max(p0, p1) + 0.05, y0: o.kind === "door" ? 0 : o.sill, y1: o.head });
      }
    }
    return { side, from, to, face: line + inward * (half + 0.02), blocks };
  }

  private inside(r: Rect, margin = 0.02) {
    const corners: Point[] = [
      [r.x0 + margin, r.y0 + margin],
      [r.x1 - margin, r.y0 + margin],
      [r.x0 + margin, r.y1 - margin],
      [r.x1 - margin, r.y1 - margin],
    ];
    return corners.every((c) => pointInPolygon(c, this.room.polygon));
  }

  free(r: Rect, margin = 0.02) {
    return this.inside(r, margin) && !this.obstacles.some((o) => overlaps(o, r));
  }

  /** Item placed back-to-wall on `side`, centered at `p` along it. */
  onWall(side: SideInfo, p: number, d: number): { x: number; y: number; rot: number } {
    const inward = side.side === "N" || side.side === "W" ? 1 : -1;
    const perp = side.face + (inward * d) / 2;
    const horizontal = side.side === "N" || side.side === "S";
    return { x: horizontal ? p : perp, y: horizontal ? perp : p, rot: ROT[side.side] };
  }

  /** Free length of a side for a height band, as intervals. */
  freeIntervals(side: SideInfo, y0: number, y1: number): [number, number][] {
    const blocks = side.blocks.filter((b) => b.y0 < y1 && y0 < b.y1).sort((a, b) => a.s - b.s);
    const out: [number, number][] = [];
    let cur = side.from;
    for (const b of blocks) {
      if (b.s > cur) out.push([cur, b.s]);
      cur = Math.max(cur, b.e);
    }
    if (cur < side.to) out.push([cur, side.to]);
    return out
      .map(([a, b]): [number, number] => [Math.max(a, side.from), Math.min(b, side.to)])
      .filter(([a, b]) => b - a > 0.05);
  }

  /** Depth of open floor in front of a wall position (until the opposite wall). */
  depthAt(side: SideInfo) {
    const b = this.bbox;
    return side.side === "N" || side.side === "S" ? b.y1 - b.y0 : b.x1 - b.x0;
  }

  /**
   * Find the best back-to-wall spot for an item. Candidate positions slide along every free
   * stretch of every side; `score` ranks them (higher is better), returning -Infinity to reject.
   */
  placeOnWall(
    kind: FurnishingKind,
    w: number,
    d: number,
    h: number,
    opts: {
      score?: (c: { side: SideInfo; p: number; x: number; y: number; rot: number; centered: number; corner: number }) => number;
      clearance?: number;
      sides?: SideInfo[];
      band?: [number, number];
      extra?: Partial<Furnishing>;
    } = {},
  ): Furnishing | null {
    const band = opts.band ?? [0, h];
    let best: { score: number; item: Furnishing; side: SideInfo; s: number; e: number } | null = null;
    for (const side of opts.sides ?? this.sides) {
      for (const [a, b] of this.freeIntervals(side, band[0], band[1])) {
        if (b - a < w) continue;
        const steps = Math.max(1, Math.floor((b - a - w) / 0.05));
        for (let i = 0; i <= steps; i++) {
          const p = a + w / 2 + ((b - a - w) * i) / steps;
          const pos = this.onWall(side, p, d);
          const fp = footprint({ ...pos, w, d });
          const front = opts.clearance ? this.frontRect(side, pos, w, d, opts.clearance) : null;
          if (!this.free(fp) || (front && !this.free(front, 0))) continue;
          const mid = (side.from + side.to) / 2;
          const centered = 1 - Math.abs(p - mid) / Math.max(0.01, (side.to - side.from) / 2);
          const corner = Math.min(p - w / 2 - side.from, side.to - (p + w / 2));
          const score = opts.score
            ? opts.score({ side, p, ...pos, centered, corner })
            : centered;
          if (score === -Infinity) continue;
          if (!best || score > best.score) {
            best = {
              score,
              side,
              s: p - w / 2,
              e: p + w / 2,
              item: { id: `${this.room.id}-${kind}-${this.n}`, kind, ...pos, w, d, h, seed: hash(`${this.room.id}${kind}${this.n}`), ...opts.extra },
            };
          }
        }
      }
    }
    if (!best) return null;
    this.n++;
    this.commit(best.item, best.side, band);
    return best.item;
  }

  /** Open floor directly in front of an item placed on a wall. */
  frontRect(side: SideInfo, pos: { x: number; y: number; rot: number }, w: number, d: number, depth: number): Rect {
    const dir = side.side === "N" ? [0, 1] : side.side === "S" ? [0, -1] : side.side === "W" ? [1, 0] : [-1, 0];
    const cx = pos.x + dir[0] * (d / 2 + depth / 2);
    const cy = pos.y + dir[1] * (d / 2 + depth / 2);
    return footprint({ x: cx, y: cy, rot: pos.rot, w, d: depth });
  }

  commit(item: Furnishing, side: SideInfo | null, band: [number, number] = [0, item.h]) {
    this.items.push(item);
    if (item.kind !== "rug" && item.kind !== "art" && item.kind !== "pendant") this.obstacles.push(footprint(item));
    if (side) {
      const horizontal = side.side === "N" || side.side === "S";
      const c = horizontal ? item.x : item.y;
      side.blocks.push({ s: c - item.w / 2, e: c + item.w / 2, y0: band[0], y1: band[1] });
    }
  }

  sideOf(item: Furnishing) {
    const side: Side = item.rot === 0 ? "N" : item.rot === Math.PI ? "S" : item.rot > 0 ? "W" : "E";
    return this.sides.find((s) => s.side === side)!;
  }

  opposite(side: SideInfo) {
    const o: Record<Side, Side> = { N: "S", S: "N", W: "E", E: "W" };
    return this.sides.find((s) => s.side === o[side.side])!;
  }

  /** Free-standing item: nearest free spot to a target point (with a clearance ring). */
  placeFree(kind: FurnishingKind, w: number, d: number, h: number, target: Point, clearance: number, extra: Partial<Furnishing> = {}) {
    const b = this.bbox;
    // Prefer the table's long side along the room's long side; turn it if that doesn't fit.
    const along = b.x1 - b.x0 >= b.y1 - b.y0 ? 0 : Math.PI / 2;
    let best: { dist: number; x: number; y: number; rot: number } | null = null;
    for (const rot of [along, along === 0 ? Math.PI / 2 : 0]) {
      for (let x = b.x0; x <= b.x1; x += 0.1) {
        for (let y = b.y0; y <= b.y1; y += 0.1) {
          const fp = footprint({ x, y, rot, w: w + 2 * clearance, d: d + 2 * clearance });
          if (!this.free(fp, 0)) continue;
          const dist = Math.hypot(x - target[0], y - target[1]) + (rot === along ? 0 : 0.5);
          if (!best || dist < best.dist) best = { dist, x, y, rot };
        }
      }
    }
    if (!best) return null;
    const item: Furnishing = {
      id: `${this.room.id}-${kind}-${this.n++}`,
      kind,
      x: best.x,
      y: best.y,
      rot: best.rot,
      w,
      d,
      h,
      seed: hash(`${this.room.id}${kind}${this.n}`),
      ...extra,
    };
    this.items.push(item);
    this.obstacles.push(footprint({ ...item, w: w + 2 * clearance, d: d + 2 * clearance }));
    return item;
  }

  /** Something in front of a wall item, centered on it (e.g. a coffee table before a sofa). */
  inFrontOf(anchor: Furnishing, kind: FurnishingKind, gap: number, w: number, d: number, h: number, obstacle = true) {
    const side = this.sideOf(anchor);
    const dir = side.side === "N" ? [0, 1] : side.side === "S" ? [0, -1] : side.side === "W" ? [1, 0] : [-1, 0];
    const off = anchor.d / 2 + gap + d / 2;
    const item: Furnishing = {
      id: `${this.room.id}-${kind}-${this.n++}`,
      kind,
      x: anchor.x + dir[0] * off,
      y: anchor.y + dir[1] * off,
      rot: anchor.rot,
      w,
      d,
      h,
      seed: hash(`${this.room.id}${kind}${this.n}`),
    };
    const fp = footprint(item);
    if (obstacle ? !this.free(fp) : !this.inside(fp)) return null;
    this.items.push(item);
    if (obstacle) this.obstacles.push(fp);
    return item;
  }

  /** Hang a picture on the wall above an item, if the wall is clear there. */
  artAbove(anchor: Furnishing, w: number, h: number, elevation: number) {
    const side = this.sideOf(anchor);
    const horizontal = side.side === "N" || side.side === "S";
    const c = horizontal ? anchor.x : anchor.y;
    const y0 = elevation - h / 2;
    const y1 = elevation + h / 2;
    const clear = this.freeIntervals(side, y0, y1).some(([a, b]) => a <= c - w / 2 && b >= c + w / 2);
    if (!clear) return null;
    const pos = this.onWall(side, c, 0.04);
    const item: Furnishing = { id: `${this.room.id}-art-${this.n++}`, kind: "art", ...pos, w, d: 0.04, h, elevation, seed: hash(`${this.room.id}art${this.n}`) };
    this.commit(item, side, [y0, y1]);
    return item;
  }

  /** A picture anywhere on a clear stretch of wall. */
  art(w: number, h: number, elevation = 1.55) {
    return this.placeOnWall("art", w, 0.04, h, {
      band: [elevation - h / 2, elevation + h / 2],
      extra: { elevation },
      score: (c) => c.centered + (c.side.to - c.side.from) * 0.1,
    });
  }

  corners(kind: FurnishingKind, size: number, h: number, count: number) {
    for (let i = 0; i < count; i++) {
      if (!this.placeOnWall(kind, size, size, h, { score: (c) => (c.corner < 0.25 ? 1 - c.corner : -Infinity) })) break;
    }
  }
}

/** Rects around each door, on both sides of its wall, that must stay clear for walking. */
function doorZones(plan: FloorPlan): Rect[] {
  const zones: Rect[] = [];
  for (const o of plan.openings) {
    if (o.kind !== "door") continue;
    const wall = plan.walls.find((w) => w.id === o.wallId);
    if (!wall) continue;
    const [ax, ay] = wall.a;
    const [bx, by] = wall.b;
    const len = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const c = o.offset + o.width / 2;
    const cx = ax + ux * c;
    const cy = ay + uy * c;
    const along = o.width + 0.1;
    const across = wall.thickness + 2 * DOOR_CLEARANCE;
    const horizontal = Math.abs(uy) < Math.abs(ux);
    zones.push(rectOf(cx, cy, horizontal ? along : across, horizontal ? across : along));
  }
  return zones;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function furnishLiving(L: RoomLayout, withKitchen: boolean, withDining: boolean) {
  if (withKitchen) furnishKitchenRun(L);

  // Sofa on the wall with the most open floor in front, not crammed against a corner.
  const longest = Math.max(...L.sides.map((s) => s.to - s.from));
  const sofaW = clamp(longest * 0.42, 1.7, 2.4);
  const sofa = L.placeOnWall("sofa", sofaW, 0.92, 0.85, {
    clearance: 1.6,
    score: (c) => c.centered * 2 + Math.min(L.depthAt(c.side), 5) - (c.side.blocks.some((b) => b.y0 === 0 && b.y1 > 1.6 && b.e - b.s > 1.8) ? 1 : 0),
  });
  if (sofa) {
    const table = L.inFrontOf(sofa, "coffeeTable", 0.45, sofaW * 0.5, 0.55, 0.42);
    const rug = L.inFrontOf(sofa, "rug", -0.25, sofaW + 0.6, 2.1, 0.01, false);
    L.artAbove(sofa, Math.min(1.3, sofaW * 0.6), 0.8, 1.6);
    // TV across from the sofa.
    const opp = L.opposite(L.sideOf(sofa));
    const target = L.sideOf(sofa).side === "N" || L.sideOf(sofa).side === "S" ? sofa.x : sofa.y;
    const tv = L.placeOnWall("tvUnit", 1.6, 0.42, 0.5, {
      sides: [opp],
      band: [0, 1.25],
      score: (c) => (Math.abs(c.p - target) < 0.8 ? -Math.abs(c.p - target) : -Infinity),
    });
    // Keep the floor between sofa and TV (or the far wall) open: no dining table in the sightline.
    const sb = footprint(sofa);
    const far = tv ? footprint(tv) : rug ? footprint(rug) : footprint(sofa);
    const side = L.sideOf(sofa).side;
    L.obstacles.push(
      side === "N" || side === "S"
        ? { x0: sb.x0, x1: sb.x1, y0: Math.min(sb.y0, far.y0), y1: Math.max(sb.y1, far.y1) }
        : { y0: sb.y0, y1: sb.y1, x0: Math.min(sb.x0, far.x0), x1: Math.max(sb.x1, far.x1) },
    );
    if (table) {
      // Armchair beside the coffee table, facing across it.
      const side = L.sideOf(sofa);
      const horizontal = side.side === "N" || side.side === "S";
      for (const s of [1, -1]) {
        const off = sofaW / 2 + 0.55;
        const item: Furnishing = {
          id: `${L.room.id}-armchair`,
          kind: "armchair",
          x: horizontal ? sofa.x + s * off : table.x,
          y: horizontal ? table.y : sofa.y + s * off,
          rot: horizontal ? (s > 0 ? -Math.PI / 2 : Math.PI / 2) : s > 0 ? Math.PI : 0,
          w: 0.85,
          d: 0.85,
          h: 0.8,
          seed: L.rand() * 1e9,
        };
        if (L.free(footprint(item))) {
          L.commit(item, null);
          break;
        }
      }
    }
    L.placeOnWall("floorLamp", 0.4, 0.4, 1.6, {
      sides: [L.sideOf(sofa)],
      band: [0, 0.6],
      score: (c) => -Math.abs(c.p - ((L.sideOf(sofa).side === "N" || L.sideOf(sofa).side === "S" ? sofa.x : sofa.y) + sofaW / 2 + 0.3)),
    });
  }
  if (withDining) furnishDiningTable(L);
  L.corners("plant", 0.5, 1.3, 2);
  L.art(0.7, 0.9);
}

function furnishKitchenRun(L: RoomLayout) {
  // Longest stretch of wall that stays clear up to counter height (windows over the sink are fine).
  let best: { side: (typeof L.sides)[number]; a: number; b: number } | null = null;
  for (const side of L.sides) {
    for (const [a, b] of L.freeIntervals(side, 0, 0.92)) {
      if (!best || b - a > best.b - best.a) best = { side, a, b };
    }
  }
  if (!best || best.b - best.a < 1.6) return;
  const len = Math.min(best.b - best.a, 3.6);
  const withFridge = best.b - best.a >= len + 0.72 || len >= 2.6;
  const runLen = withFridge && best.b - best.a < len + 0.72 ? len - 0.72 : len;
  const side = best.side;
  const start = best.a;
  const uppers = L.freeIntervals(side, 1.4, 2.2).some(([a, b]) => a <= start + 0.01 && b >= start + runLen - 0.01);
  const pos = L.onWall(side, start + runLen / 2, 0.62);
  const run: Furnishing = { id: `${L.room.id}-kitchen`, kind: "kitchen", ...pos, w: runLen, d: 0.62, h: 0.92, uppers, seed: L.rand() * 1e9 };
  if (!L.free(footprint(run))) return;
  L.commit(run, side, [0, uppers ? 2.2 : 0.92]);
  if (withFridge) {
    const fp = L.onWall(side, start + runLen + 0.36, 0.68);
    const fridge: Furnishing = { id: `${L.room.id}-fridge`, kind: "fridge", ...fp, w: 0.7, d: 0.68, h: 1.85, seed: 1 };
    if (L.free(footprint(fridge))) L.commit(fridge, side);
  }
}

function furnishDiningTable(L: RoomLayout) {
  const b = L.bbox;
  const center: Point = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
  const kitchen = L.items.find((i) => i.kind === "kitchen");
  const target: Point = kitchen ? [(kitchen.x + center[0]) / 2, (kitchen.y + center[1]) / 2] : center;
  for (const [w, d, chairs] of [
    [1.6, 0.9, 6],
    [1.2, 0.8, 4],
    [0.8, 0.8, 2],
  ] as const) {
    const t = L.placeFree("diningTable", w, d, 0.75, target, 0.6, { chairs });
    if (t) {
      L.commit({ ...t, id: `${t.id}-pendant`, kind: "pendant", w: 0.4, d: 0.4, h: 0.3, ceiling: L.plan.ceilingHeight }, null);
      return t;
    }
  }
  return null;
}

function furnishBedroom(L: RoomLayout) {
  const double = L.area >= 9.5;
  const bedW = double ? (L.area >= 14 ? 1.8 : 1.6) : 0.95;
  const bed = L.placeOnWall("bed", bedW, 2.08, 1.05, {
    clearance: 0.6,
    score: (c) => c.centered * 2 + (c.side.to - c.side.from) * 0.2,
  });
  if (bed) {
    const side = L.sideOf(bed);
    const horizontal = side.side === "N" || side.side === "S";
    const c = horizontal ? bed.x : bed.y;
    for (const s of double ? [1, -1] : [1]) {
      L.placeOnWall("nightstand", 0.45, 0.4, 0.55, {
        sides: [side],
        score: (k) => (Math.abs(k.p - (c + s * (bedW / 2 + 0.25))) < 0.08 ? 1 : -Infinity),
      });
    }
    L.inFrontOf(bed, "rug", -1.3, bedW + 1.0, 1.7, 0.01, false);
    L.artAbove(bed, Math.min(1.2, bedW * 0.75), 0.6, 1.55);
  }
  const wardrobeW = clamp(Math.max(...L.sides.map((s) => s.to - s.from)) * 0.4, 1.0, 2.2);
  for (const w of [wardrobeW, 1.2, 0.9]) {
    if (
      L.placeOnWall("wardrobe", w, 0.6, 2.2, {
        clearance: 0.7,
        score: (k) => (k.corner < 0.35 ? 2 : 0) - k.centered,
      })
    )
      break;
  }
  if (L.area >= 12) L.placeOnWall("desk", 1.1, 0.55, 0.75, { clearance: 0.7, score: (k) => (k.corner < 0.5 ? 1 : 0) });
  L.corners("plant", 0.45, 1.1, 1);
}

function furnishBathroom(L: RoomLayout) {
  const tub = L.area >= 4.2 ? L.placeOnWall("bathtub", 1.7, 0.75, 0.58, { score: (c) => (c.corner < 0.05 ? 2 : 0) + (c.side.to - c.side.from) * 0.1 }) : null;
  if (!tub) L.placeOnWall("shower", 0.9, 0.9, 2.0, { band: [0, 0.2], score: (c) => (c.corner < 0.05 ? 1 : -Infinity) });
  L.placeOnWall("vanity", 0.8, 0.48, 0.86, { band: [0, 2.0], clearance: 0.5, score: (c) => c.centered });
  L.placeOnWall("toilet", 0.42, 0.66, 0.8, { clearance: 0.5, score: (c) => (c.corner > 0.15 ? 1 - c.centered * 0.5 : -Infinity) });
  L.corners("plant", 0.3, 0.6, 1);
}

function furnishHallway(L: RoomLayout) {
  const console = L.placeOnWall("console", 1.0, 0.32, 0.8, { clearance: 0.6, score: (c) => c.centered });
  if (console) L.artAbove(console, 0.6, 0.85, 1.5);
  L.placeOnWall("bench", 1.0, 0.38, 0.45, { clearance: 0.6, score: (c) => c.corner });
  const b = L.bbox;
  const long = b.x1 - b.x0 >= b.y1 - b.y0;
  const len = Math.max(b.x1 - b.x0, b.y1 - b.y0) - 1.0;
  const short = Math.min(b.x1 - b.x0, b.y1 - b.y0);
  if (len > 1 && short > 1.1) {
    L.commit(
      { id: `${L.room.id}-runner`, kind: "rug", x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, rot: long ? Math.PI / 2 : 0, w: Math.min(0.8, short - 0.4), d: len, h: 0.01, seed: L.rand() * 1e9 },
      null,
    );
  }
  L.corners("plant", 0.4, 1.0, 1);
}

function furnishOffice(L: RoomLayout) {
  L.placeOnWall("desk", 1.4, 0.7, 0.75, { clearance: 0.8, score: (c) => c.centered });
  L.placeOnWall("bookshelf", 0.9, 0.35, 2.0, { score: (c) => (c.corner < 0.3 ? 1 : 0) });
  L.placeOnWall("bookshelf", 0.9, 0.35, 2.0, { score: (c) => (c.corner < 0.3 ? 1 : 0) });
  L.corners("plant", 0.45, 1.2, 1);
  L.art(0.8, 0.6);
}

function furnishDining(L: RoomLayout) {
  furnishDiningTable(L);
  L.placeOnWall("sideboard", 1.6, 0.45, 0.8, { score: (c) => c.centered });
  L.corners("plant", 0.5, 1.3, 1);
  L.art(1.0, 0.7);
}

function furnishBalcony(L: RoomLayout) {
  const b = L.bbox;
  // Railings along every edge that isn't a building wall.
  const edges: { a: Point; b: Point }[] = L.room.polygon.map((p, i) => ({ a: p, b: L.room.polygon[(i + 1) % L.room.polygon.length] }));
  edges.forEach((e, i) => {
    const onWall = L.plan.walls.some((w) => {
      const d = (p: Point) => {
        const [ax, ay] = w.a;
        const [bx, by] = w.b;
        const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const t = clamp(((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / len2, 0, 1);
        return Math.hypot(p[0] - (ax + t * (bx - ax)), p[1] - (ay + t * (by - ay)));
      };
      const mid: Point = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
      return d(e.a) < 0.2 && d(e.b) < 0.2 && d(mid) < 0.2;
    });
    if (onWall) return;
    const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
    const angle = Math.atan2(e.b[1] - e.a[1], e.b[0] - e.a[0]);
    L.commit(
      { id: `${L.room.id}-railing-${i}`, kind: "railing", x: (e.a[0] + e.b[0]) / 2, y: (e.a[1] + e.b[1]) / 2, rot: -angle, w: len, d: 0.05, h: 1.05, seed: i },
      null,
    );
  });
  const short = Math.min(b.x1 - b.x0, b.y1 - b.y0);
  if (short >= 1.1) L.placeFree("bistroSet", 1.3, 0.7, 0.75, [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2], 0.05);
  L.corners("plant", 0.45, 0.9, 2);
}

function furnishStorage(L: RoomLayout) {
  L.placeOnWall("shelves", Math.min(1.6, Math.max(...L.sides.map((s) => s.to - s.from)) - 0.2), 0.4, 2.0, { clearance: 0.5 });
}

/** Furniture for every room of a plan, except those in `skip` (e.g. rooms shown by photos). */
export function furnishPlan(plan: FloorPlan, skip: ReadonlySet<string> = new Set()): Furnishing[] {
  const zones = doorZones(plan);
  const out: Furnishing[] = [];
  for (const room of plan.rooms) {
    if (skip.has(room.id)) continue;
    const L = new RoomLayout(room, plan, zones);
    const name = room.name.toLowerCase();
    const kitchen = room.type === "kitchen" || name.includes("kitchen");
    switch (room.type) {
      case "living":
        furnishLiving(L, kitchen, name.includes("dining") || (kitchen && L.area >= 20));
        break;
      case "kitchen":
        furnishKitchenRun(L);
        if (L.area >= 9) furnishDiningTable(L);
        L.corners("plant", 0.35, 0.8, 1);
        break;
      case "dining":
        furnishDining(L);
        break;
      case "bedroom":
        furnishBedroom(L);
        break;
      case "bathroom":
        furnishBathroom(L);
        break;
      case "hallway":
        furnishHallway(L);
        break;
      case "office":
        furnishOffice(L);
        break;
      case "balcony":
        furnishBalcony(L);
        break;
      case "storage":
        furnishStorage(L);
        break;
      case "stairs":
        break;
    }
    out.push(...(room.type === "balcony" ? L.items.map((i) => ({ ...i, onBalcony: true })) : L.items));
  }
  return out;
}

/**
 * Where to stand when walking into a furnished room: a clear spot towards a corner, looking
 * diagonally across the room so the furniture is in view. Yaw in plan degrees (see PhotoPose).
 */
export function roomViewpoint(room: Room, items: Furnishing[]): { point: Point; yaw: number } | null {
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  const b = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const blocked = items
    .filter((i) => i.kind !== "rug" && i.kind !== "art" && i.kind !== "pendant" && i.kind !== "railing")
    .map((i) => {
      const r = footprint(i);
      const pad = i.kind === "diningTable" ? 0.75 : 0.3;
      return { x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad };
    });
  let best: { score: number; point: Point } | null = null;
  for (let x = b.x0 + 0.45; x <= b.x1 - 0.45; x += 0.1) {
    for (let y = b.y0 + 0.45; y <= b.y1 - 0.45; y += 0.1) {
      const ring: Point[] = [[x, y], [x + 0.35, y], [x - 0.35, y], [x, y + 0.35], [x, y - 0.35]];
      if (!ring.every((q) => pointInPolygon(q, room.polygon))) continue;
      if (blocked.some((r) => x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1)) continue;
      const score = Math.hypot(x - cx, y - cy);
      if (!best || score > best.score) best = { score, point: [x, y] };
    }
  }
  if (!best) return null;
  const [px, py] = best.point;
  return { point: best.point, yaw: (Math.atan2(cy - py, cx - px) * 180) / Math.PI };
}
