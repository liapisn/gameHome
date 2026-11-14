/**
 * Clean reference → 3D models from both generators at once.
 *
 * Adapted from https://github.com/apekshik/anyscene (endpoint/props.py MESH settings,
 * generate/fal.mjs MODELS3D), MIT licence.
 */
import fs from "node:fs";
import path from "node:path";
import { downloadGlb, falRunRetry, glbUrlIn, pngDataUri } from "@/lib/fal/client";
import type { Reference } from "./reference";
import type { Generator } from "./types";

export const MESH: Record<Generator, { endpoint: string; input: Record<string, unknown> }> = {
  "tripo-h31": {
    endpoint: "tripo3d/h3.1/image-to-3d",
    input: { pbr: true, texture: true, geometry_quality: "detailed", texture_quality: "detailed", auto_size: true, orientation: "align_image" },
  },
  meshy: {
    endpoint: "meshy/v7.1/image-to-3d",
    input: { enable_pbr: true, should_texture: true, geometry_resolution: "4k", topology: "triangle", should_remesh: true, target_polycount: 150000, symmetry_mode: "auto" },
  },
};
export const GENERATORS = Object.keys(MESH) as Generator[];

/** One generator's raw model for this reference, cached as `<dir>/<generator>/model.glb`. */
async function meshOne(gen: Generator, ref: Reference, dir: string, log?: (m: string) => void): Promise<string> {
  const out = path.join(dir, gen, "model.glb");
  if (fs.existsSync(out)) return out;
  // fal URLs expire; the reference file is the durable copy.
  const image = pngDataUri(fs.readFileSync(ref.file));
  const { endpoint, input } = MESH[gen];
  const { result, seconds } = await falRunRetry(endpoint, { ...input, image_url: image }, {
    pending: path.join(dir, gen, "pending.json"),
    meta: { kind: "3d", generator: gen, dir },
    timeoutMin: 25,
    log,
  });
  const url = glbUrlIn(result);
  if (!url) throw new Error(`${gen}: no GLB in the response: ${JSON.stringify(result).slice(0, 300)}`);
  fs.writeFileSync(path.join(dir, gen, "result.json"), JSON.stringify({ endpoint, seconds, result }, null, 2));
  await downloadGlb(url, out);
  log?.(`${gen} model in ${seconds.toFixed(0)} s`);
  return out;
}

/** Both generators in parallel; a generator that fails is reported, not thrown. */
export async function meshBoth(ref: Reference, dir: string, log?: (m: string) => void) {
  const runs = await Promise.allSettled(GENERATORS.map((g) => meshOne(g, ref, dir, log)));
  const models: Partial<Record<Generator, string>> = {};
  const errors: string[] = [];
  runs.forEach((r, i) => {
    if (r.status === "fulfilled") models[GENERATORS[i]] = r.value;
    else errors.push(`${GENERATORS[i]}: ${(r.reason as Error).message.slice(0, 200)}`);
  });
  return { models, errors };
}
