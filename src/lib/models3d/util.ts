/** Small shared helpers for the model workers: a JSON cache on disk and Blender job runs. */
import fs from "node:fs";
import path from "node:path";
import { runBlender } from "@/lib/blender/run-blender";

/** Run `make` once; later calls read its JSON from `file` (so a rerun pays nothing). */
export async function cachedJson<T>(file: string, make: () => Promise<T>): Promise<T> {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  const v = await make();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 2));
  return v;
}

/** The line each script in blender/ prints when it finished. */
const MARKER: Record<string, string> = {
  "build_scene.py": "BUILD_SCENE_OK",
  "join_house.py": "JOIN_HOUSE_OK",
  "web_copy.py": "WEB_COPY_OK",
  "test_gh_parts.py": "GH_PARTS_OK",
  "run_object.py": "RUN_OBJECT_DONE",
};

/** Write `job` beside `jobFile` and run a script from blender/ on it (on its own boxd machine; see run-blender.ts). */
export function blenderJob(script: string, jobFile: string, job: unknown): Promise<string> {
  fs.mkdirSync(path.dirname(jobFile), { recursive: true });
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));
  return runBlender(path.resolve("blender", script), [jobFile], undefined, MARKER[script] ?? "BUILD_SCENE_OK");
}

/** Run tasks with at most `n` at once, keeping order of results. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
    }),
  );
  return out;
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
