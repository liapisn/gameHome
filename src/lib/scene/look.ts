/**
 * Stage 4 colour pass: the photo beside a Blender render from the same camera. The model may only
 * change colours and materials (and the room's floor/wall look); geometry stays with the lift.
 */
import { z } from "zod";
import { generateStructured } from "@/lib/ai/structured";
import { MATERIALS, type RoomScene } from "./types";

export const LookAnswer = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        color: z.string().describe("Main colour as it should be rendered, #rrggbb"),
        material: z.enum(MATERIALS),
      }),
    )
    .describe("Only items whose colour or material should change"),
  floor: z.string().nullable().describe("Floor colour #rrggbb if the render's floor is clearly off, else null"),
  walls: z.string().nullable().describe("Wall colour #rrggbb if the render's walls are clearly off, else null"),
});
export type LookAnswer = z.infer<typeof LookAnswer>;

const SYSTEM = `You compare a real photo of a room with a 3D render of its reconstruction from the same camera.
Geometry is fixed; you only correct colours and materials so the render reads like the photo.
For each object id that looks clearly wrong (a white cabinet rendered grey, wood rendered as fabric),
give its corrected main colour as #rrggbb, sampled from the real object's lit surface in the photo
(not its shadow or highlight), and its material. Leave out objects that are already close.
Give the floor or wall colour only if the render's is clearly different from the photo.`;

export async function lookPass(opts: { photoJpeg: Buffer; renderPng: Buffer; scene: RoomScene }) {
  const res = await generateStructured({
    schema: LookAnswer,
    system: SYSTEM,
    effort: "low",
    parts: [
      {
        type: "text",
        text: `Objects: ${opts.scene.items.map((i) => `${i.id} = ${i.label} (${i.color ?? "default"}, ${i.material ?? "unknown"})`).join("; ")}.`,
      },
      { type: "text", text: "Photo:" },
      { type: "image", data: opts.photoJpeg.toString("base64"), mediaType: "image/jpeg" },
      { type: "text", text: "Render:" },
      { type: "image", data: opts.renderPng.toString("base64"), mediaType: "image/png" },
    ],
  });
  return { answer: res.data, model: res.model };
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Apply look answers; when several photos disagree on an item, the first answer (nearest camera first) wins. */
export function applyLook(scene: RoomScene, answers: LookAnswer[]): { scene: RoomScene; changes: number } {
  let changes = 0;
  const set = new Set<string>();
  const items = scene.items.map((i) => ({ ...i }));
  let look = scene.look ? { ...scene.look } : null;
  for (const a of answers) {
    for (const c of a.items) {
      const it = items.find((i) => i.id === c.id);
      if (!it || set.has(c.id) || !HEX.test(c.color)) continue;
      set.add(c.id);
      if (it.color !== c.color || it.material !== c.material) changes++;
      it.color = c.color.toLowerCase();
      it.material = c.material;
    }
    if (!set.has("#floor") && a.floor && HEX.test(a.floor)) {
      look = { floor: a.floor, walls: look?.walls ?? "#efebe4" };
      set.add("#floor");
      changes++;
    }
    if (!set.has("#walls") && a.walls && HEX.test(a.walls)) {
      look = { floor: look?.floor ?? "#c8b79e", walls: a.walls };
      set.add("#walls");
      changes++;
    }
  }
  return { scene: { ...scene, items, look }, changes };
}
