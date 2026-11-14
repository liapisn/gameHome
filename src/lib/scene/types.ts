/**
 * Photos → furnished rooms: the data that flows between pipeline stages and to the viewer.
 * See docs/blender-loop-plan.md.
 */
import { z } from "zod";
import type { Furnishing, FurnishingKind } from "@/lib/tour/furnish";
import type { RoomLook } from "@/lib/tour/types";

export const SCENE_KINDS = [
  "sofa", "armchair", "coffeeTable", "tvUnit", "rug", "kitchen", "fridge", "diningTable", "pendant",
  "sideboard", "bed", "nightstand", "wardrobe", "desk", "bookshelf", "bathtub", "shower", "toilet",
  "vanity", "console", "bench", "plant", "floorLamp", "art", "shelves", "generic",
] as const satisfies readonly FurnishingKind[];
export type SceneKind = (typeof SCENE_KINDS)[number];

export const MATERIALS = ["fabric", "wood", "metal", "ceramic", "glass", "stone", "plastic", "leather"] as const;
export type SceneMaterial = (typeof MATERIALS)[number];

/** How an item is held up: decides how its pixels are lifted to 3D. */
export const MOUNTS = ["floor", "wall", "ceiling"] as const;
export type Mount = (typeof MOUNTS)[number];

/** [y, x] in 0–1000 image units (Gemini's native point format). */
export const Px = z.tuple([z.number(), z.number()]);
export type Px = z.infer<typeof Px>;
/** [ymin, xmin, ymax, xmax] in 0–1000 image units. */
export const Box2D = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Box2D = z.infer<typeof Box2D>;

/** One object as the model sees it in one photo: pixels only, no metres. */
export const Detection = z.object({
  label: z.string().describe("Short name of the object, e.g. 'corner sofa', 'tall glass display cabinet'"),
  kind: z.enum(SCENE_KINDS).describe("Closest kind from the list; 'generic' for anything else"),
  mount: z.enum(MOUNTS).describe("floor: stands on the floor · wall: hangs on a wall (art, wall cabinets, TV) · ceiling: hangs from it"),
  builtIn: z.boolean().describe("Fixed part of the home (fitted kitchen, built-in wardrobe, bathroom fixture, fireplace)"),
  color: z.string().describe("Dominant colour of its main surface as #rrggbb"),
  material: z.enum(MATERIALS).describe("Main material of its visible surface"),
  box: Box2D.describe("Tight 2D bounding box of the visible object: [ymin, xmin, ymax, xmax], 0–1000"),
  floorPoints: z
    .array(Px)
    .describe(
      "Floor items: the visible bottom corners of its footprint where it meets the floor, [y, x] 0–1000, 0–4 points. " +
        "For legged furniture use the feet; for cabinets, the bottom corners of the plinth. Empty for wall/ceiling items or when no contact is visible.",
    ),
  topPoints: z
    .array(z.object({ floorIndex: z.number().int().describe("Index into floorPoints"), point: Px.describe("[y, x] 0–1000") }))
    .describe("For one or two floorPoints: the point straight above it on the object's top edge"),
  faceCorners: z
    .array(Px)
    .describe("Wall and ceiling items: the visible corners of the object's front face, [y, x] 0–1000, up to 4. Empty for floor items."),
  againstWall: z.boolean().describe("Its back touches a wall"),
});
export type Detection = z.infer<typeof Detection>;

/** Detection with its photo and a stable id (`${photoId}:${n}`). */
export interface PhotoDetection extends Detection {
  id: string;
  photoId: string;
}

export interface SceneItem extends Omit<Furnishing, "label"> {
  kind: SceneKind | FurnishingKind;
  label: string;
  color?: string;
  material?: SceneMaterial;
  builtIn?: boolean;
  /** Pieces of one object, e.g. the two runs of an L-shaped kitchen. */
  group?: string;
  /** Library or generated model; falls back to the primitive. */
  asset?: string;
  source: "photos" | "rules";
  /** Photo ids the item was seen in. */
  seenIn: string[];
  /** Detections it was built from. */
  detections: string[];
  confidence: number;
  /** Size as measured from the photos when the kind's limits changed it (kept for scoring pose work). */
  measured?: { w: number; d: number; h: number };
}

export interface PhotoGate {
  id: string;
  gate: "pass" | "fail";
  reason: string;
  /** Floor contacts of nearby items (within `NEAR_CONTACT` of the camera) inside / outside the room. */
  contacts?: { inside: number; outside: number };
}

export interface RoomScene {
  tourId: string;
  levelId: string;
  roomId: string;
  roomName: string;
  look: RoomLook | null;
  items: SceneItem[];
  photos: PhotoGate[];
  /** Mean box overlap from the check stage (null before it ran). */
  score: number | null;
  rounds: { round: number; score: number; kept: boolean; changes: number }[];
  model: string;
  builtAt: string;
}

export const sceneKey = (levelId: string, roomId: string) => `${levelId}/${roomId}`;
