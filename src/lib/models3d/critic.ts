/**
 * The judgement calls of the room and house workers, each one structured call (generateStructured:
 * Gemini here). Positions are never decided here: they stay as measured from the photos. The
 * object critic lives with the object worker (code-worker.ts).
 */
import fs from "node:fs";
import sharp from "sharp";
import { z } from "zod";
import { generateStructured, type Part } from "@/lib/ai/structured";

const jpeg = async (file: string, size = 1024) =>
  (await sharp(file).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 86 }).toBuffer()).toString("base64");
const img = async (file: string, size?: number): Promise<Part> => ({ type: "image", data: await jpeg(file, size), mediaType: "image/jpeg" });
const text = (t: string): Part => ({ type: "text", text: t });

// ------------------------------------------------------------------ same object, many copies

const Groups = z.object({
  groups: z
    .array(z.object({ items: z.array(z.string()).describe("Item ids that are copies of one identical product"), why: z.string() }))
    .describe("Only groups of two or more; an item that is one of a kind is left out"),
});

/**
 * Which items are copies of the same product (a pair of nightstands, matching armchairs)? One model
 * is then made per group and placed for each copy.
 */
export async function sameModels(items: { id: string; label: string; kind: string; crop: string | null }[]) {
  const withCrop = items.filter((i) => i.crop);
  if (withCrop.length < 2) return [] as string[][];
  const parts: Part[] = [];
  for (const i of withCrop) parts.push(text(`${i.id}: ${i.label} (${i.kind})`), await img(i.crop!, 384));
  parts.push(text("Which of these are copies of the very same product (same design, size and finish), so one 3D model can stand in for all of them?"));
  const res = await generateStructured({
    schema: Groups,
    system: "You group furniture in one home that is identical: the same product bought several times. Similar but different designs are not a group.",
    parts,
    effort: "low",
  });
  const ids = new Set(withCrop.map((i) => i.id));
  return res.data.groups.map((g) => g.items.filter((id) => ids.has(id))).filter((g) => g.length >= 2);
}

// ------------------------------------------------------------------ orientation

const TurnVerdict = z.object({
  match: z.enum(["1", "2", "3", "4", "none"]).describe("The render whose object faces the same way as in the photo; none if the object isn't visible in the renders"),
  wrongModel: z.boolean().describe("The object in the renders is clearly a different kind or design from the photo"),
  reason: z.string(),
});

/**
 * Four renders from the photo's camera, the model turned 0°, 90°, 180°, 270°: which one faces the
 * way the real object does? Returns the turn in degrees (anticlockwise seen from above), or null.
 */
export async function pickTurn(label: string, photoCrop: string, renderCrops: string[]) {
  const res = await generateStructured({
    schema: TurnVerdict,
    system: "You compare a photo of a piece of furniture with renders of its 3D model from the same camera, to find which way the model must face.",
    parts: [
      text(`Photo crop of the ${label}:`),
      await img(photoCrop, 640),
      ...(await Promise.all(renderCrops.flatMap(async (r, i) => [text(`Render ${i + 1}:`), await img(r, 640)]))).flat(),
      text(`In which render does the ${label} face the same way as in the photo (look at its front, back, arms, legs, doors, screen)?`),
    ],
    effort: "medium",
  });
  const turn = res.data.match === "none" ? null : (Number(res.data.match) - 1) * 90;
  return { turn, wrongModel: res.data.wrongModel, reason: res.data.reason };
}

// ------------------------------------------------------------------ house review

const HouseReview = z.object({
  rooms: z
    .array(
      z.object({
        room: z.string().describe("The room id as given"),
        score: z.number().describe("0–10 for this room: 10 = every photographed piece is there, recognisable, in its place and facing the right way; 7 = right furniture and layout with small errors; 4 = recognisable room but wrong or missing pieces; 0–2 = unusable"),
        problems: z.array(z.string()).describe("What is wrong, most damaging first: name the piece and say concretely what to change; empty if nothing"),
      }),
    )
    .describe("One entry per room shown"),
  summary: z.string().describe("One line for the whole home"),
});

/**
 * Photos beside renders from their cameras, per room: a score and the problems of each room. The
 * house passes when no room is below 6 and the rooms average 7 or more.
 */
export async function critiqueHouse(rooms: { room: string; pairs: string[] }[]) {
  const parts: Part[] = [];
  for (const r of rooms) {
    parts.push(text(`Room ${r.room}: the real photo (left) beside the rebuilt room rendered from the same camera (right).`));
    for (const p of r.pairs.slice(0, 3)) if (fs.existsSync(p)) parts.push(await img(p, 1280));
  }
  parts.push(
    text(
      "Review each room of this rebuilt home against its photos. The rebuild is a stage model: walls, lighting and textures " +
        "differ from the photos and are not problems. Judge the furniture: is each photographed piece there, recognisable, " +
        "the right size, in the right place and facing the right way?",
    ),
  );
  const res = await generateStructured({ schema: HouseReview, system: "You review 3D copies of real homes rebuilt from listing photos.", parts, effort: "high" });
  const scores = res.data.rooms.map((r) => r.score);
  const pass = scores.length > 0 && Math.min(...scores) >= 6 && scores.reduce((a, b) => a + b, 0) / scores.length >= 7;
  return { ...res.data, pass };
}
