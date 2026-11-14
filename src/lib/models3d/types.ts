/**
 * Contracts between the workers that turn a furnished room's items into generated 3D models.
 * See docs/agent-tree-plan.md.
 */
import type { Box2D, SceneKind, SceneMaterial } from "@/lib/scene/types";

export interface ObjectView {
  photoId: string;
  /** Absolute path of the photo. */
  photoFile: string;
  /** [ymin, xmin, ymax, xmax], 0–1000. */
  box: Box2D;
}

/** Room worker → object worker: one model to make, possibly placed many times. */
export interface ObjectBrief {
  /** Model id; items that are the same object share it (a pair of nightstands, the dining chairs). */
  assetId: string;
  label: string;
  kind: SceneKind;
  /** Views of this object (of one of its copies). Empty: no photo shows it; the reference is drawn from the label. */
  views: ObjectView[];
  /** Target size in metres: w along the front, d front to back, h height. */
  size: { w: number; d: number; h: number };
  color?: string;
  material?: SceneMaterial;
  /** Extra words for the reference, e.g. "the dining chairs around this table, one chair only". */
  note?: string;
  /** Built to the exact size of a wall run (fitted kitchens, wardrobes). */
  fit?: "exact";
  wall?: { length: number; cornerAt?: "left" | "right"; notes?: string };
  workDir: string;
}

export type Generator = "tripo-h31" | "meshy";

/** Object worker → room worker. */
export interface ObjectResult {
  assetId: string;
  status: "ok" | "failed";
  /** Prepared model: metres, front −Y, origin at the centre of its footprint on the floor. */
  glb?: string;
  /** As built, metres. */
  size?: { w: number; d: number; h: number };
  generator?: Generator;
  /** The clean product image the model was made from. */
  reference?: string;
  /** Same-light render of the picked model. */
  preview?: string;
  attempts: number;
  /** Why this one was picked, or why it failed. */
  reason: string;
  /** No photo showed it: drawn from its label. */
  invented?: boolean;
  /** Code worker: the critic's score (0–10) of the chosen run, and the Blender code it ran. */
  score?: number;
  script?: string;
}
