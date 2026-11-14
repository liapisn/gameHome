import { type FloorPlan, type Point, type Room, polygonArea, polygonCentroid } from "@/lib/floorplan";

/**
 * Named points on a plan that are easy to spot in a photo: wall corners and the two jambs
 * of every door/window. The model refers to them by id; code owns the coordinates.
 * Labels are written the way a person reads the drawing ("top-right corner of the Kitchen"),
 * because vision models match those far more reliably than raw coordinates.
 */
export interface PlanFeature {
  id: string;
  kind: "corner" | "door-jamb" | "window-jamb";
  point: Point;
  label: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const key = ([x, y]: Point) => `${r2(x)},${r2(y)}`;
const NEAR = 0.2; // m

function distToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

/** Rooms whose outline passes within NEAR of the point. */
function roomsAt(plan: FloorPlan, p: Point): Room[] {
  return plan.rooms.filter((r) =>
    r.polygon.some((a, i) => distToSegment(p, a, r.polygon[(i + 1) % r.polygon.length]) < NEAR),
  );
}

/** "top-left", "bottom", … position of a point relative to a room, as seen on the drawing. */
function sideOf(room: Room, [x, y]: Point): string {
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const tolX = (maxX - minX) * 0.2;
  const tolY = (maxY - minY) * 0.2;
  const v = y <= minY + tolY ? "top" : y >= maxY - tolY ? "bottom" : "";
  const h = x <= minX + tolX ? "left" : x >= maxX - tolX ? "right" : "";
  return [v, h].filter(Boolean).join("-") || "middle";
}

export function planFeatures(plan: FloorPlan): PlanFeature[] {
  const features: PlanFeature[] = [];

  // Corners: polygon vertices, merged across the rooms that share them.
  const corners = new Map<string, Point>();
  for (const room of plan.rooms) for (const p of room.polygon) corners.set(key(p), [r2(p[0]), r2(p[1])]);
  let c = 0;
  for (const point of corners.values()) {
    const where = roomsAt(plan, point)
      .filter((r) => r.polygon.some((q) => Math.hypot(q[0] - point[0], q[1] - point[1]) < NEAR))
      .map((r) => `${sideOf(r, point)} corner of ${r.name} (${r.id})`);
    features.push({ id: `C${++c}`, kind: "corner", point, label: where.join("; ") });
  }

  // Openings: both jambs, so a door frame gives two sharp vertical edges.
  for (const o of plan.openings) {
    const wall = plan.walls.find((w) => w.id === o.wallId);
    if (!wall) continue;
    const [ax, ay] = wall.a;
    const [bx, by] = wall.b;
    const len = Math.hypot(bx - ax, by - ay);
    const at = (d: number): Point => [r2(ax + ((bx - ax) * d) / len), r2(ay + ((by - ay) * d) / len)];
    const ja = at(o.offset);
    const jb = at(o.offset + o.width);
    const mid = at(o.offset + o.width / 2);

    const rooms = roomsAt(plan, mid);
    const what = o.kind === "window" ? "window" : "door";
    const place =
      rooms.length >= 2
        ? `between ${rooms.map((r) => r.name).join(" and ")}`
        : rooms.length === 1
          ? `in the ${sideOf(rooms[0], mid)} wall of ${rooms[0].name} (exterior)`
          : "on an exterior wall";
    // Name each jamb by which end of the opening it is on the drawing.
    const vertical = Math.abs(bx - ax) < Math.abs(by - ay);
    const [first, second] = vertical
      ? ja[1] < jb[1] ? ["upper", "lower"] : ["lower", "upper"]
      : ja[0] < jb[0] ? ["left", "right"] : ["right", "left"];
    const kind = o.kind === "window" ? "window-jamb" : "door-jamb";
    features.push({ id: `${o.id}:a`, kind, point: ja, label: `${first} jamb of the ${what} ${place}` });
    features.push({ id: `${o.id}:b`, kind, point: jb, label: `${second} jamb of the ${what} ${place}` });
  }
  return features;
}

/** Plan as compact text for a prompt: rooms with outlines, then the feature table. */
export function describePlan(levelId: string, levelName: string, plan: FloorPlan, features: PlanFeature[]): string {
  const lines = [`LEVEL ${levelId} — ${levelName}`, "Rooms (id · name · type · area · center · outline in meters):"];
  for (const r of plan.rooms) {
    const [cx, cy] = polygonCentroid(r.polygon);
    lines.push(
      `  ${r.id} · ${r.name} · ${r.type} · ${polygonArea(r.polygon).toFixed(1)} m² · (${r2(cx)},${r2(cy)}) · ${r.polygon.map((p) => `(${key(p)})`).join(" ")}`,
    );
  }
  lines.push("Features (id · x,y · description):");
  for (const f of features) lines.push(`  ${f.id} · ${f.point[0]},${f.point[1]} · ${f.label}`);
  return lines.join("\n");
}
