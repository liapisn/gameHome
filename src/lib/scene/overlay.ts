/**
 * Drawing over photos (pure Node: sharp + SVG) and a top-down view of a room.
 * Same camera model as the lift (project.ts), so what's drawn is what the scene says.
 */
import sharp from "sharp";
import type { FloorPlan, Point, Room } from "@/lib/floorplan";
import { BOX_EDGES, boxCorners, photoCamera, projectSegment, type PhotoCamera, type V3 } from "./project";
import { itemBox } from "./lift";
import type { SceneItem } from "./types";

export const OVERLAY_WIDTH = 1280;

const PALETTE = ["#ff1744", "#00e5ff", "#ffea00", "#76ff03", "#ff9100", "#d500f9", "#2979ff", "#ff4081", "#1de9b6", "#ffc400"];
export const colorFor = (i: number) => PALETTE[i % PALETTE.length];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export async function loadPhoto(file: string, width = OVERLAY_WIDTH) {
  const img = sharp(file).rotate().resize(width);
  const { data, info } = await img.jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true });
  return { jpeg: data, width: info.width, height: info.height };
}

function polyline(cam: PhotoCamera, W: number, H: number, a: V3, b: V3, color: string, width = 3, dash = "") {
  return projectSegment(cam, a, b)
    .map((run) => `<polyline points="${run.map(([u, v]) => `${(u * W).toFixed(1)},${(v * H).toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="${width}" stroke-opacity="0.95"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`)
    .join("");
}

function tag(x: number, y: number, text: string, color: string, size = 20) {
  const w = text.length * size * 0.6 + 12;
  return `<rect x="${x.toFixed(0)}" y="${(y - size - 4).toFixed(0)}" width="${w.toFixed(0)}" height="${size + 10}" rx="4" fill="#000" fill-opacity="0.72"/>` +
    `<text x="${(x + 6).toFixed(0)}" y="${y.toFixed(0)}" font-size="${size}" font-family="Helvetica, Arial" font-weight="bold" fill="${color}">${esc(text)}</text>`;
}

/** 3D boxes of the items drawn on a photo, each labelled with its id. */
export async function boxesOverlay(opts: {
  photoFile: string;
  cam: PhotoCamera;
  items: SceneItem[];
  title?: string;
}): Promise<Buffer> {
  const { jpeg, width: W, height: H } = await loadPhoto(opts.photoFile);
  let svg = "";
  let tags = "";
  opts.items.forEach((it, i) => {
    const b = itemBox(it);
    const c = boxCorners(b.x0, b.y0, b.x1, b.y1, b.z0, b.z1);
    const color = colorFor(i);
    for (const [p, q] of BOX_EDGES) svg += polyline(opts.cam, W, H, c[p], c[q], color, 3, it.source === "rules" ? "10 6" : "");
    // Label at the projected top centre (or the nearest visible top corner).
    const anchors: V3[] = [[(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z1], ...c.slice(4)];
    for (const a of anchors) {
      const uv = opts.cam.project(a, 0.3);
      if (uv && uv[0] > 0.02 && uv[0] < 0.92 && uv[1] > 0.04 && uv[1] < 0.98) {
        tags += tag(uv[0] * W, uv[1] * H, it.id, color);
        break;
      }
    }
  });
  if (opts.title) tags += tag(8, 30, opts.title, "#fff", 22);
  return sharp(jpeg)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${svg}${tags}</svg>`) }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Walls whose centreline runs along an edge of the room's outline. */
export function roomWalls(plan: FloorPlan, room: Room) {
  /** `span`: the stretch of the wall (distance from wall.a) that bounds this room. */
  const out: { wall: FloorPlan["walls"][number]; inward: Point; span: [number, number] }[] = [];
  const poly = room.polygon;
  for (const wall of plan.walls) {
    const [ax, ay] = wall.a;
    const [bx, by] = wall.b;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.05) continue;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      // Collinear (both ends of the edge on the wall line) and overlapping.
      const off = (pt: Point) => Math.abs((pt[0] - ax) * uy - (pt[1] - ay) * ux);
      if (off(p) > 0.2 || off(q) > 0.2) continue;
      const t = (pt: Point) => (pt[0] - ax) * ux + (pt[1] - ay) * uy;
      const [e0, e1] = [Math.min(t(p), t(q)), Math.max(t(p), t(q))];
      if (Math.min(e1, len) - Math.max(e0, 0) < 0.2) continue;
      // Inward normal: towards the room.
      const mid: Point = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const n: Point = [-uy, ux];
      const probe: Point = [mid[0] + n[0] * 0.1, mid[1] + n[1] * 0.1];
      const inside = pointIn(probe, poly);
      out.push({ wall, inward: inside ? n : [-n[0], -n[1]], span: [Math.max(e0, 0), Math.min(e1, len)] });
      break;
    }
  }
  return out;
}

