import { generateStructured, type ImageMediaType } from "@/lib/ai/structured";
import { ParsedPlanSchema, type ParsedPlan } from "./schema";

const SYSTEM_PROMPT = `You convert architectural floor plan drawings into precise geometry for a 3D renderer.

Coordinate system: meters, origin at the top-left of the drawing, x to the right, y downward.

Scale: rooms usually carry printed interior dimensions such as "4.81m x 4.86m". The first number is the horizontal extent on the drawing and the second the vertical, unless the label is rotated with the room. Use them to fix the scale, then measure unlabeled spaces (closets, stairs, small storage) proportionally from the drawing. If there are no printed dimensions, estimate from typical door widths (~0.8-0.9 m) and set scaleMethod to "estimated".

Rooms:
- Return every enclosed space, including closets, storage, hallways and the stair area (type "stairs").
- Trace each outline on the wall centerlines, so two rooms that share a wall use exactly the same coordinate for it. A printed interior dimension is about one wall thickness (0.1-0.25 m) smaller than the centerline extent.
- Use 4-point rectangles where the room is rectangular, and more points for L-shapes or angled walls. List points clockwise.
- Rooms must not overlap, and the overall footprint should be continuous, with no gaps between neighbouring rooms.

Openings:
- Include every door (swing arc), window (thin double line in an exterior wall), and open passage without a door ("opening").
- Give the center point on the wall line and the clear width.

List anything ambiguous in warnings instead of guessing silently.`;

export interface ParseOptions {
  imageBase64: string;
  mediaType: ImageMediaType;
  /** Extra context, e.g. "upper floor of a two-storey house". */
  hint?: string;
  /**
   * Gemini thinking level. Medium by default: on a test plan it found the same rooms as high in
   * 128 s instead of 328 s (high used up its output budget and had to retry), and a plan read
   * has to fit in one Vercel function (300 s on Hobby).
   */
  effort?: "low" | "medium" | "high";
}

export interface ParseResult {
  parsed: ParsedPlan;
  model: string;
  usage: { input: number; output: number };
}

export async function parseFloorPlanImage(opts: ParseOptions): Promise<ParseResult> {
  const { data, model, usage } = await generateStructured({
    schema: ParsedPlanSchema,
    system: SYSTEM_PROMPT,
    effort: opts.effort ?? "medium",
    parts: [
      { type: "image", data: opts.imageBase64, mediaType: opts.mediaType },
      {
        type: "text",
        text: `Convert this floor plan into rooms and openings.${opts.hint ? ` Context: ${opts.hint}` : ""}`,
      },
    ],
  });
  return { parsed: data, model, usage };
}
