/**
 * Object worker: one object's photos → one model, written as Blender code by Gemini and built on
 * boxd (code-worker.ts, docs/boxd-models-plan.md part 3).
 */
import { runCodeObjectWorker } from "./code-worker";
import type { ObjectBrief, ObjectResult } from "./types";

/** Upright things are scaled by height; flat ones (rugs, low tables wider than tall) by footprint. */
export const fitFor = (size: ObjectBrief["size"]) => (size.h >= 0.25 * Math.max(size.w, size.d) ? "upright" : "flat");

export function runObjectWorker(brief: ObjectBrief, log: (m: string) => void = () => {}): Promise<ObjectResult> {
  return runCodeObjectWorker(brief, log);
}