function pointIn([x, y]: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The room as the stored pose says the photo sees it: ceiling (red), floor (blue) and corner
 * (yellow) lines, and each door/window drawn on its wall face with an id. For the gate.
 */
export async function outlineOverlay(opts: { photoFile: string; cam: PhotoCamera; plan: FloorPlan; room: Room; ceiling: number }) {
  const { jpeg, width: W, height: H } = await loadPhoto(opts.photoFile);
  const { cam, plan, room, ceiling } = opts;
  let svg = "";
  let tags = "";
  room.polygon.forEach(([ax, ay], i) => {
    const [bx, by] = room.polygon[(i + 1) % room.polygon.length];
    svg += polyline(cam, W, H, [ax, ay, ceiling], [bx, by, ceiling], "#ff1744", 4);
    svg += polyline(cam, W, H, [ax, ay, 0], [bx, by, 0], "#2979ff", 4);
    svg += polyline(cam, W, H, [ax, ay, 0], [ax, ay, ceiling], "#ffea00", 4);
  });
  const openings: { id: string; kind: string; visible: boolean; inFrame: boolean }[] = [];
  for (const { wall, inward, span } of roomWalls(plan, room)) {
    const [ax, ay] = wall.a;
    const [bx, by] = wall.b;
    const len = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const shift = wall.thickness / 2;
    // Only openings on this room's stretch of the wall (walls often run on past the room).
    const mine = plan.openings.filter(
      (op) => op.wallId === wall.id && Math.min(op.offset + op.width, span[1]) - Math.max(op.offset, span[0]) >= op.width * 0.5,
    );
    for (const o of mine) {
      const at = (s: number, z: number): V3 => [ax + ux * s + inward[0] * shift, ay + uy * s + inward[1] * shift, z];
      const c = [at(o.offset, o.sill), at(o.offset + o.width, o.sill), at(o.offset + o.width, o.head), at(o.offset, o.head)];
      const color = o.kind === "door" ? "#00e676" : "#e040fb";
      for (let k = 0; k < 4; k++) svg += polyline(cam, W, H, c[k], c[(k + 1) % 4], color, 4, "12 6");
      const mid = at(o.offset + o.width / 2, (o.sill + o.head) / 2);
      const uv = cam.project(mid, 0.3);
      const visible = !!uv && uv[0] > 0 && uv[0] < 1 && uv[1] > 0 && uv[1] < 1;
      const inFrame = c.every((p) => {
        const q = cam.project(p, 0.3);
        return !!q && q[0] > -0.02 && q[0] < 1.02 && q[1] > -0.02 && q[1] < 1.02;
      });
      if (visible) tags += tag(Math.min(uv![0] * W, W - 90), uv![1] * H, `${o.id} ${o.kind}`, color);
      openings.push({ id: o.id, kind: o.kind, visible, inFrame });
    }
  }
  const image = await sharp(jpeg)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${svg}${tags}</svg>`) }])
    .jpeg({ quality: 85 })
    .toBuffer();
  return { image, openings };
}

/** Plan view of a room: walls, footprints with ids, and the cameras that saw it. PNG. */
export async function topDown(opts: {
  plan: FloorPlan;
  room: Room;
  items: SceneItem[];
  cameras: { id: string; pose: { x: number; y: number; yaw: number; hfov: number } }[];
}): Promise<Buffer> {
  const { plan, room, items } = opts;
  const xs = room.polygon.map((p) => p[0]);
  const ys = room.polygon.map((p) => p[1]);
  const pad = 1.2;
  const [x0, y0, x1, y1] = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  const S = 900 / Math.max(x1 - x0, y1 - y0);
  const W = Math.round((x1 - x0) * S);
  const H = Math.round((y1 - y0) * S);
  const X = (x: number) => ((x - x0) * S).toFixed(1);
  const Y = (y: number) => ((y - y0) * S).toFixed(1);
  let svg = `<rect width="${W}" height="${H}" fill="#fafaf7"/>`;
  for (const r of plan.rooms) {
    svg += `<polygon points="${r.polygon.map(([x, y]) => `${X(x)},${Y(y)}`).join(" ")}" fill="${r.id === room.id ? "#efe9dc" : "#f4f4f2"}" stroke="#ccc" stroke-width="1"/>`;
  }
  for (const w of plan.walls) {
    svg += `<line x1="${X(w.a[0])}" y1="${Y(w.a[1])}" x2="${X(w.b[0])}" y2="${Y(w.b[1])}" stroke="#333" stroke-width="${Math.max(2, w.thickness * S)}" stroke-linecap="square"/>`;
  }
  items.forEach((it, i) => {
    const b = itemBox(it);
    const color = colorFor(i);
    svg += `<rect x="${X(b.x0)}" y="${Y(b.y0)}" width="${((b.x1 - b.x0) * S).toFixed(1)}" height="${((b.y1 - b.y0) * S).toFixed(1)}" fill="${color}" fill-opacity="${it.elevation != null ? 0.12 : 0.3}" stroke="${color}" stroke-width="2"${it.source === "rules" ? ' stroke-dasharray="6 4"' : ""}/>`;
    // Front edge marker: local +z after rotation → plan (sin rot, cos rot).
    const fx = it.x + Math.sin(it.rot) * (it.d / 2);
    const fy = it.y + Math.cos(it.rot) * (it.d / 2);
    svg += `<circle cx="${X(fx)}" cy="${Y(fy)}" r="3" fill="${color}"/>`;
    svg += `<text x="${X(it.x)}" y="${Y(it.y)}" font-size="13" font-family="Helvetica" text-anchor="middle" fill="#111">${esc(it.id)}</text>`;
  });
  for (const c of opts.cameras) {
    const DEG = Math.PI / 180;
    const r = 1.2;
    const a = (c.pose.yaw - c.pose.hfov / 2) * DEG;
    const b = (c.pose.yaw + c.pose.hfov / 2) * DEG;
    svg += `<polygon points="${X(c.pose.x)},${Y(c.pose.y)} ${X(c.pose.x + Math.cos(a) * r)},${Y(c.pose.y + Math.sin(a) * r)} ${X(c.pose.x + Math.cos(b) * r)},${Y(c.pose.y + Math.sin(b) * r)}" fill="#2979ff" fill-opacity="0.15" stroke="#2979ff"/>`;
    svg += `<circle cx="${X(c.pose.x)}" cy="${Y(c.pose.y)}" r="5" fill="#2979ff"/><text x="${X(c.pose.x)}" y="${(Number(Y(c.pose.y)) - 8).toFixed(1)}" font-size="13" font-family="Helvetica" fill="#2979ff" text-anchor="middle">${esc(c.id)}</text>`;
  }
  return sharp(Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`)).png().toBuffer();
}

export { photoCamera };
