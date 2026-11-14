/**
 * Stage 1: one model call per gated photo → the objects in it, as pixels.
 * The model names things and points at image positions; lift.ts turns those into metres.
 */
import { z } from "zod";
import { OPEN_PLAN, ROOM_TYPES, type Room, type RoomType } from "@/lib/floorplan";
import { generateStructured } from "@/lib/ai/structured";
import { Detection, SCENE_KINDS } from "./types";

export const DetectAnswer = z.object({
  cameraRoom: z
    .enum([...ROOM_TYPES, "entry", "other"])
    .describe("Your own judgement of the kind of room the CAMERA STANDS IN (not rooms seen through openings)"),
  items: z.array(Detection),
});

/**
 * Does the model's room kind contradict the room the photo was placed in? Lenient: open-plan
 * kinds, entries (which plans file as hallways, kitchens or living rooms) and 'other' never do.
 */
export function roomKindConflict(placed: RoomType, seen: z.infer<typeof DetectAnswer>["cameraRoom"]): boolean {
  if (seen === placed || seen === "other" || seen === "entry") return false;
  return !OPEN_PLAN.some((g) => g.includes(placed) && g.includes(seen));
}

export const KIND_GUIDE = `Kinds (use the closest; 'generic' for anything else, with a precise label):
- kitchen: one straight run of base cabinets with worktop (an L-shaped kitchen is TWO kitchen items, one per wall). Tall built-in units next to it (oven tower, pantry) are 'generic' builtIn.
- fridge: fridge or fridge-freezer, freestanding or integrated tall unit
- diningTable, coffeeTable, desk, console (narrow hall/sofa table), sideboard (low cabinet/buffet), tvUnit
- sofa, armchair, bench, bed, nightstand, wardrobe (tall closet), bookshelf (with books), shelves (open shelving or display units)
- bathtub, shower, toilet, vanity (basin cabinet)
- rug, plant, floorLamp, pendant (hanging ceiling light), art (framed picture or mirror on a wall)
- generic: e.g. display cabinet, tall glass cabinet, wall cabinets (mount 'wall'), fireplace, radiator, washing machine, stool, chair.
Do not list individual dining chairs that belong to a table, small objects on surfaces, curtains, or ceiling fans.`;

const SYSTEM = `You annotate furniture and fixtures in real-estate photos so they can be rebuilt in 3D.

Coordinates: points are [y, x] and boxes are [ymin, xmin, ymax, xmax], all normalised to 0–1000
(top-left is [0, 0]). Be precise: the 3D positions are computed from your pixels with the known
camera, so a point 10 units off moves an object by many centimetres.

For every object that stands on or hangs in the room:
- box: tight around the visible part.
- floorPoints (floor items): where the object physically touches the floor — the bottom corners of
  its footprint that you can actually see (feet of a table or sofa, bottom corners of a cabinet's
  plinth or kickboard). Give 2–4 when visible, ordered left to right. Never guess hidden corners;
  never give points on the object's top or on the wall. For a rug, its visible corners.
- topPoints: for one or two of the floorPoints, the point straight above it on the object's top
  edge (worktop edge, table top, sofa back, fridge top).
- faceCorners (wall/ceiling items): the visible corners of the front face.
- againstWall: true if its back touches a wall.
- color: dominant colour of the main surface as you see it in the photo (#rrggbb).
Include built-in fixtures (fitted kitchen runs, built-in wardrobes, bathroom fixtures, fireplaces).
Each physical object once. Skip objects less than ~20% visible.`;

export async function detectPhoto(opts: { photoJpeg: Buffer; room: Room; levelName: string }) {
  const res = await generateStructured({
    schema: DetectAnswer,
    system: `${SYSTEM}\n\n${KIND_GUIDE}`,
    parts: [
      {
        type: "text",
        text: `An automatic step placed this photo in the "${opts.room.name}" (${opts.room.type}) on ${opts.levelName}; that may be wrong, so judge cameraRoom from the photo alone. Allowed object kinds: ${SCENE_KINDS.join(", ")}.`,
      },
      { type: "image", data: opts.photoJpeg.toString("base64"), mediaType: "image/jpeg" },
    ],
  });
  return { items: res.data.items, cameraRoom: res.data.cameraRoom, model: res.model, usage: res.usage };
}
