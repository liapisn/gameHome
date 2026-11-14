/**
 * A quick first guess of which room on the floor plans a photo was taken in: one vision call with
 * the plan drawings and their room lists. Shown to the owner to confirm or correct before a build;
 * much lighter than placement (place-photo.ts), which also solves where the camera stood.
 */
import { z } from "zod";
import { generateStructured, type Part } from "@/lib/ai/structured";
import { type FloorPlan, polygonArea } from "@/lib/floorplan";

export const RoomGuess = z.object({
  seen: z.string().describe("First, in one or two sentences: what the photo shows (fixtures, finishes, doors, windows, view)"),
  levelId: z.string().describe("Id of the floor the camera stands on, or 'none' when it is on no supplied plan (street, façade, building stairwell, another unit)"),
  roomId: z.string().nullable().describe("Id of the room the camera stands in, from that floor's room list; null when levelId is 'none'"),
  confidence: z.enum(["high", "medium", "low"]).describe("high: only this room fits; medium: likely, another room could fit; low: a guess"),
  reason: z.string().describe("Short reason a person can check, e.g. 'bathtub across the cut corner, as drawn'"),
});
export type RoomGuess = z.infer<typeof RoomGuess>;

export interface RoomEstimate {
  levelId: string | null;
  roomId: string | null;
  confidence: RoomGuess["confidence"];
  reason: string;
  model: string;
  at: string;
}

const SYSTEM = `You match real-estate photos to the rooms of a floor plan.

You get each floor's plan drawing and its room list (id · name · kind · size), then one photo.
Decide where the camera stands:
- Use what the plan shows: fixtures drawn on it (kitchen run, bathtub, WC, basin, stairs), the room's
  shape and size, its doors and windows, balcony doors, and what can be seen through openings.
- Rooms of the same kind (two bedrooms, two bathrooms) differ in size, shape, windows and fixtures:
  pick the one that matches, and lower the confidence when you cannot tell.
- In an open space split into rooms on the plan (living / dining / kitchen), pick the part the camera
  stands in, not the part it looks at.
- Photos of the street, the façade, the building's entrance, lobby or stairwell, or another unit are on
  no plan: levelId "none", roomId null.
- Virtually staged or renovated renders still show the room's walls, windows and doors: match those.`;

export interface EstimateLevel {
  id: string;
  name: string;
  plan: FloorPlan;
  /** The plan drawing, base64 JPEG. */
  drawing: string;
}

const describeRooms = (l: EstimateLevel) =>
  [
    `FLOOR ${l.id}: ${l.name}`,
    ...l.plan.rooms.map(
      (r) =>
        `  ${r.id} · ${r.name} · ${r.type} · ${r.labeled ? `${r.labeled.width.toFixed(2)} × ${r.labeled.depth.toFixed(2)} m` : `${polygonArea(r.polygon).toFixed(1)} m²`}`,
    ),
  ].join("\n");

/** The plans as shared prompt parts: the same for every photo of a property, so cached across calls. */
export function estimateContext(levels: EstimateLevel[], otherAreas: string[] = []): Part[] {
  const parts: Part[] = [];
  for (const l of levels) {
    parts.push({ type: "text", text: `Plan drawing of floor "${l.id}":` });
    parts.push({ type: "image", data: l.drawing, mediaType: "image/jpeg" });
    parts.push({ type: "text", text: describeRooms(l) });
  }
  if (otherAreas.length) parts.push({ type: "text", text: `Floors without a plan (photos there get levelId "none"): ${otherAreas.join("; ")}` });
  return parts;
}

/**
 * Guess the room of one photo. Answers naming a floor or room that isn't on the plans come back
 * as "no room" with low confidence rather than as an invented id.
 */
export async function estimateRoom(
  levels: EstimateLevel[],
  shared: Part[],
  photo: { base64: string; ownerLevelId?: string | null; note?: string | null },
): Promise<RoomEstimate> {
  const owner = photo.ownerLevelId ? levels.find((l) => l.id === photo.ownerLevelId) : undefined;
  const context = [
    owner ? `The owner filed this photo under floor "${owner.id}" (${owner.name}).` : "",
    photo.note ? `The owner's note: "${photo.note}".` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const res = await generateStructured({
    schema: RoomGuess,
    system: SYSTEM,
    shared,
    effort: "medium",
    parts: [
      { type: "text", text: "The photo:" },
      { type: "image", data: photo.base64, mediaType: "image/jpeg" },
      { type: "text", text: `Which room was this taken in?${context ? ` ${context}` : ""}` },
    ],
  });
  const g = res.data;
  const level = levels.find((l) => l.id === g.levelId);
  const room = level?.plan.rooms.find((r) => r.id === g.roomId);
  const at = new Date().toISOString();
  if (g.levelId === "none") return { levelId: null, roomId: null, confidence: g.confidence, reason: g.reason, model: res.model, at };
  if (!level || !room) return { levelId: level?.id ?? null, roomId: null, confidence: "low", reason: g.reason, model: res.model, at };
  return { levelId: level.id, roomId: room.id, confidence: g.confidence, reason: g.reason, model: res.model, at };
}
