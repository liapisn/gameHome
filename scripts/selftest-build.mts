/** Offline check of the geometry builder: feeds it the demo plan with jittered coordinates.
 *   npx tsx scripts/selftest-build.mts [out.json]
 */
import fs from "node:fs";
import { demoPlan } from "../src/lib/floorplan";
import { buildFloorPlan } from "../src/lib/floorplan-parser/build";
import type { ParsedPlan } from "../src/lib/floorplan-parser/schema";

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2; // [-1, 1]
const jitter = (v: number, amt: number) => v + rand() * amt;

// Opening centers in plan space, computed from the demo's wall-relative openings.
const openings = demoPlan.openings.map((o) => {
  const w = demoPlan.walls.find((w) => w.id === o.wallId)!;
  const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  const t = (o.offset + o.width / 2) / len;
  return {
    kind: o.kind,
    x: jitter(w.a[0] + t * (w.b[0] - w.a[0]), 0.1),
    y: jitter(w.a[1] + t * (w.b[1] - w.a[1]), 0.1),
    width: o.width,
    note: o.id,
  };
});

const parsed: ParsedPlan = {
  levelName: "selftest",
  scaleMethod: "printed_dimensions",
  rooms: demoPlan.rooms.map((r) => ({
    name: r.name,
    type: r.type,
    labeledWidth: null,
    labeledDepth: null,
    polygon: r.polygon.map(([x, y]) => ({ x: jitter(x, 0.08), y: jitter(y, 0.08) })),
  })),
  openings,
  warnings: [],
};

const { plan, report } = buildFloorPlan(parsed, { id: "_selftest", title: "Builder self-test (jittered demo)" });
const ext = plan.walls.filter((w) => w.exterior).length;
console.log(`rooms ${plan.rooms.length} · walls ${plan.walls.length} (${ext} exterior) · openings ${plan.openings.length}/${openings.length} · dropped ${report.droppedOpenings}`);
for (const w of plan.walls) console.log(`  ${w.id} ${w.exterior ? "ext" : "int"} ${JSON.stringify(w.a)} → ${JSON.stringify(w.b)}`);
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(plan, null, 2));
