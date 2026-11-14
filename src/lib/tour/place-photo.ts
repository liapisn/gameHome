/**
 * Photo → (level, room, camera pose, finishes) with a vision model.
 *
 * The model does what it is good at: recognising the room and naming landmarks it can see
 * (by feature id from the plan's table) with their image positions. The camera pose itself is
 * then solved geometrically from those landmarks (solve-pose.ts), using the model's own pose
 * guess only as a prior.
 */
import { z } from "zod";
import { generateStructured, type Part } from "@/lib/ai/structured";
import type { FloorPlan } from "@/lib/floorplan";
import { describePlan, type PlanFeature, planFeatures } from "./features";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const PlacementSchema = z.object({
  view: z
    .string()
    .describe(
      "First, what the photo shows from left to right: each wall, corner, door and window in order, and which wall is behind the camera",
    ),
  levelId: z.string().describe("Id of the level the photo was taken on, or 'none' if it is on no supplied plan"),
  roomId: z.string().nullable().describe("Id of the room the camera stands in, from that level's room list; null if 'none'"),
  location: z.string().describe("Short place description, e.g. 'living room, by the balcony door' or 'garden, rear'"),
  caption: z.string().describe("One short sentence describing the view, for a tour caption"),
  confidence: z.enum(["high", "medium", "low"]).describe("Confidence in the level and room"),
  landmarks: z
    .array(
      z.object({
        featureId: z.string().describe("Feature id from the level's table, e.g. C7 or o3:a"),
        what: z.string().describe("What it is in the photo, e.g. 'left frame of the balcony door'"),
        u: z.number().describe("Horizontal image position of the vertical edge, 0 = left edge, 1 = right edge"),
        v: z
          .number()
          .nullable()
          .describe("Vertical image position where that edge meets the floor, 0 = top, 1 = bottom; null if hidden"),
      }),
    )
    .describe("3–8 plan features clearly visible in the photo, spread across the frame, room corners first. Empty when levelId is 'none'."),
  estimate: z
    .object({
      x: z.number(),
      y: z.number(),
      yawDeg: z.number().describe("Viewing direction in plan space: 0 = towards +x (right on the drawing), 90 = towards +y (down)"),
      hfovDeg: z.number().describe("Horizontal field of view; listing photos are usually 70–110°"),
      cameraHeight: z.number().describe("Lens height above the floor in meters, usually 1.0–1.6"),
    })
    .nullable()
    .describe("Your best guess of where the camera stood; null if levelId is 'none'"),
  look: z
    .object({ floor: hex.describe("Dominant floor color"), walls: hex.describe("Dominant wall color") })
    .describe("Representative colors of the room's finishes as seen in the photo"),
});

export type Placement = z.infer<typeof PlacementSchema>;

const SYSTEM_PROMPT = `You place real-estate photos on floor plans so a 3D tour can show each photo from the exact spot it was taken.

You get one or more levels. For each: the floor plan drawing, the room list with outlines, and a table of features
(wall corners and door/window jambs) with coordinates. Coordinates are meters with origin at the top-left of the drawing,
x to the right and y downward, exactly matching the drawing.

For the photo:
1. Describe what you see from left to right: walls, the corners where they meet, doors, windows, fixtures. Work out which
   wall the camera has its back to.
2. Decide which level and room the camera stands in. Use fixtures that appear on the plan (fireplace, kitchen run, bathtub,
   wardrobes, stairs), window and door positions, and room proportions. Listings often include places on none of the plans
   (garden, façade, another unit): then set levelId to "none" rather than forcing a match.
3. Pick 3–8 features from that level's table that you can see as vertical edges. Room corners (where two walls meet) are the
   most reliable: include every room corner you can see, then door and window frames. Spread them across the image, ideally
   one near each side and one near the middle. Feature descriptions say where each one is on the drawing ("top-right corner
   of Kitchen"); make sure the one you pick matches the corner you see, given which way the camera faces.
   For each: u = horizontal position of the vertical edge (0 = left edge of the photo, 1 = right edge);
   v = vertical position where it meets the floor (0 = top, 1 = bottom), or null if that point is hidden or out of frame.
   The photos are shot level from ~1.2–1.5 m, so floor contacts are always below the middle (v > 0.5).
   Be precise: these numbers are used to solve the camera pose. Fewer correct features beat more doubtful ones.
4. Estimate where the camera stood (x, y), its viewing direction (yawDeg: 0 = towards +x / right on the drawing,
   90 = towards +y / down, 180 = left, 270 = up), horizontal field of view and lens height. Real-estate photos are wide
   (often 80–105°), shot level, usually from a corner or doorway looking into the room. Check that the features you listed
   would appear in that order from left to right from your estimated position.
4. Report the dominant floor and wall colors.`;

export interface LevelInput {
  id: string;
  name: string;
  plan: FloorPlan;
  /** Floor plan drawing (base64 JPEG) the plan was parsed from. */
  drawing: string;
}

export interface PreparedLevels {
  shared: Part[];
  features: Map<string, Map<string, PlanFeature>>;
}

/**
 * Build the shared prompt prefix once per tour; it is identical for every photo.
 * `otherAreas` describes parts of the listing that are on no plan (second unit, garden…).
 */
export function prepareLevels(levels: LevelInput[], otherAreas: string[] = []): PreparedLevels {
  const shared: Part[] = [];
  const features = new Map<string, Map<string, PlanFeature>>();
  for (const level of levels) {
    const f = planFeatures(level.plan);
    features.set(level.id, new Map(f.map((x) => [x.id, x])));
    shared.push({ type: "text", text: `Floor plan drawing for level "${level.id}":` });
    shared.push({ type: "image", data: level.drawing, mediaType: "image/jpeg" });
    shared.push({ type: "text", text: describePlan(level.id, level.name, level.plan, f) });
  }
  if (otherAreas.length) {
    shared.push({
      type: "text",
      text: `The listing also has areas that are on none of these plans; photos of them get levelId "none":\n${otherAreas.map((a) => `  - ${a}`).join("\n")}`,
    });
  }
  return { shared, features };
}

export async function placePhoto(prepared: PreparedLevels, photo: { name: string; base64: string; hint?: string }) {
  return generateStructured({
    schema: PlacementSchema,
    system: SYSTEM_PROMPT,
    shared: prepared.shared,
    effort: "high",
    parts: [
      { type: "text", text: `Photo "${photo.name}":` },
      { type: "image", data: photo.base64, mediaType: "image/jpeg" },
      { type: "text", text: `Place this photo.${photo.hint ? ` Context: ${photo.hint}` : ""}` },
    ],
  });
}
