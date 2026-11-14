/**
 * Structured floor plan geometry — the core asset of gameHome.
 * Units are meters. Plan space: x → right, y → down (as drawn on paper).
 * In 3D, plan (x, y) maps to world (x, 0, y).
 */

export type Point = [number, number];

export const ROOM_TYPES = [
  "living",
  "kitchen",
  "dining",
  "bedroom",
  "bathroom",
  "hallway",
  "office",
  "storage",
  "stairs",
  "balcony",
] as const;

export type RoomType = (typeof ROOM_TYPES)[number];

/** Room kinds that share one open space often enough that a photo can't tell them apart. */
export const OPEN_PLAN: RoomType[][] = [["living", "dining", "kitchen"], ["hallway", "stairs"], ["office", "bedroom"]];

export interface Wall {
  id: string;
  a: Point;
  b: Point;
  thickness: number;
  exterior?: boolean;
}

export interface Opening {
  id: string;
  wallId: string;
  kind: "door" | "window";
  /** Distance in meters from wall.a to the start of the opening. */
  offset: number;
  width: number;
  /** Bottom of the opening (0 for doors). */
  sill: number;
  /** Top of the opening. */
  head: number;
}

export interface Room {
  id: string;
  name: string;
  type: RoomType;
  polygon: Point[];
  /** Dimensions printed on the source plan, if any (meters). */
  labeled?: { width: number; depth: number };
}

export interface FloorPlan {
  id: string;
  title: string;
  ceilingHeight: number;
  /** Where the geometry came from. */
  source?: { kind: "manual" | "parsed"; image?: string; model?: string; parsedAt?: string };
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
}

/** Shoelace formula. */
export function polygonArea(poly: Point[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function polygonCentroid(poly: Point[]): Point {
  const n = poly.length;
  const x = poly.reduce((s, p) => s + p[0], 0) / n;
  const y = poly.reduce((s, p) => s + p[1], 0) / n;
  return [x, y];
}

export function planBounds(plan: FloorPlan) {
  const pts = plan.rooms.flatMap((r) => r.polygon);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

export function interiorArea(plan: FloorPlan): number {
  return plan.rooms
    .filter((r) => r.type !== "balcony")
    .reduce((s, r) => s + polygonArea(r.polygon), 0);
}


/** A hand-authored 78 m² two-bedroom apartment, standing in for parser output. */
export const demoPlan: FloorPlan = {
  id: "demo-athens-2br",
  title: "2-bedroom apartment · Koukaki, Athens",
  ceilingHeight: 2.7,
  walls: [
    { id: "w-top", a: [0, 0], b: [10, 0], thickness: 0.25, exterior: true },
    { id: "w-right", a: [10, 0], b: [10, 7.8], thickness: 0.25, exterior: true },
    { id: "w-bottom", a: [10, 7.8], b: [0, 7.8], thickness: 0.25, exterior: true },
    { id: "w-left", a: [0, 7.8], b: [0, 0], thickness: 0.25, exterior: true },
    { id: "w-living-bed1", a: [6, 0], b: [6, 4.5], thickness: 0.12 },
    { id: "w-mid", a: [0, 4.5], b: [10, 4.5], thickness: 0.12 },
    { id: "w-bath-hall", a: [2.5, 4.5], b: [2.5, 7.8], thickness: 0.12 },
    { id: "w-hall-bed2", a: [4.5, 4.5], b: [4.5, 7.8], thickness: 0.12 },
  ],
  openings: [
    { id: "o-balcony", wallId: "w-top", kind: "door", offset: 2, width: 1.6, sill: 0, head: 2.2 },
    { id: "o-bed1-win", wallId: "w-top", kind: "window", offset: 7.2, width: 1.4, sill: 0.9, head: 2.1 },
    { id: "o-bed1-win2", wallId: "w-right", kind: "window", offset: 1.5, width: 1.2, sill: 0.9, head: 2.1 },
    { id: "o-bed2-win", wallId: "w-right", kind: "window", offset: 5.2, width: 1.4, sill: 0.9, head: 2.1 },
    { id: "o-bed2-win2", wallId: "w-bottom", kind: "window", offset: 2.5, width: 1.6, sill: 0.9, head: 2.1 },
    { id: "o-entrance", wallId: "w-bottom", kind: "door", offset: 6.0, width: 1.0, sill: 0, head: 2.1 },
    { id: "o-bath-win", wallId: "w-bottom", kind: "window", offset: 8.2, width: 0.6, sill: 1.5, head: 2.0 },
    { id: "o-living-win", wallId: "w-left", kind: "window", offset: 4.5, width: 1.4, sill: 0.9, head: 2.1 },
    { id: "o-bed1-door", wallId: "w-living-bed1", kind: "door", offset: 3.4, width: 0.9, sill: 0, head: 2.1 },
    { id: "o-hall-living", wallId: "w-mid", kind: "door", offset: 2.8, width: 1.2, sill: 0, head: 2.1 },
    { id: "o-bath-door", wallId: "w-bath-hall", kind: "door", offset: 0.6, width: 0.8, sill: 0, head: 2.1 },
    { id: "o-bed2-door", wallId: "w-hall-bed2", kind: "door", offset: 0.8, width: 0.9, sill: 0, head: 2.1 },
  ],
  rooms: [
    { id: "r-living", name: "Living & Kitchen", type: "living", polygon: [[0, 0], [6, 0], [6, 4.5], [0, 4.5]] },
    { id: "r-bed1", name: "Master bedroom", type: "bedroom", polygon: [[6, 0], [10, 0], [10, 4.5], [6, 4.5]] },
    { id: "r-bath", name: "Bathroom", type: "bathroom", polygon: [[0, 4.5], [2.5, 4.5], [2.5, 7.8], [0, 7.8]] },
    { id: "r-hall", name: "Entrance hall", type: "hallway", polygon: [[2.5, 4.5], [4.5, 4.5], [4.5, 7.8], [2.5, 7.8]] },
    { id: "r-bed2", name: "Bedroom 2", type: "bedroom", polygon: [[4.5, 4.5], [10, 4.5], [10, 7.8], [4.5, 7.8]] },
    { id: "r-balcony", name: "Balcony", type: "balcony", polygon: [[0, -1.6], [6, -1.6], [6, 0], [0, 0]] },
  ],
};
