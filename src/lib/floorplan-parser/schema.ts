import { z } from "zod";
import { ROOM_TYPES } from "@/lib/floorplan";

/**
 * What Claude returns when reading a floor plan drawing.
 * Deliberately room-centric: the model places rooms and openings in meters,
 * and code derives walls from shared room edges (see build.ts).
 */

const PointSchema = z.object({ x: z.number(), y: z.number() });

export const ParsedRoomSchema = z.object({
  name: z.string().describe("Room label as printed, e.g. 'PRIMARY BEDROOM'. Invent a short name for unlabeled spaces."),
  type: z.enum(ROOM_TYPES),
  labeledWidth: z.number().nullable().describe("First printed dimension in meters (horizontal on the drawing), or null"),
  labeledDepth: z.number().nullable().describe("Second printed dimension in meters, or null"),
  polygon: z
    .array(PointSchema)
    .describe("Outline in meters, clockwise, on wall centerlines. Rectangles have 4 points."),
});

export const ParsedOpeningSchema = z.object({
  kind: z.enum(["door", "window", "opening"]),
  x: z.number().describe("Center of the opening in meters, on the wall line"),
  y: z.number(),
  width: z.number().describe("Clear width in meters"),
  note: z.string().describe("Which rooms or wall it connects, e.g. 'kitchen to dining' or 'living room south wall'"),
});

export const ParsedPlanSchema = z.object({
  levelName: z.string(),
  scaleMethod: z.enum(["printed_dimensions", "estimated"]),
  rooms: z.array(ParsedRoomSchema),
  openings: z.array(ParsedOpeningSchema),
  warnings: z.array(z.string()).describe("Anything ambiguous or that could not be placed confidently"),
});

export type ParsedPlan = z.infer<typeof ParsedPlanSchema>;
export type ParsedRoom = z.infer<typeof ParsedRoomSchema>;
export type ParsedOpening = z.infer<typeof ParsedOpeningSchema>;
