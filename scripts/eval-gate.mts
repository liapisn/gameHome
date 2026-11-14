/**
 * Score the scene gate against a fixture's ground-truth manifest: every posed photo of the tour is
 * gated against the room it was placed in, and compared with the manifest's level/room label.
 *
 *   npx tsx --env-file=.env.local scripts/eval-gate.mts listing-15970 fixtures/listing-15970
 *     default gate (no gate model): owner notes → room kind seen at detection → floor contacts.
 *     Detections are read from the build:scene cache (exports/<tour>/<level>-<room>/); missing ones
 *     cost a model call. Prints the result for a range of contact thresholds, with and without the
 *     owner's floor assignment (fixture manifests carry the true floor as `level`).
 *   … --model [--fresh]   the opt-in gate model instead; answers cached in exports/<tour>/gate/.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { buildRoomScene, MAX_OUTSIDE, sceneRooms, STRICT_POSE } from "../src/lib/engine/build-scene";
import type { FloorPlan } from "../src/lib/floorplan";
import { gatePhoto } from "../src/lib/scene/gate";
import { photoCamera } from "../src/lib/scene/project";
import type { PhotoGate } from "../src/lib/scene/types";
import type { Tour } from "../src/lib/tour/types";

const [tourId, fixtureDir, ...flags] = process.argv.slice(2);
const fresh = flags.includes("--fresh");
const tour: Tour = JSON.parse(fs.readFileSync(`src/data/tours/${tourId}.json`, "utf8"));
const manifest: { photos: { file: string; level: string; room: string }[] } = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"),
);
const plans = new Map(tour.levels.map((l) => [l.id, JSON.parse(fs.readFileSync(`src/data/plans/${l.planId}.json`, "utf8")) as FloorPlan]));

const norm = (s: string) => s.toLowerCase().replace(/[\d.×x]+\s*$/, "").replace(/\s+\d.*$/, "").trim();
const posed = tour.photos.filter((p) => p.pose && p.levelId && p.roomId);
const label = (p: (typeof posed)[number]) => {
  const room = plans.get(p.levelId!)!.rooms.find((r) => r.id === p.roomId)!;
  const truth = manifest.photos.find((m) => m.file === p.src)!;
  return {
    placed: `${p.levelId}/${room.name}`,
    truth: `${truth.level}/${truth.room}`,
    // Plans name combined rooms "Kitchen / Entry"; a label naming one part of it is a match.
    correct: truth.level === p.levelId && [room.name, ...room.name.split("/")].some((n) => norm(n) === norm(truth.room)),
    otherFloor: truth.level !== p.levelId,
  };
};

const tally = (rows: { correct: boolean; pass: boolean }[]) => {
  const right = rows.filter((r) => r.correct);
  const wrong = rows.filter((r) => !r.correct);
  return { kept: right.filter((r) => r.pass).length, right: right.length, rejected: wrong.filter((r) => !r.pass).length, wrong: wrong.length };
};

if (flags.includes("--model")) {
  const dir = path.resolve("exports", tourId, "gate");
  fs.mkdirSync(dir, { recursive: true });
  const rows = await Promise.all(
    posed.map(async (p) => {
      const level = tour.levels.find((l) => l.id === p.levelId)!;
      const plan = plans.get(level.id)!;
      const room = plan.rooms.find((r) => r.id === p.roomId)!;
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
      return { id: p.id, method: p.fit?.method, ...label(p), ...res };
    }),
  );
  rows.sort((a, b) => a.id.localeCompare(b.id));
  for (const r of rows) {
    console.log(`${r.pass === r.correct ? "  " : "✗ "}${r.id} ${r.pass ? "pass" : "FAIL"}  placed ${r.placed.padEnd(28)} truth ${r.truth.padEnd(32)} ${r.method}  — ${r.reason}`);
  }
  const t = tally(rows);
  console.log(`\nRight placements kept:    ${t.kept}/${t.right}\nWrong placements rejected: ${t.rejected}/${t.wrong}`);
  process.exit(0);
}

// ------------------------------------------------------------------ default gate
// One pass per room with the contact rules off and no owner notes: records every photo's nearby
// contacts and its room-kind verdict. The rules are then applied here for each threshold.
const bare: Tour = { ...tour, photos: tour.photos.map((p) => ({ ...p, owner: undefined })) };
const gates = new Map<string, PhotoGate>();
for (const key of sceneRooms(bare)) {
  const [levelId, roomId] = key.split("/");
  const { scene } = await buildRoomScene({
    tour: bare, plan: plans.get(levelId)!, levelId, roomId, rounds: 0,
    workDir: path.resolve("exports", tourId, `${levelId}-${roomId}`),
    gate: { maxOutside: 1, strictPose: false },
  });
  for (const g of scene.photos) gates.set(g.id, g);
}

const rows = posed.map((p) => {
  const g = gates.get(p.id)!;
  return { id: p.id, method: p.fit?.method ?? "none", g, kindFail: g.gate === "fail", contacts: g.contacts ?? { inside: 0, outside: 0 }, ...label(p) };
});
const decide = (r: (typeof rows)[number], o: { owner: boolean; maxOutside: number; strictPose: boolean }) => {
  const { inside, outside } = r.contacts;
  const total = inside + outside;
  if (o.owner && r.otherFloor) return "owner floor";
  if (r.kindFail) return r.g.reason;
  if (total >= 3 && outside / total > o.maxOutside) return `${outside}/${total} contacts outside`;
  if (o.strictPose && r.method !== "edges" && (total < 3 || outside > 0)) return `${r.method} pose, ${inside} in / ${outside} out`;
  return null;
};

const shipped = { owner: true, maxOutside: MAX_OUTSIDE, strictPose: STRICT_POSE };
console.log(`${tourId}: ${rows.length} posed photos, gate as shipped (owner floor, max outside ${MAX_OUTSIDE}, strict pose ${STRICT_POSE ? "on" : "off"})\n`);
for (const r of rows.sort((a, b) => a.id.localeCompare(b.id))) {
  const why = decide(r, shipped);
  const pass = !why;
  console.log(
    `${pass === r.correct ? "  " : "✗ "}${r.id} ${pass ? "pass" : "FAIL"}  placed ${r.placed.padEnd(28)} truth ${r.truth.padEnd(32)} ${r.method.padEnd(9)} ` +
      `${String(r.contacts.inside).padStart(2)} in ${String(r.contacts.outside).padStart(2)} out${why ? `  — ${why}` : ""}`,
  );
}

console.log(`\n${"owner floor".padEnd(12)}${"strict pose".padEnd(13)}${"max outside".padEnd(13)}kept right   rejected wrong`);
for (const owner of [true, false]) {
  for (const strictPose of [true, false]) {
    for (const maxOutside of [1, 0.7, 0.5, 0.4, 0.3, 0.2, 0.1, 0]) {
      const t = tally(rows.map((r) => ({ correct: r.correct, pass: !decide(r, { owner, maxOutside, strictPose }) })));
      const mark = owner && strictPose === STRICT_POSE && maxOutside === MAX_OUTSIDE ? " ← shipped" : "";
      console.log(`${(owner ? "yes" : "no").padEnd(12)}${(strictPose ? "yes" : "no").padEnd(13)}${String(maxOutside).padEnd(13)}${`${t.kept}/${t.right}`.padEnd(13)}${t.rejected}/${t.wrong}${mark}`);
    }
  }
}
