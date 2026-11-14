/**
 * Score the scene gate against a fixture's ground-truth manifest: every posed photo of the tour is
 * gated against the room it was placed in, and compared with the manifest's level/room label.
 *   npx tsx --env-file=.env.local scripts/eval-gate.mts listing-15970 fixtures/listing-15970 [--fresh]
 * Answers are cached in exports/<tour>/gate/.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { FloorPlan } from "../src/lib/floorplan";
import { gatePhoto } from "../src/lib/scene/gate";
import { photoCamera } from "../src/lib/scene/project";
import type { Tour } from "../src/lib/tour/types";

const [tourId, fixtureDir, flag] = process.argv.slice(2);
const fresh = flag === "--fresh";
const tour: Tour = JSON.parse(fs.readFileSync(`src/data/tours/${tourId}.json`, "utf8"));
const manifest: { photos: { file: string; level: string; room: string }[] } = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"),
);
const dir = path.resolve("exports", tourId, "gate");
fs.mkdirSync(dir, { recursive: true });

const norm = (s: string) => s.toLowerCase().replace(/[\d.×x]+\s*$/, "").replace(/\s+\d.*$/, "").trim();

const rows = await Promise.all(
  tour.photos
    .filter((p) => p.pose && p.levelId && p.roomId)
    .map(async (p) => {
      const level = tour.levels.find((l) => l.id === p.levelId)!;
      const plan: FloorPlan = JSON.parse(fs.readFileSync(`src/data/plans/${level.planId}.json`, "utf8"));
      const room = plan.rooms.find((r) => r.id === p.roomId)!;
      const truth = manifest.photos.find((m) => m.file === p.src)!;
      const correct = truth.level === p.levelId && norm(truth.room) === norm(room.name);
      const file = path.join(dir, `${p.id}.json`);
      let res: { pass: boolean; reason: string };
      if (!fresh && fs.existsSync(file)) res = JSON.parse(fs.readFileSync(file, "utf8"));
      else {
        const src = path.join(tour.mediaRoot, p.src);
        const r = await gatePhoto({
          photoFile: src,
          photoJpeg: await sharp(src).rotate().resize(1600).jpeg({ quality: 88 }).toBuffer(),
          cam: photoCamera(p.pose!, p.height / p.width),
          plan, room, ceiling: level.ceilingHeight ?? plan.ceilingHeight, fit: p.fit, levelName: level.name,
        });
        res = { pass: r.pass, reason: r.reason };
        fs.writeFileSync(file, JSON.stringify({ ...res, answer: r.answer }, null, 2));
        fs.writeFileSync(path.join(dir, `${p.id}.jpg`), r.overlay);
      }
      return { id: p.id, placed: `${p.levelId}/${room.name}`, truth: `${truth.level}/${truth.room}`, method: p.fit?.method, correct, ...res };
    }),
);

rows.sort((a, b) => a.id.localeCompare(b.id));
for (const r of rows) {
  const ok = r.pass === r.correct;
  console.log(`${ok ? "  " : "✗ "}${r.id} ${r.pass ? "pass" : "FAIL"}  placed ${r.placed.padEnd(28)} truth ${r.truth.padEnd(32)} ${r.method}  — ${r.reason}`);
}
const right = rows.filter((r) => r.correct);
const wrong = rows.filter((r) => !r.correct);
console.log(`\nRight placements kept:    ${right.filter((r) => r.pass).length}/${right.length}`);
console.log(`Wrong placements rejected: ${wrong.filter((r) => !r.pass).length}/${wrong.length}`);
