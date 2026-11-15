/**
 * Compare model builds of one tour side by side: per room, the scene score, the house review
 * score, how many items became library models, boxes or stand-ins, placement problems, and the
 * build time. Copy exports/<tour>/models/ aside before each build you want to compare.
 *   npx tsx scripts/compare-builds.mts <dirA> <dirB> [<dirC> …]
 * See docs/library-full-plan.md, Part F.
 */
import fs from "node:fs";
import path from "node:path";

const dirs = process.argv.slice(2);
if (dirs.length < 1) {
  console.error("Usage: compare-builds.mts <models dir> [<models dir> …]");
  process.exit(1);
}

type House = {
  startedAt?: string;
  finishedAt?: string;
  rooms: { room: string; report: string | null; error: string | null }[];
  critique: { rooms: { room: string; score: number }[] } | null;
};
type Report = {
  room: string;
  sceneScore?: number | null;
  models: { status: string }[];
  placements: unknown[];
  library?: { picked?: string; source?: string }[];
  builtToMeasure: string[];
  standIns: unknown[];
  checks: { FLOAT?: number; OUT?: number[] }[];
};

interface Row {
  scene: string;
  review: string;
  library: string;
  gemini: string;
  boxes: string;
  standIns: string;
  problems: string;
}

function load(dir: string) {
  const rooms = new Map<string, Row>();
  const houseFile = path.join(dir, "house.json");
  const house: House | null = fs.existsSync(houseFile) ? JSON.parse(fs.readFileSync(houseFile, "utf8")) : null;
  // Room reports: from house.json, else every rooms/<key>/room.json (a one-room build).
  const reports = new Map<string, string>();
  const roomsDir = path.join(dir, "rooms");
  if (fs.existsSync(roomsDir)) for (const k of fs.readdirSync(roomsDir)) if (fs.existsSync(path.join(roomsDir, k, "room.json"))) reports.set(k, path.join(roomsDir, k, "room.json"));
  for (const [key, file] of reports) {
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as Report;
    const review = house?.critique?.rooms.find((x) => x.room === r.room)?.score;
    const lib = r.library ?? [];
    rooms.set(r.room ?? key, {
      scene: r.sceneScore == null ? "–" : r.sceneScore.toFixed(2),
      review: review == null ? "–" : String(review),
      library: String(lib.length),
      gemini: String(lib.filter((l) => l.picked === "gemini").length),
      boxes: String(r.builtToMeasure.length),
      standIns: String(r.standIns.length),
      problems: String(r.checks.filter((c) => c.FLOAT != null || c.OUT).length),
    });
  }
  for (const r of house?.rooms ?? []) if (r.error && !rooms.has(r.room)) rooms.set(r.room, { scene: "–", review: "–", library: "–", gemini: "–", boxes: "–", standIns: "–", problems: `failed: ${r.error.slice(0, 30)}` });
  const minutes = house?.startedAt && house.finishedAt ? ((Date.parse(house.finishedAt) - Date.parse(house.startedAt)) / 60000).toFixed(1) : "–";
  return { rooms, minutes };
}

const builds = dirs.map((d) => ({ dir: d, ...load(path.resolve(d)) }));
const names = builds.map((b, i) => `${String.fromCharCode(65 + i)}`);
builds.forEach((b, i) => console.log(`${names[i]}: ${b.dir}  (house build ${b.minutes} min)`));

const cols: [keyof Row, string][] = [
  ["scene", "scene score"],
  ["review", "review"],
  ["library", "library models"],
  ["gemini", "picked by Gemini"],
  ["boxes", "built to measure"],
  ["standIns", "stand-ins"],
  ["problems", "placement problems"],
];
const allRooms = [...new Set(builds.flatMap((b) => [...b.rooms.keys()]))].sort();
for (const room of allRooms) {
  console.log(`\n${room}`);
  console.log(`  ${"".padEnd(20)}${names.map((n) => n.padStart(10)).join("")}`);
  for (const [k, label] of cols) console.log(`  ${label.padEnd(20)}${builds.map((b) => (b.rooms.get(room)?.[k] ?? "–").padStart(10)).join("")}`);
}
