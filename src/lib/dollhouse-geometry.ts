/**
 * Pure three.js geometry for a FloorPlan: shared by the R3F viewer and the .glb exporter.
 *
 * The exported scene follows a naming contract that downstream tools (Unreal, Blender) rely on:
 *   meshes     floor__<roomType>__<roomId>  ceiling__<roomId>  wall__<interior|exterior>__<wallId>  glass__<openingId>
 *   materials  M_floor_<roomType>  M_ceiling  M_wall_interior  M_wall_exterior  M_glass
 * Ids are sanitised to [A-Za-z0-9_]. All vertices are baked in world space (meters, Y-up),
 * so every node has an identity transform and pivots sit at the plan origin.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { type FloorPlan, type Opening, type RoomType, type Wall, polygonArea } from "./floorplan";

export const ROOM_COLORS: Record<RoomType, string> = {
  living: "#e9dcc6",
  kitchen: "#efd9bf",
  dining: "#e9dcc6",
  office: "#e4dccd",
  stairs: "#d6d0c6",
  bedroom: "#d9e2d3",
  bathroom: "#d3e0e6",
  hallway: "#e6e1d9",
  balcony: "#c9bba8",
  storage: "#e1ddd6",
};

export const WALL_COLOR = "#f7f4ee";
export const GLASS_COLOR = "#a9c7d6";
export const CEILING_COLOR = "#fbfaf7";
/** Balcony slab sits slightly below the interior floor. */
export const BALCONY_DROP = 0.05;

export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Split a wall into solid boxes (in wall-local coords) around its openings. */
export function wallBoxes(wall: Wall, openings: Opening[], height: number, length: number): Box[] {
  const ext = wall.thickness / 2;
  const ops = openings
    .filter((o) => o.wallId === wall.id)
    .sort((p, q) => p.offset - q.offset);

  const boxes: Box[] = [];
  let cursor = -ext;
  for (const o of ops) {
    const start = o.offset;
    const end = o.offset + o.width;
    if (start > cursor) boxes.push({ x0: cursor, x1: start, y0: 0, y1: height });
    if (o.sill > 0) boxes.push({ x0: start, x1: end, y0: 0, y1: o.sill });
    if (o.head < height) boxes.push({ x0: start, x1: end, y0: o.head, y1: height });
    cursor = end;
  }
  if (cursor < length + ext) boxes.push({ x0: cursor, x1: length + ext, y0: 0, y1: height });
  return boxes;
}

/** Wall-local → world: origin at wall.a, local +x along the wall, rotated about Y. */
export function wallFrame(wall: Wall) {
  const [ax, ay] = wall.a;
  const [bx, by] = wall.b;
  const dx = bx - ax;
  const dy = by - ay;
  return { length: Math.hypot(dx, dy), angle: -Math.atan2(dy, dx), origin: [ax, 0, ay] as [number, number, number] };
}

const safeId = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");

/** Room polygon as a horizontal slab at height y, facing up (floor) or down (ceiling). */
function slabGeometry(polygon: [number, number][], y: number, facing: "up" | "down") {
  // Plan (x, y) → world (x, 0, y). Negating y before rotating by -90° about X gives an
  // upward normal; the un-negated shape rotated by +90° gives a downward one.
  const sign = facing === "up" ? -1 : 1;
  const shape = new THREE.Shape(polygon.map(([x, py]) => new THREE.Vector2(x, sign * py)));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(facing === "up" ? -Math.PI / 2 : Math.PI / 2);
  geo.translate(0, y, 0);
  return geo;
}

function wallGeometry(wall: Wall, plan: FloorPlan) {
  const { length, angle, origin } = wallFrame(wall);
  const frame = new THREE.Matrix4()
    .makeTranslation(...origin)
    .multiply(new THREE.Matrix4().makeRotationY(angle));
  const parts = wallBoxes(wall, plan.openings, plan.ceilingHeight, length).map((b) => {
    const g = new THREE.BoxGeometry(b.x1 - b.x0, b.y1 - b.y0, wall.thickness);
    g.translate((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 0);
    return g.applyMatrix4(frame);
  });
  const merged = mergeGeometries(parts);
  parts.forEach((g) => g.dispose());
  return { merged, frame };
}

export interface BuildOptions {
  /** Add a ceiling slab per interior room (needed for interior renders, not for the dollhouse view). */
  ceilings?: boolean;
}

export function buildDollhouseScene(plan: FloorPlan, opts: BuildOptions = {}): THREE.Scene {
  const scene = new THREE.Scene();
  scene.name = `dollhouse__${safeId(plan.id)}`;
  scene.userData = { planId: plan.id, title: plan.title, ceilingHeight: plan.ceilingHeight, units: "meters" };

  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const material = (name: string, params: THREE.MeshStandardMaterialParameters) => {
    let m = materials.get(name);
    if (!m) {
      m = new THREE.MeshStandardMaterial(params);
      m.name = name;
      materials.set(name, m);
    }
    return m;
  };
  const add = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, userData: object) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    geo.name = name;
    mesh.userData = userData;
    scene.add(mesh);
  };

  for (const room of plan.rooms) {
    const isBalcony = room.type === "balcony";
    const meta = { kind: "floor", roomId: room.id, roomName: room.name, roomType: room.type, areaM2: +polygonArea(room.polygon).toFixed(2) };
    add(
      `floor__${room.type}__${safeId(room.id)}`,
      slabGeometry(room.polygon, isBalcony ? -BALCONY_DROP : 0, "up"),
      material(`M_floor_${room.type}`, { color: ROOM_COLORS[room.type], roughness: 0.95 }),
      meta,
    );
    if (opts.ceilings && !isBalcony) {
      add(
        `ceiling__${safeId(room.id)}`,
        slabGeometry(room.polygon, plan.ceilingHeight, "down"),
        material("M_ceiling", { color: CEILING_COLOR, roughness: 0.95 }),
        { ...meta, kind: "ceiling" },
      );
    }
  }

  for (const wall of plan.walls) {
    const side = wall.exterior ? "exterior" : "interior";
    const { merged, frame } = wallGeometry(wall, plan);
    add(`wall__${side}__${safeId(wall.id)}`, merged, material(`M_wall_${side}`, { color: WALL_COLOR, roughness: 0.9 }), {
      kind: "wall",
      wallId: wall.id,
      exterior: !!wall.exterior,
    });

    for (const o of plan.openings.filter((o) => o.wallId === wall.id && o.kind === "window")) {
      const g = new THREE.BoxGeometry(o.width, o.head - o.sill, 0.02);
      g.translate(o.offset + o.width / 2, (o.sill + o.head) / 2, 0);
      g.applyMatrix4(frame);
      add(
        `glass__${safeId(o.id)}`,
        g,
        material("M_glass", { color: GLASS_COLOR, transparent: true, opacity: 0.35, roughness: 0.05 }),
        { kind: "glass", openingId: o.id, wallId: wall.id },
      );
    }
  }

  return scene;
}
