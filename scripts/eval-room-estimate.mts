/**
 * Score the photo → room first guess (src/lib/tour/estimate-room.ts) against a fixture's labels.
 * One model call per photo, nothing cached.
 *
 *   npx tsx --env-file=.env.local scripts/eval-room-estimate.mts fixtures/listing-8218 listing-8218
 *     <fixture folder> <plan prefix: src/data/plans/<prefix>-<level>.json>
 *
 * A guess counts as right when its room's name matches the label (or one part of a combined name
 * such as "Kitchen / Entry"), or when both say the photo is on no plan.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { FloorPlan } from "../src/lib/floorplan";
import { type EstimateLevel, estimateContext, estimateRoom } from "../src/lib/tour/estimate-room";

const [folder, planPrefix] = process.argv.slice(2);
if (!folder || !planPrefix) {
  console.error("Usage: eval-room-estimate.mts <fixture folder> <plan prefix>");
  process.exit(1);
}
const manifest: {
  levels: { id: string; name: string; floorplan: string | null }[];
  photos: { file: string; level: string; room: string; candidates?: string[] }[];
} = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));

const levels: EstimateLevel[] = await Promise.all(
  manifest.levels
    .filter((l) => l.floorplan)
    .map(async (l) => ({
      id: l.id,
      name: l.name,
      plan: JSON.parse(fs.readFileSync(`src/data/plans/${planPrefix}-${l.id}.json`, "utf8")) as FloorPlan,
      drawing: (await sharp(path.join(folder, l.floorplan!)).resize(1600, 1600, { fit: "inside" }).jpeg({ quality: 88 }).toBuffer()).toString("base64"),
    })),
);
const shared = estimateContext(levels, manifest.levels.filter((l) => !l.floorplan).map((l) => l.name));
const mapped = new Set(levels.map((l) => l.id));
const norm = (s: string) => s.toLowerCase().replace(/[\d.×x]+\s*(m)?\s*$/, "").replace(/\s+\d.*$/, "").trim();

const t0 = Date.now();
const rows = await Promise.all(
  manifest.photos.map(async (p) => {
    const base64 = (await sharp(path.join(folder, p.file)).rotate().resize(1280).jpeg({ quality: 85 }).toBuffer()).toString("base64");
    const e = await estimateRoom(levels, shared, { base64 });
    const room = e.levelId ? levels.find((l) => l.id === e.levelId)!.plan.rooms.find((r) => r.id === e.roomId) : undefined;
    const labels = [p.room, ...(p.candidates ?? [])].map(norm);
    const right = mapped.has(p.level)
      ? !!room && e.levelId === p.level && [room.name, ...room.name.split("/")].some((n) => labels.includes(norm(n)))
      : !e.levelId;
    return { id: path.parse(p.file).name, truth: mapped.has(p.level) ? p.room : `none (${p.room})`, guess: room?.name ?? (e.levelId ? "floor, no room" : "none"), ...e, right };
  }),
);
rows.sort((a, b) => a.id.localeCompare(b.id));
for (const r of rows) console.log(`${r.right ? "  " : "✗ "}${r.id} truth ${r.truth.padEnd(34)} guess ${r.guess.padEnd(24)} ${r.confidence.padEnd(6)} ${r.reason}`);
for (const c of ["high", "medium", "low"] as const) {
  const g = rows.filter((r) => r.confidence === c);
  if (g.length) console.log(`${c.padEnd(6)} ${g.filter((r) => r.right).length}/${g.length} right`);
}
console.log(`all    ${rows.filter((r) => r.right).length}/${rows.length} right · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
