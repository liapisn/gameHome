/**
 * Export a FloorPlan as a .glb (+ the plan JSON beside it) for Unreal / Blender.
 *
 *   npm run export:glb                          # demo plan → exports/demo-athens-2br/
 *   npm run export:glb -- --plan path/plan.json # any FloorPlan JSON
 *   npm run export:glb -- --no-ceilings         # dollhouse-only geometry
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildDollhouseScene } from "../src/lib/dollhouse-geometry";
import { type FloorPlan, demoPlan } from "../src/lib/floorplan";
import { sceneToGlb } from "../src/lib/glb";

const { values } = parseArgs({
  options: {
    plan: { type: "string" },
    out: { type: "string", default: "exports" },
    "no-ceilings": { type: "boolean", default: false },
  },
});

const plan: FloorPlan = values.plan ? JSON.parse(await readFile(values.plan, "utf8")) : demoPlan;
const scene = buildDollhouseScene(plan, { ceilings: !values["no-ceilings"] });

const glb = await sceneToGlb(scene);

const dir = path.resolve(values.out!, plan.id);
await mkdir(dir, { recursive: true });
const glbPath = path.join(dir, `${plan.id}.glb`);
await writeFile(glbPath, glb);
await writeFile(path.join(dir, `${plan.id}.plan.json`), JSON.stringify(plan, null, 2));

console.log(`${glbPath}  (${(glb.byteLength / 1024).toFixed(1)} KB, ${scene.children.length} meshes)`);
