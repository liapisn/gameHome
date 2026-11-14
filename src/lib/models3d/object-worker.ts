/**
 * Object worker: one object's photos → one prepared 3D model. See docs/agent-tree-plan.md.
 *
 *   crops → clean reference → reference check → Tripo + Meshy → prepare both → same-light renders
 *   → pick → size check; up to 3 attempts, each told what was wrong with the last.
 *
 * Every step is cached under the brief's workDir (attempt folders a1/, a2/, a3/), so a rerun pays
 * nothing for what is done. Which way the model faces is fixed later by the room worker, which
 * compares it with the photos from their own cameras.
 */
import fs from "node:fs";
import path from "node:path";
import { checkReference, pickModel } from "./critic";
import { meshBoth } from "./mesh";
import { cleanReference, cropViews } from "./reference";
import type { Generator, ObjectBrief, ObjectResult } from "./types";
import { blenderJob, cachedJson } from "./util";

const MAX_ATTEMPTS = 3;
/** An axis further off its target than this fails the attempt. */
const SIZE_TOLERANCE = 0.25;

/** Upright things are scaled by height; flat ones (rugs, low tables wider than tall) by footprint. */
export const fitFor = (size: ObjectBrief["size"]) => (size.h >= 0.25 * Math.max(size.w, size.d) ? "upright" : "flat");

interface Attempt {
  n: number;
  glb?: string;
  generator?: Generator;
  size?: ObjectResult["size"];
  reference?: string;
  preview?: string;
  reason: string;
  /** Picked and within size: done. */
  good: boolean;
}

export async function runObjectWorker(brief: ObjectBrief, log: (m: string) => void = () => {}): Promise<ObjectResult> {
  const say = (m: string) => log(`[${brief.assetId}] ${m}`);
  fs.mkdirSync(brief.workDir, { recursive: true });
  fs.writeFileSync(path.join(brief.workDir, "brief.json"), JSON.stringify(brief, null, 2));
  const crops = await cropViews(brief);
  const attempts: Attempt[] = [];
  let problem: string | undefined;

  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    const dir = path.join(brief.workDir, `a${n}`);
    const a = await attempt(brief, crops, dir, n, problem, say).catch((err): Attempt => ({ n, reason: `error: ${(err as Error).message}`, good: false }));
    attempts.push(a);
    say(`attempt ${n}: ${a.good ? "ok" : "not good"} — ${a.reason}`);
    if (a.good) break;
    problem = a.reason;
  }

  const best = attempts.find((a) => a.good) ?? attempts.filter((a) => a.glb).at(-1);
  const result: ObjectResult = best?.glb
    ? {
        assetId: brief.assetId,
        status: "ok",
        glb: best.glb,
        size: best.size,
        generator: best.generator,
        reference: best.reference,
        preview: best.preview,
        attempts: attempts.length,
        reason: best.good ? best.reason : `best of ${attempts.length} attempts, not fully right: ${best.reason}`,
        invented: brief.views.length === 0,
      }
    : { assetId: brief.assetId, status: "failed", attempts: attempts.length, reason: attempts.map((a) => a.reason).join(" | "), invented: brief.views.length === 0 };
  fs.writeFileSync(path.join(brief.workDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

async function attempt(brief: ObjectBrief, crops: string[], dir: string, n: number, problem: string | undefined, say: (m: string) => void): Promise<Attempt> {
  // 1. Clean reference, checked against the photos (no photos: nothing to check against).
  const ref = await cleanReference(brief, crops, dir, problem, say);
  if (crops.length) {
    const check = await cachedJson(path.join(dir, "reference-check.json"), () => checkReference(brief.label, crops, ref.file));
    if (!check.ok) return { n, reference: ref.file, reason: `reference: ${check.problem || "does not match the photos"}`, good: false };
  }

  // 2. Both generators.
  const { models, errors } = await meshBoth(ref, dir, say);
  const gens = Object.keys(models) as Generator[];
  if (!gens.length) return { n, reference: ref.file, reason: `no model: ${errors.join("; ")}`, good: false };
  if (errors.length) say(`one generator failed: ${errors.join("; ")}`);

  // 3. Prepare: front to −Y, real size, origin on the floor.
  const fit = fitFor(brief.size);
  const prepared: { gen: Generator; glb: string; dims: [number, number, number] }[] = [];
  for (const gen of gens) {
    const out = path.join(dir, gen, "prepared.glb");
    if (!fs.existsSync(out + ".json")) await blenderJob("prep_prop.py", path.join(dir, gen, "prep-job.json"), { glb: models[gen], generator: gen, size: brief.size, fit, out });
    if (!fs.existsSync(out + ".json")) throw new Error(`${gen}: preparing the model failed`);
    prepared.push({ gen, glb: out, dims: JSON.parse(fs.readFileSync(out + ".json", "utf8")).dims });
  }

  // 4. Same-light renders, then pick.
  const cmpDir = path.join(dir, "compare");
  if (!prepared.every((p) => fs.existsSync(path.join(cmpDir, `${p.gen}_clay.png`)))) {
    await blenderJob("render_compare.py", path.join(dir, "compare-job.json"), { candidates: prepared.map((p) => ({ name: p.gen, glb: p.glb })), out: cmpDir, res: 640, samples: 32 });
  }
  const rendered = prepared.filter((p) => fs.existsSync(path.join(cmpDir, `${p.gen}_clay.png`)));
  if (!rendered.length) throw new Error("rendering the candidates failed");
  const pick = await cachedJson(path.join(dir, "pick.json"), () =>
    pickModel(
      brief.label,
      crops,
      ref.file,
      rendered.map((p) => ({ beauty: path.join(cmpDir, `${p.gen}_beauty.png`), back: path.join(cmpDir, `${p.gen}_back.png`), clay: path.join(cmpDir, `${p.gen}_clay.png`) })),
    ),
  );
  if (pick.index < 0) return { n, reference: ref.file, reason: `both models rejected: ${pick.problem || pick.reason}`, good: false };
  const chosen = rendered[pick.index];

  // 5. Size check against the target.
  const [w, d, h] = chosen.dims;
  const off = (got: number, want: number) => Math.abs(got - want) / Math.max(want, 0.05);
  // Plants spread as wide as they like: only their height is held to the target.
  const footprintFree = brief.kind === "plant";
  const axes =
    fit === "flat"
      ? [off(Math.max(w, d), Math.max(brief.size.w, brief.size.d))]
      : [off(h, brief.size.h), ...(footprintFree ? [] : [off(Math.max(w, d), Math.max(brief.size.w, brief.size.d))])];
  const sized = Math.max(...axes) <= SIZE_TOLERANCE;
  return {
    n,
    glb: chosen.glb,
    generator: chosen.gen,
    size: { w, d, h },
    reference: ref.file,
    preview: path.join(cmpDir, `${chosen.gen}_beauty.png`),
    reason: sized
      ? `${chosen.gen}: ${pick.reason}`
      : `${chosen.gen} picked but its proportions are off (built ${w.toFixed(2)}×${d.toFixed(2)}×${h.toFixed(2)} m, want ${brief.size.w.toFixed(2)}×${brief.size.d.toFixed(2)}×${brief.size.h.toFixed(2)} m); keep the real proportions of the ${brief.label}`,
    good: sized,
  };
}
