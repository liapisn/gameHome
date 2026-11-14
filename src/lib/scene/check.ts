/**
 * Stage 3: draw the scene's boxes on each photo, score them without a model, and ask the model
 * which boxes are wrong — as corrected pixels, never metres. Corrections go back through the lift.
 */
import { z } from "zod";
import { generateStructured } from "@/lib/ai/structured";
import { itemBox } from "./lift";
import { KIND_GUIDE } from "./detect";
import { boxCorners, iou, projectedBounds, type PhotoCamera } from "./project";
import { Detection, type PhotoDetection, type SceneItem } from "./types";

/** Image-space bounds of a detection: [u0, v0, u1, v1]. */
export const detBounds = (d: Pick<Detection, "box">): [number, number, number, number] => [d.box[1] / 1000, d.box[0] / 1000, d.box[3] / 1000, d.box[2] / 1000];

export function boundsOf(cam: PhotoCamera, it: SceneItem) {
  const b = itemBox(it);
  return projectedBounds(cam, boxCorners(b.x0, b.y0, b.x1, b.y1, b.z0, b.z1));
}

/**
 * Room score: mean IoU between each detection's 2D box and the projected 3D box of the item it
 * became. Detections that produced no item score 0; detected items drawn in a photo where nothing
 * was detected for them count at a quarter weight (they may just be occluded).
 */
export function scoreScene(items: SceneItem[], dets: PhotoDetection[], cams: Map<string, PhotoCamera>) {
  let sum = 0;
  let n = 0;
  const perPhoto: Record<string, number> = {};
  for (const [photoId, cam] of cams) {
    let ps = 0;
    let pn = 0;
    for (const d of dets.filter((x) => x.photoId === photoId)) {
      const it = items.find((i) => i.detections.includes(d.id));
      const b = it ? boundsOf(cam, it) : null;
      const s = b ? iou(b, detBounds(d)) : 0;
      ps += s;
      pn += 1;
    }
    for (const it of items) {
      if (it.source !== "photos" || it.seenIn.includes(photoId)) continue;
      const b = boundsOf(cam, it);
      if (b && (b[2] - b[0]) * (b[3] - b[1]) > 0.01) pn += 0.25;
    }
    if (pn) perPhoto[photoId] = Math.round((ps / pn) * 1000) / 1000;
    sum += ps;
    n += pn;
  }
  return { score: n ? Math.round((sum / n) * 1000) / 1000 : 0, perPhoto };
}

const Fix = Detection.pick({ box: true, floorPoints: true, topPoints: true, faceCorners: true, againstWall: true });

export const CheckAnswer = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        verdict: z.enum(["good", "misplaced", "nothing-there", "out-of-view"]).describe(
          "good: the box wraps the real object · misplaced: the object is there but the box is off (give fix) · nothing-there: the box sits where no such object is · out-of-view",
        ),
        fix: Fix.nullable().describe("For misplaced: the object's real pixels, same conventions as detection"),
      }),
    )
    .describe("One entry per drawn id"),
  missing: z.array(Detection).describe("Clearly visible furniture or fixtures that have no box at all"),
});
export type CheckAnswer = z.infer<typeof CheckAnswer>;

const SYSTEM = `You check a 3D reconstruction of a room against the real photo.

You get the original photo and the same photo with each reconstructed object drawn as a 3D
wireframe box (solid lines: from photos; dashed: guessed from the floor plan), labelled with its id.
For each id, say whether the box wraps the real object. A box is good when its bottom edges sit on
the object's floor contact and its top on the object's top, within a few centimetres in the scene.
For misplaced ones give the object's real pixels so the position can be recomputed: floorPoints
(visible bottom corners where it touches the floor), topPoints (straight above a floor point, on its
top edge), faceCorners for wall-hung items, and a tight box.

Coordinates: points [y, x], boxes [ymin, xmin, ymax, xmax], normalised 0–1000 on the ORIGINAL photo.
Then list clearly visible objects that have no box (same fields as a detection). Do not report
small objects, chairs belonging to a table, curtains or ceiling fans.`;

export async function checkPhoto(opts: { photoJpeg: Buffer; overlay: Buffer; items: SceneItem[]; roomName: string }) {
  const res = await generateStructured({
    schema: CheckAnswer,
    system: `${SYSTEM}\n\n${KIND_GUIDE}`,
    parts: [
      { type: "text", text: `Room: ${opts.roomName}. Drawn boxes: ${opts.items.map((i) => `${i.id} = ${i.label}`).join("; ")}.` },
      { type: "text", text: "Original photo:" },
      { type: "image", data: opts.photoJpeg.toString("base64"), mediaType: "image/jpeg" },
      { type: "text", text: "With the reconstruction drawn:" },
      { type: "image", data: opts.overlay.toString("base64"), mediaType: "image/jpeg" },
    ],
  });
  return { answer: res.data, model: res.model };
}

/** Apply one photo's corrections to the detection set. Returns the new set and how many changed. */
export function applyCheck(dets: PhotoDetection[], items: SceneItem[], photoId: string, answer: CheckAnswer): { dets: PhotoDetection[]; changes: number } {
  let out = [...dets];
  let changes = 0;
  let next = Math.max(-1, ...out.filter((d) => d.photoId === photoId).map((d) => Number(d.id.split(":")[1]))) + 1;
  for (const v of answer.items) {
    const it = items.find((i) => i.id === v.id);
    if (!it || it.source !== "photos") continue;
    const mine = out.find((d) => d.photoId === photoId && it.detections.includes(d.id));
    if (v.verdict === "misplaced" && v.fix) {
      if (mine) out = out.map((d) => (d === mine ? { ...d, ...v.fix! } : d));
      else {
        const like = out.find((d) => it.detections.includes(d.id))!;
        out.push({ ...like, ...v.fix, id: `${photoId}:${next++}`, photoId });
      }
      changes++;
    } else if (v.verdict === "nothing-there" && mine) {
      out = out.filter((d) => d !== mine);
      changes++;
    }
  }
  for (const m of answer.missing) {
    out.push({ ...m, id: `${photoId}:${next++}`, photoId });
    changes++;
  }
  return { dets: out, changes };
}
