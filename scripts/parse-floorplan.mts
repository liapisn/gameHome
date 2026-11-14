/**
 * Parse a floor plan image into FloorPlan geometry.
 *
 *   npx tsx --env-file=.env.local scripts/parse-floorplan.mts <image> --id <plan-id> --title "<title>" [--hint "<context>"]
 *
 * Writes src/data/plans/<id>.json (the geometry) and <id>.raw.json (the model's raw output, for debugging).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseFloorPlanImage } from "../src/lib/floorplan-parser/parse";
import { buildFloorPlan } from "../src/lib/floorplan-parser/build";
import { ParsedPlanSchema } from "../src/lib/floorplan-parser/schema";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: "string" },
    title: { type: "string" },
    hint: { type: "string" },
    "from-raw": { type: "boolean", default: false },
  },
});

const image = positionals[0];
if (!image || !values.id || !values.title) {
  console.error('Usage: parse-floorplan.mts <image> --id <plan-id> --title "<title>" [--hint "..."] [--from-raw]');
  process.exit(1);
}

const outDir = path.resolve("src/data/plans");
const rawPath = path.join(outDir, `${values.id}.raw.json`);
fs.mkdirSync(outDir, { recursive: true });

const ext = path.extname(image).toLowerCase();
const mediaType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

let raw: { parsed: unknown; model: string; parsedAt: string };
if (values["from-raw"]) {
  // Rebuild geometry from a previous model run without calling the API again.
  raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
} else {
  console.log(`Parsing ${image}…`);
  const started = Date.now();
  const result = await parseFloorPlanImage({
    imageBase64: fs.readFileSync(image).toString("base64"),
    mediaType,
    hint: values.hint,
  });
  console.log(
    `Done in ${((Date.now() - started) / 1000).toFixed(1)}s · ${result.model} · ` +
      `${result.usage.input} in / ${result.usage.output} out tokens`,
  );
  raw = { parsed: result.parsed, model: result.model, parsedAt: new Date().toISOString() };
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2) + "\n");
}

const parsed = ParsedPlanSchema.parse(raw.parsed);
const { plan, report } = buildFloorPlan(parsed, {
  id: values.id,
  title: values.title,
  source: { kind: "parsed", image: path.relative(process.cwd(), image), model: raw.model, parsedAt: raw.parsedAt },
});

const outPath = path.join(outDir, `${values.id}.json`);
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2) + "\n");

console.log(`\n${plan.rooms.length} rooms · ${plan.walls.length} walls · ${plan.openings.length} openings → ${outPath}`);
console.log(`Scale: ${parsed.scaleMethod}`);
if (report.dimensionChecks.length) {
  console.log("\nRoom dimensions (printed vs built, m):");
  for (const c of report.dimensionChecks) {
    const flag = c.error > 0.3 ? "  ⚠" : "";
    console.log(`  ${c.room.padEnd(24)} ${c.labeled.join(" × ").padEnd(14)} ${c.built.join(" × ").padEnd(14)} Δ${c.error}${flag}`);
  }
}
if (report.warnings.length) {
  console.log("\nWarnings:");
  for (const w of report.warnings) console.log(`  - ${w}`);
}
