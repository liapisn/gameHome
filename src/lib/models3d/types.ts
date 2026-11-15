/**
 * Contracts between the workers that turn a furnished room's items into generated 3D models.
 * See docs/agent-tree-plan.md and docs/boxd-models-plan.md.
 */
import type { Box2D, SceneKind, SceneMaterial } from "@/lib/scene/types";

export interface ObjectView {
  photoId: string;
  /** Absolute path of the photo. */
  photoFile: string;
  /** [ymin, xmin, ymax, xmax], 0–1000. */
  box: Box2D;
}

/** Room worker → room agent: one model to make, possibly placed many times. */
export interface ObjectBrief {
  /** Model id; items that are the same object share it (a pair of nightstands, the dining chairs). */
  assetId: string;
  label: string;
  kind: SceneKind;
  /** Views of this object (of one of its copies). Empty: no photo shows it; it is designed from the label. */
  views: ObjectView[];
  /** Target size in metres: w along the front, d front to back, h height. */
  size: { w: number; d: number; h: number };
  color?: string;
  material?: SceneMaterial;
  /** Extra words for the design, e.g. "the dining chairs around this table, one chair only". */
  note?: string;
  /** Built to the exact size of a wall run (fitted kitchens, wardrobes). */
  fit?: "exact";
  wall?: { length: number; cornerAt?: "left" | "right"; notes?: string };
  workDir: string;
}

/** Room agent → room worker: one brief's model. */
export interface ObjectResult {
  assetId: string;
  status: "ok" | "failed";
  /** Prepared model: metres, front −Y, origin at the centre of its footprint on the floor. */
  glb?: string;
  /** As built, metres. */
  size?: { w: number; d: number; h: number };
  /** Studio render of the chosen model, from the front. */
  preview?: string;
  attempts: number;
  /** The critic's summary of the chosen run, or why it failed. */
  reason: string;
  /** No photo showed it: drawn from its label. */
  invented?: boolean;
  /** Code worker: the critic's score (0–10) of the chosen run, and the Blender code it ran. */
  score?: number;
  script?: string;
  /** The photos show a clearly different overall size than the target: the scene's size needs fixing. */
  sizeConflict?: { target: { w: number; d: number; h: number }; estimate?: { w: number; d: number; h: number } };
  /**
   * The last try failed to build and there were no rounds left: `code` = the code errored, `infra` =
   * the machine didn't finish. Not marked finished, so the next build retries it.
   */
  flag?: { kind: "code" | "infra"; error: string };
}
