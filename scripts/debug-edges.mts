/**
 * Draw a tour photo's stored pose as the room outline over the photo, to check it by eye.
 *   npx tsx scripts/debug-edges.mts <tour-id> <out-dir> [photo-id …]   (default: every posed photo)
 * Red: wall/ceiling junctions · blue: wall/floor junctions · yellow: vertical corners.
 * A correct pose puts the red lines on the ceiling edges and the yellow lines on the room's corners.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { FloorPlan } from "../src/lib/floorplan";
import type { Tour } from "../src/lib/tour/types";

const [tourId, outDir, ...ids] = process.argv.slice(2);
const tour: Tour = JSON.parse(fs.readFileSync(`src/data/tours/${tourId}.json`, "utf8"));
fs.mkdirSync(outDir, { recursive: true });
const DEG = Math.PI / 180;
const W = 1200;

for (const photo of tour.photos.filter((p) => p.pose && p.roomId && (!ids.length || ids.includes(p.id)))) {
  const level = tour.levels.find((l) => l.id === photo.levelId)!;
  const plan: FloorPlan = JSON.parse(fs.readFileSync(`src/data/plans/${level.planId}.json`, "utf8"));
  const room = plan.rooms.find((r) => r.id === photo.roomId)!;
  const pose = photo.pose!;
  const ceiling = photo.fit?.ceiling ?? plan.ceilingHeight;
  const H = Math.round((W * photo.height) / photo.width);
  const horizon = pose.horizon ?? 0.5;
  const tH = Math.tan((pose.hfov * DEG) / 2);
  const proj = (p: [number, number, number]) => {
    const dx = p[0] - pose.x;
    const dy = p[1] - pose.y;
    const f = dx * Math.cos(pose.yaw * DEG) + dy * Math.sin(pose.yaw * DEG);
    if (f < 0.15) return null;
    const l = -dx * Math.sin(pose.yaw * DEG) + dy * Math.cos(pose.yaw * DEG);
    return [(0.5 + (0.5 * l) / (f * tH)) * W, (horizon + (0.5 * (pose.height - p[2])) / (f * tH * (H / W))) * H];
  };
  let svg = "";
  const seg = (a: [number, number, number], b: [number, number, number], color: string) => {
    const pts: string[] = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const p = proj([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      if (p) pts.push(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
    }
    if (pts.length > 1) svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="4" stroke-opacity="0.9"/>`;
  };
  room.polygon.forEach(([ax, ay], i) => {
    const [bx, by] = room.polygon[(i + 1) % room.polygon.length];
    seg([ax, ay, ceiling], [bx, by, ceiling], "#ff1744");
    seg([ax, ay, 0], [bx, by, 0], "#2979ff");
    seg([ax, ay, 0], [ax, ay, ceiling], "#ffea00");
  });
  const label = `${photo.id} · ${room.name} · ${photo.fit?.method}${photo.fit?.score != null ? ` ${photo.fit.score}/${photo.fit.margin ?? "-"}` : ""}`;
  svg += `<rect width="${label.length * 13 + 20}" height="44" fill="#000" fill-opacity="0.7"/><text x="10" y="31" font-size="24" font-family="Helvetica" fill="#fff">${label}</text>`;
  await sharp(path.join(tour.mediaRoot, photo.src))
    .rotate()
    .resize(W)
    .composite([{ input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`) }])
    .jpeg({ quality: 85 })
    .toFile(path.join(outDir, `${photo.id}.jpg`));
}
