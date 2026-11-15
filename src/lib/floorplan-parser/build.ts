import { type FloorPlan, type Opening, type Point, type Room, type Wall, uniqueRoomNames } from "@/lib/floorplan";
import type { ParsedPlan } from "./schema";

const SNAP_TOLERANCE = 0.15; // m: coordinates closer than this are treated as the same wall line
const EXTERIOR_THICKNESS = 0.25;
const INTERIOR_THICKNESS = 0.1;
const MAX_OPENING_DISTANCE = 0.6; // m: openings further than this from any wall are dropped

const round = (n: number) => Math.round(n * 100) / 100;

/** Cluster nearby values and map each value to its cluster mean. */
function snapper(values: number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && v - last[last.length - 1] <= SNAP_TOLERANCE) last.push(v);
    else clusters.push([v]);
  }
  const map = new Map<number, number>();
  for (const c of clusters) {
    const mean = round(c.reduce((s, x) => s + x, 0) / c.length);
    for (const v of c) map.set(v, mean);
  }
  return (v) => map.get(v) ?? round(v);
}

interface Interval {
  a: number;
  b: number;
  room: string;
}

/**
 * Derive walls from room outlines. Axis-aligned edges on the same line are merged,
 * and each stretch is exterior if only one room borders it, interior if two or more do.
 * Balconies don't produce walls.
 */
function wallsFromRooms(rooms: Room[]): Wall[] {
  const horizontal = new Map<number, Interval[]>(); // y -> x-intervals
  const vertical = new Map<number, Interval[]>(); // x -> y-intervals
  const diagonal = new Map<string, { a: Point; b: Point; rooms: Set<string> }>();

  for (const room of rooms) {
    if (room.type === "balcony") continue;
    const poly = room.polygon;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      if (x1 === x2 && y1 === y2) continue;
      if (y1 === y2) {
        const list = horizontal.get(y1) ?? [];
        list.push({ a: Math.min(x1, x2), b: Math.max(x1, x2), room: room.id });
        horizontal.set(y1, list);
      } else if (x1 === x2) {
        const list = vertical.get(x1) ?? [];
        list.push({ a: Math.min(y1, y2), b: Math.max(y1, y2), room: room.id });
        vertical.set(x1, list);
      } else {
        const [p, q] = [poly[i], poly[(i + 1) % poly.length]].sort((m, n) => m[0] - n[0] || m[1] - n[1]);
        const key = `${p}|${q}`;
        const entry = diagonal.get(key) ?? { a: p, b: q, rooms: new Set<string>() };
        entry.rooms.add(room.id);
        diagonal.set(key, entry);
      }
    }
  }

  const walls: Wall[] = [];
  const push = (a: Point, b: Point, exterior: boolean) =>
    walls.push({
      id: `w${walls.length}`,
      a,
      b,
      thickness: exterior ? EXTERIOR_THICKNESS : INTERIOR_THICKNESS,
      exterior,
    });

  const sweep = (lines: Map<number, Interval[]>, toPoint: (along: number, at: number) => Point) => {
    for (const [at, intervals] of lines) {
      const cuts = [...new Set(intervals.flatMap((iv) => [iv.a, iv.b]))].sort((m, n) => m - n);
      let run: { a: number; b: number; exterior: boolean } | null = null;
      for (let i = 0; i < cuts.length - 1; i++) {
        const [a, b] = [cuts[i], cuts[i + 1]];
        const mid = (a + b) / 2;
        const covering = new Set(intervals.filter((iv) => iv.a <= mid && iv.b >= mid).map((iv) => iv.room));
        if (covering.size === 0) {
          if (run) push(toPoint(run.a, at), toPoint(run.b, at), run.exterior);
          run = null;
          continue;
        }
        const exterior = covering.size === 1;
        if (run && run.exterior === exterior && run.b === a) run.b = b;
        else {
          if (run) push(toPoint(run.a, at), toPoint(run.b, at), run.exterior);
          run = { a, b, exterior };
        }
      }
      if (run) push(toPoint(run.a, at), toPoint(run.b, at), run.exterior);
    }
  };

  sweep(horizontal, (x, y) => [x, y]);
  sweep(vertical, (y, x) => [x, y]);
  for (const d of diagonal.values()) push(d.a, d.b, d.rooms.size === 1);
  return walls;
}

