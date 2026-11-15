/**
 * Milestone 2 check: run blender/test_gh_parts.py on a boxd machine. Every gh_parts function is
 * called once and checked; the contact sheet lands in exports/gh-parts/contact.png.
 *
 *   npx tsx --env-file=.env.local scripts/test-gh-parts.mts
 */
import fs from "node:fs";
import path from "node:path";
import { closePool } from "../src/lib/boxd/runner";
import { blenderJob } from "../src/lib/models3d/util";

const out = path.resolve("exports", "gh-parts");
try {
  const log = await blenderJob("test_gh_parts.py", path.join(out, "job.json"), { outDir: out, samples: 24 });
  for (const line of log.split("\n")) if (/^\s+(ok|FAIL)\s/.test(line) || /GH_PARTS/.test(line)) console.log(line);
  console.log(`→ ${path.relative(process.cwd(), path.join(out, "contact.png"))}`);
} catch (e) {
  const report = path.join(out, "report.json");
  if (fs.existsSync(report)) for (const r of JSON.parse(fs.readFileSync(report, "utf8"))) if (!r.ok) console.log(`FAIL ${r.case}\n${r.error}`);
  console.error((e as Error).message.split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  await closePool();
}
