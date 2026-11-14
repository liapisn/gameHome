/**
 * Stage 0: is this photo really in this room, with a usable pose?
 *
 * The room as the stored pose sees it is drawn on the photo (outline + doors/windows with ids) and
 * the model judges each element. The model compares lines with what it sees; it never measures.
 * The floor-point sanity check (most detected contacts land outside the room) runs later, in
 * build-scene, once detections exist.
 */
import { z } from "zod";
import type { FloorPlan, Room } from "@/lib/floorplan";
import { generateStructured } from "@/lib/ai/structured";
import type { PoseFit } from "@/lib/tour/types";
import { outlineOverlay } from "./overlay";
import type { PhotoCamera } from "./project";

const Fit = z.enum(["aligned", "roughly", "off", "not-visible"]);

export const GateAnswer = z.object({
  roomKind: z
    .enum(["yes", "no", "unsure"])
    .describe("Does the photo show the kind of room named (e.g. a kitchen for 'Kitchen')? Combined rooms count as yes."),
  ceilingLines: Fit.describe("Red lines vs the real wall/ceiling junctions"),
  floorLines: Fit.describe("Blue lines vs the real wall/floor junctions (where visible behind furniture)"),
  corners: Fit.describe("Yellow vertical lines vs the real room corners"),
  openings: z
    .array(
      z.object({
        id: z.string(),
        verdict: z.enum(["matches", "shifted", "nothing-there", "hidden"]).describe(
          "matches: a real door/window of that kind is under the dashed box · shifted: there is one nearby · nothing-there: plain wall where the box is · hidden: blocked or out of view",
        ),
      }),
    )
    .describe("One entry per drawn door/window id"),
  extraOpenings: z.number().int().describe("Real doors/windows on the outlined walls that no dashed box covers"),
  verdict: z.enum(["pass", "fail"]).describe("pass: the drawn room is the room in the photo and the lines sit on (or within a hand's width of) the real edges"),
  reason: z.string().describe("One sentence"),
});
export type GateAnswer = z.infer<typeof GateAnswer>;

const SYSTEM = `You check whether a real-estate photo was assigned to the right room of a floor plan.

You get the original photo and the same photo with the plan's room drawn over it from the solved
camera position:
- red: where the room's walls meet the ceiling · blue: walls meet the floor · yellow: room corners
- dashed green boxes: the plan's doors in this room's walls, dashed purple boxes: its windows, with ids.

The camera pose was fitted to make the red/blue/yellow lines follow edges in the photo, so those
lines usually look plausible EVEN IN THE WRONG ROOM. Don't rely on them. The real test is:
1. The doors and windows: in the right room, each dashed box sits on (or close to) a real door or
   window of that kind — a window box on a window or glass door, a door box on a door or doorway.
   In the wrong room the boxes land on plain wall, cabinets or pictures while the real doors and
   windows are somewhere no box is. Boxes cut off by the image border, or behind tall furniture,
   are 'hidden'. A box a little offset from a real opening is 'shifted', which is fine.
2. The kind of room: a bedroom photo assigned to an office or a kitchen is wrong. Rooms are often
   used loosely (a desk in a bedroom), so only say 'no' when the photo clearly shows another kind.
Line verdicts: aligned / roughly / off / not-visible — report what you see, it's secondary.
Decide fail only on clear evidence (openings on plain wall while real ones are elsewhere, or the
wrong kind of room); otherwise pass.`;

export interface GateResult {
  pass: boolean;
  reason: string;
  answer: GateAnswer | null;
  overlay: Buffer;
}

export async function gatePhoto(opts: {
  photoFile: string;
  photoJpeg: Buffer;
  cam: PhotoCamera;
  plan: FloorPlan;
  room: Room;
  ceiling: number;
  fit: PoseFit | null;
  levelName: string;
  /** The owner filed this photo under a different level: fail without asking. */
  ownerLevelMismatch?: boolean;
}): Promise<GateResult & { model?: string }> {
  const { image, openings } = await outlineOverlay(opts);
  if (opts.ownerLevelMismatch) return { pass: false, reason: "owner filed the photo under another floor", answer: null, overlay: image };

  const res = await generateStructured({
    schema: GateAnswer,
    system: SYSTEM,
    parts: [
      { type: "text", text: `Room: "${opts.room.name}" (${opts.room.type}) on ${opts.levelName}. Pose found by: ${opts.fit?.method ?? "unknown"}.` },
      { type: "text", text: "Original photo:" },
      { type: "image", data: opts.photoJpeg.toString("base64"), mediaType: "image/jpeg" },
      { type: "text", text: `With the room drawn. Drawn openings: ${openings.map((o) => `${o.id} (${o.kind}${o.visible ? "" : ", centre off-frame"})`).join(", ") || "none"}.` },
      { type: "image", data: image.toString("base64"), mediaType: "image/jpeg" },
    ],
  });
  const a = res.data;
  // Code-side decision from the per-element answers, counting only openings fully in frame.
  const full = new Set(openings.filter((o) => o.inFrame).map((o) => o.id));
  const judged = a.openings.filter((o) => full.has(o.id) && o.verdict !== "hidden");
  const onWall = judged.filter((o) => o.verdict === "nothing-there").length;
  const onOpening = judged.length - onWall;
  let pass = true;
  let reason = a.reason;
  if (a.roomKind === "no") [pass, reason] = [false, `not a ${opts.room.type}: ${a.reason}`];
  else if (onWall >= 1 && onWall > onOpening) [pass, reason] = [false, `${onWall}/${judged.length} in-frame openings on plain wall: ${a.reason}`];
  else if (a.verdict === "fail" && onWall >= 1) [pass, reason] = [false, a.reason];
  return { pass, reason, answer: a, overlay: image, model: res.model };
}
