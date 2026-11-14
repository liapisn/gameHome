/**
 * The judgement calls of the model workers, each one structured call (generateStructured: Gemini
 * here). Positions are never decided here: they stay as measured from the photos.
 *
 * The house critic's structure (scores per category, fixes most damaging first, a pass threshold)
 * is adapted from https://github.com/apekshik/anyscene (CRITIC and critic_schema in
 * builder/scene_builder.py), MIT licence, with our own categories.
 */
import fs from "node:fs";
import sharp from "sharp";
import { z } from "zod";
import { generateStructured, type Part } from "@/lib/ai/structured";

const jpeg = async (file: string, size = 1024) =>
  (await sharp(file).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 86 }).toBuffer()).toString("base64");
const img = async (file: string, size?: number): Promise<Part> => ({ type: "image", data: await jpeg(file, size), mediaType: "image/jpeg" });
const text = (t: string): Part => ({ type: "text", text: t });

// ------------------------------------------------------------------ reference check

const ReferenceVerdict = z.object({
  same: z.boolean().describe("The clean image shows the same object as the photos: same design, shape, proportions, colours and materials"),
  complete: z.boolean().describe("The whole object, nothing cut off"),
  clean: z.boolean().describe("Only this object: no other furniture, no people, no text, logos or watermarks"),
  problem: z.string().describe("If any of the above fails, what is wrong, in one sentence an image generator can act on; else empty"),
});

/** Photos of the object beside the clean reference: is it the same, complete, clean object? */
export async function checkReference(label: string, crops: string[], reference: string) {
  const res = await generateStructured({
    schema: ReferenceVerdict,
    system:
      "You check product reference images made from real-estate photos before they are turned into 3D models. Be strict about identity and completeness, lenient about lighting and background. " +
      "Logos, brand names, labels and watermarks are removed on purpose: never count their absence as a difference.",
    parts: [
      text(`Photos of a ${label} in a home (crops; other things may be at the edges):`),
      ...(await Promise.all(crops.map((c) => img(c, 768)))),
      text("The clean reference image made from them:"),
      await img(reference, 768),
      text(`Is the reference the same ${label}, complete, and on its own?`),
    ],
    effort: "medium",
  });
  return { ok: res.data.same && res.data.complete && res.data.clean, ...res.data };
}

// ------------------------------------------------------------------ pick a model

const PickVerdict = z.object({
  pick: z.enum(["A", "B", "none"]).describe("The model closest to the object in the photos, or none if both are unusable"),
  reason: z.string().describe("One line: why this one, or what is wrong with both"),
  problem: z.string().describe("If none: what to change in the next attempt, in one sentence; else empty"),
});

/**
 * Same-light renders of the candidates (textured and clay) beside the photos and the reference:
 * pick the closer one. Candidates are shown as A and B so the generator's name doesn't bias it.
 */
export async function pickModel(label: string, crops: string[], reference: string, candidates: { beauty: string; back: string; clay: string }[]) {
  const names = ["A", "B"];
  const parts: Part[] = [
    text(`Photos of a ${label} in a home:`),
    ...(await Promise.all(crops.slice(0, 3).map((c) => img(c, 640)))),
    text("The clean reference image the models were made from:"),
    await img(reference, 640),
  ];
  for (const [i, c] of candidates.entries()) {
    parts.push(text(`Model ${names[i]}: front three-quarter, back, and clay (shape only, with wireframe):`));
    parts.push(await img(c.beauty, 640), await img(c.back, 512), await img(c.clay, 640));
  }
  parts.push(
    text(
      `Which model is the better ${label} for a 3D copy of this home: closest to the photos in shape, proportions, ` +
        `colours and materials, with clean geometry (nothing melted, blobby, missing or fused to junk)? ` +
        `Judge shape from the clay renders. Answer none only if no model is usable.`,
    ),
  );
  const res = await generateStructured({ schema: PickVerdict, system: "You judge generated 3D models of furniture against photos of the real object.", parts, effort: "medium" });
  const idx = names.indexOf(res.data.pick);
  return { index: idx >= 0 && idx < candidates.length ? idx : -1, reason: res.data.reason, problem: res.data.problem };
}

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

// ------------------------------------------------------------------ house critic

const Critique = z.object({
  scores: z.object({
    identity: z.number().int().describe("1–10: the models match the furniture in the photos"),
    proportions: z.number().int().describe("1–10: sizes and proportions are believable"),
    placement: z.number().int().describe("1–10: things stand where the photos show them, facing the right way, nothing floating or intersecting"),
    materials: z.number().int().describe("1–10: colours and materials match the photos"),
    completeness: z.number().int().describe("1–10: the photographed furniture is all there"),
  }),
  fixes: z.array(z.object({ room: z.string(), fix: z.string() })).describe("At most five, most damaging first"),
  summary: z.string(),
});

/** Photos beside renders from their cameras, per room: score the house as a whole. */
export async function critiqueHouse(rooms: { room: string; pairs: string[] }[]) {
  const parts: Part[] = [];
  for (const r of rooms) {
    parts.push(text(`Room ${r.room}: each image is the real photo (left) beside the render of the rebuilt room from the same camera (right).`));
    for (const p of r.pairs.slice(0, 3)) if (fs.existsSync(p)) parts.push(await img(p, 1280));
  }
  parts.push(
    text(
      "Score the rebuilt home 1–10 per category (7 = a solid, usable result; 9 = exceptional). The renders are a " +
        "stage model: lighting, walls and textures differ from the photos and must not be marked down. Then list at " +
        "most five fixes, most damaging first, each naming its room. Pass is no category below 6 and an average of 7 or more.",
    ),
  );
  const res = await generateStructured({ schema: Critique, system: "You review 3D copies of real homes rebuilt from listing photos.", parts, effort: "high" });
  const s = Object.values(res.data.scores);
  return { ...res.data, pass: Math.min(...s) >= 6 && s.reduce((a, b) => a + b, 0) / s.length >= 7 };
}