function nearestWall(walls: Wall[], x: number, y: number) {
  let best: { wall: Wall; dist: number; along: number; length: number } | null = null;
  for (const wall of walls) {
    const [ax, ay] = wall.a;
    const [bx, by] = wall.b;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (length * length)));
    const dist = Math.hypot(ax + t * dx - x, ay + t * dy - y);
    if (!best || dist < best.dist) best = { wall, dist, along: t * length, length };
  }
  return best;
}

export interface BuildReport {
  warnings: string[];
  dimensionChecks: { room: string; labeled: [number, number]; built: [number, number]; error: number }[];
  droppedOpenings: number;
}

export function buildFloorPlan(
  parsed: ParsedPlan,
  meta: { id: string; title: string; ceilingHeight?: number; source?: FloorPlan["source"] },
): { plan: FloorPlan; report: BuildReport } {
  const warnings = [...parsed.warnings];

  // 1. Snap coordinates so shared walls line up exactly.
  const snapX = snapper(parsed.rooms.flatMap((r) => r.polygon.map((p) => p.x)));
  const snapY = snapper(parsed.rooms.flatMap((r) => r.polygon.map((p) => p.y)));

  const rooms: Room[] = parsed.rooms
    .filter((r) => r.polygon.length >= 3)
    .map((r, i) => {
      const polygon = r.polygon
        .map((p): Point => [snapX(p.x), snapY(p.y)])
        .filter((p, j, arr) => j === 0 || p[0] !== arr[j - 1][0] || p[1] !== arr[j - 1][1]);
      return {
        id: `r${i}`,
        name: titleCase(r.name),
        type: r.type,
        polygon,
        ...(r.labeledWidth && r.labeledDepth
          ? { labeled: { width: r.labeledWidth, depth: r.labeledDepth } }
          : {}),
      };
    });

  // Photos are matched to rooms by name: no two rooms share one ("Bedroom 1", "Bedroom 2").
  uniqueRoomNames(rooms);

  // 2. Shift so the plan starts at (0, 0).
  const minX = Math.min(...rooms.flatMap((r) => r.polygon.map((p) => p[0])));
  const minY = Math.min(...rooms.flatMap((r) => r.polygon.map((p) => p[1])));
  for (const r of rooms) r.polygon = r.polygon.map(([x, y]) => [round(x - minX), round(y - minY)]);

  // 3. Walls from room edges.
  const walls = wallsFromRooms(rooms);

  // 4. Snap openings onto their nearest wall.
  const openings: Opening[] = [];
  let droppedOpenings = 0;
  for (const o of parsed.openings) {
    const hit = nearestWall(walls, o.x - minX, o.y - minY);
    if (!hit || hit.dist > MAX_OPENING_DISTANCE) {
      droppedOpenings++;
      warnings.push(`Dropped ${o.kind} (${o.note}): no wall within ${MAX_OPENING_DISTANCE} m`);
      continue;
    }
    const width = Math.min(o.width, hit.length);
    const offset = round(Math.max(0, Math.min(hit.length - width, hit.along - width / 2)));
    const isWindow = o.kind === "window";
    openings.push({
      id: `o${openings.length}`,
      wallId: hit.wall.id,
      kind: isWindow ? "window" : "door",
      offset,
      width: round(width),
      sill: isWindow ? 0.9 : 0,
      head: 2.1,
    });
  }

  // 5. Compare built rooms with their printed dimensions.
  const dimensionChecks = rooms
    .filter((r) => r.labeled)
    .map((r) => {
      const xs = r.polygon.map((p) => p[0]);
      const ys = r.polygon.map((p) => p[1]);
      const built = [round(Math.max(...xs) - Math.min(...xs)), round(Math.max(...ys) - Math.min(...ys))].sort(
        (a, b) => a - b,
      ) as [number, number];
      const labeled = [r.labeled!.width, r.labeled!.depth].sort((a, b) => a - b) as [number, number];
      const error = round(Math.max(Math.abs(built[0] - labeled[0]), Math.abs(built[1] - labeled[1])));
      return { room: r.name, labeled, built, error };
    });

  return {
    plan: {
      id: meta.id,
      title: meta.title,
      ceilingHeight: meta.ceilingHeight ?? 2.7,
      source: meta.source,
      walls,
      openings,
      rooms,
    },
    report: { warnings, dimensionChecks, droppedOpenings },
  };
}

function titleCase(s: string) {
  return s
    .toLowerCase()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase())
    .trim();
}
