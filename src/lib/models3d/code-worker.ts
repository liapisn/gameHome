/**
 * The item calls of the room agent (room-agent.ts, docs/two-layer-plan.md): no decisions, no loop.
 *
 *   designSheet   one item's design sheet, only when the room's design call left it out
 *   writeCode     design sheet (+ the room's style and the items it must match) → Blender code
 *   buildItem     run that code on a boxd machine (run_object.py): a .glb and its renders
 *
 * The critique schema and feedback text live here too; the room agent judges every item at once.
 * Model-written code only ever runs on boxd (run-blender.ts refuses run_object.py locally).
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { generateStructured, geminiObjectModel, type Part } from "@/lib/ai/structured";
import type { ObjectBrief } from "./types";
import { blenderJob } from "./util";

const PASS_SCORE = 7;

// --------------------------------------------------------------------------- helpers

export const jpeg = async (file: string, size = 768) =>
  (await sharp(file).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 86 }).toBuffer()).toString("base64");
export const img = async (file: string, size?: number): Promise<Part> => ({ type: "image", data: await jpeg(file, size), mediaType: "image/jpeg" });
export const text = (t: string): Part => ({ type: "text", text: t });
export const fmt = (s: ObjectBrief["size"]) => `${s.w.toFixed(2)} m wide (X) × ${s.d.toFixed(2)} m deep (Y) × ${s.h.toFixed(2)} m tall (Z)`;

/** gh_parts' public functions, signature + docstring, read from the module itself so it never drifts. */
let libraryRef: string | null = null;
export function ghPartsReference(): string {
  if (libraryRef) return libraryRef;
  const src = fs.readFileSync(path.resolve("blender", "gh_parts.py"), "utf8");
  const header = src.match(/^"""([\s\S]*?)"""/)?.[1].trim() ?? "";
  const defs: string[] = [];
  const re = /^def ([a-z]\w*)\(([\s\S]*?)\):\n(?:\s+"""([\s\S]*?)""")?/gm;
  for (const m of src.matchAll(re)) {
    const sig = m[2].replace(/\s+/g, " ").trim();
    const doc = (m[3] ?? "").replace(/\s+/g, " ").trim();
    defs.push(`gh.${m[1]}(${sig})${doc ? `\n    ${doc}` : ""}`);
  }
  libraryRef = `${header}\n\nFunctions:\n\n${defs.join("\n")}`;
  return libraryRef;
}

// --------------------------------------------------------------------------- 1. design sheet

export const DesignSheet = z.object({
  summary: z.string().describe("What the object is, its style and construction, in two or three sentences"),
  front: z.string().describe("Which side is its front (the side a person uses or faces), as seen in the photos"),
  parts: z
    .array(
      z.object({
        name: z.string().describe("Short snake_case name, e.g. seat_cushion_left, back_leg_right, top"),
        what: z.string().describe("What the part is and its shape, concretely (tapered round leg, flat panel with a shaker frame, …)"),
        size: z.array(z.number()).describe("[w, d, h] in metres"),
        at: z.array(z.number()).describe("[x, y, z] of the part's bottom-centre in metres: x 0 = middle, y 0 = middle (front is -y), z 0 = floor"),
        material: z.enum(["wood", "painted", "fabric", "leather", "metal", "chrome", "glass", "ceramic", "stone", "plastic", "rattan", "emissive"]),
        color: z.string().describe("Hex colour read from the photos, e.g. #8b6a4f"),
        seen: z.enum(["clearly", "partly", "assumed"]).describe("How well the photos show this part"),
      }),
    )
    .describe("Every visible part, plus hidden structural ones the object needs to stand"),
  assumptions: z.array(z.string()).describe("What the photos don't show and you assumed"),
});
export type DesignSheet = z.infer<typeof DesignSheet>;

/** One item's design sheet on its own: the fallback when the room's design call leaves an item out. */
export async function designSheet(brief: ObjectBrief, crops: string[]): Promise<DesignSheet> {
  const res = await generateStructured({
    model: geminiObjectModel(),
    schema: DesignSheet,
    system:
      "You are a furniture designer measuring a real piece of furniture from photos, so a 3D artist can rebuild it as simple, clean geometry. " +
      "Look carefully before you write: count legs, drawers, doors, cushions, shelves; note shapes (tapered, rounded, slatted), proportions, and the exact colours. " +
      "Coordinates: metres; the object's own frame with its footprint centred on x = 0, y = 0, its front facing -y and the floor at z = 0. " +
      "Parts must fit inside the target size.",
    parts: [
      text(`The object: ${brief.label}. Target size ${fmt(brief.size)}.${brief.color ? ` Main colour about ${brief.color}.` : ""}${brief.material ? ` Mostly ${brief.material}.` : ""}${brief.note ? ` Note: ${brief.note}.` : ""}`),
      ...(brief.fit === "exact" && brief.wall
        ? [text(`Fitted unit built to measure along a wall: exactly ${brief.wall.length.toFixed(2)} m long${brief.wall.cornerAt ? `, turning a corner at its ${brief.wall.cornerAt} end` : ""}.${brief.wall.notes ? ` ${brief.wall.notes}` : ""} No sides or top it doesn't have.`)]
        : []),
      ...(crops.length
        ? [text("Photos of it (crops from room photos; other things may be at the edges, ignore them):"), ...(await Promise.all(crops.map((c) => img(c, 1024))))]
        : [text("No photo shows it: design a typical one for a lived-in home.")]),
      text("Write the design sheet: every part with its size, position, material and colour."),
    ],
    effort: "high",
  });
  return res.data;
}

// --------------------------------------------------------------------------- 2. code

const Code = z.object({
  plan: z.string().describe("Two or three sentences: how you will build it, part by part"),
  code: z.string().describe("The complete Python source: a def build(gh, size) function (and helpers if needed)"),
});

const CODE_RULES = `Write one Python function:

def build(gh, size):
    w, d, h = size        # the target size in metres: w along X, d along Y, h up Z
    ...                   # create the object's parts with gh (the library below)
    return [parts]

Rules:
- Origin at the centre of the object's footprint, on the floor (z = 0). Its FRONT faces -Y.
- The target size is measured and fixed: never change it, even if photos or feedback suggest other overall proportions.
- Build exactly the target size: the parts together span w along X, d along Y and h along Z.
  Derive every dimension from w, d, h (e.g. leg_h = h * 0.4), so the proportions hold.
- Build this one object and nothing else: no floor, walls, rug, lights, cameras or other furniture.
- Use the gh functions; raw bpy/bmesh only for what they can't do. Imports allowed: math, random, bpy, bmesh, mathutils.
  No file, network or os access.
- Materials from gh (gh.wood("#8b6a4f"), gh.fabric("#7d8590", 0.6), ...), colours from the design sheet.
- Keep it light: under 50,000 triangles. Name parts with name=... .
- Clean, designed geometry is the goal, not photographic texture: get the parts, proportions, shapes and colours right.`;

/** What an item's code must fit into: the room's style, and the design sheets of the pieces it must match. */
export interface RoomContext {
  style: string;
  palette: { name: string; color: string }[];
  materials: string[];
  matches: { label: string; sheet: DesignSheet }[];
}

export async function writeCode(
  brief: ObjectBrief,
  sheet: DesignSheet,
  crops: string[],
  room?: RoomContext,
  prev?: { code: string; feedback: string; renders: string[] },
) {
  const parts: Part[] = [
    text(`gh_parts library reference:\n\n${ghPartsReference()}`),
    text(CODE_RULES),
    text(`The object: ${brief.label}. Target size ${fmt(brief.size)}.`),
  ];
  if (room) {
    parts.push(
      text(
        `The room it stands in: ${room.style}\nRoom colours: ${room.palette.map((p) => `${p.name} ${p.color}`).join(", ") || "—"}. Recurring materials: ${room.materials.join(", ") || "—"}.` +
          (room.matches.length
            ? `\n\nMatch these pieces of the same room in finish and style:\n${room.matches.map((m) => `- ${m.label}: ${JSON.stringify({ summary: m.sheet.summary, parts: m.sheet.parts.map((p) => ({ name: p.name, material: p.material, color: p.color })) })}`).join("\n")}`
            : ""),
      ),
    );
  }
  parts.push(text(`Design sheet (from the photos):\n${JSON.stringify(sheet, null, 1)}`));
  if (crops.length) parts.push(text("Photos of the real object:"), ...(await Promise.all(crops.slice(0, 3).map((c) => img(c, 768)))));
  if (prev) {
    parts.push(text(`Your previous code:\n\`\`\`python\n${prev.code}\n\`\`\``));
    if (prev.renders.length) parts.push(text("What it built (front, front-left, front-right, back):"), ...(await Promise.all(prev.renders.map((r) => img(r, 512)))));
    parts.push(text(`What is wrong with it:\n${prev.feedback}\n\nWrite the full corrected build function. Fix every point; keep what was right.`));
  } else {
    parts.push(text("Write the build function."));
  }
  const res = await generateStructured({
    model: geminiObjectModel(),
    schema: Code,
    system: "You are a 3D artist who builds furniture as Blender 5.3 Python code, composing the gh_parts library. Your code runs unattended: it must be correct on the first try.",
    parts,
    effort: "low",
  });
  return res.data;
}

// --------------------------------------------------------------------------- 3. critique schema

export const Critique = z.object({
  score: z.number().describe("0–10: 10 = the same design at this level of detail; 7 = clearly the same object, right parts, proportions and colours, small differences; 4 = right kind of object, wrong design; 0–2 = wrong object or broken"),
  missing: z.array(z.string()).describe("Parts the real object has that the model lacks; empty if none"),
  facing: z.boolean().describe("The front render shows the object's front"),
  sizeWrong: z
    .boolean()
    .describe("The overall size given is clearly not the real object's (e.g. a long low unit given as a narrow tall box): the real object's overall proportions differ by more than about 30%"),
  realSize: z.array(z.number()).describe("If sizeWrong: your estimate of the real [w, d, h] in metres; else empty"),
  fixes: z
    .array(z.object({ part: z.string(), problem: z.string(), fix: z.string().describe("Concrete: sizes in metres, hex colours, shapes") }))
    .describe("Most damaging first; empty if nothing to fix. Never ask to change the overall size (it is measured and fixed): report that as sizeWrong instead"),
  summary: z.string().describe("One line"),
});
export type Critique = z.infer<typeof Critique>;

export const passes = (c?: Critique | null) => !!c && c.score >= PASS_SCORE && c.missing.length === 0 && c.facing;

export const feedbackFrom = (c: Critique & { consistency?: string }) =>
  [
    `Score ${c.score}/10: ${c.summary}`,
    ...(c.facing ? [] : ["The front render does not show the object's front: its front must face -Y."]),
    ...c.missing.map((m) => `Missing: ${m}`),
    ...c.fixes.map((f, i) => `${i + 1}. ${f.part}: ${f.problem} → ${f.fix}`),
    ...(c.consistency ? [`Doesn't match the rest of the room: ${c.consistency}`] : []),
    "Keep the overall size exactly as given.",
  ].join("\n");

// --------------------------------------------------------------------------- 4. build on boxd

export interface RunResult {
  ok: boolean;
  error: string | null;
  dims: [number, number, number] | null;
  tris: number;
  glb?: string;
  renders: Record<string, string>;
}

/**
 * Build `<dir>/code.py` on a boxd machine and render it (cached as `<dir>/result.json`). A Blender
 * that doesn't finish is retried once on a fresh machine (machines occasionally stall); a second
 * failure is an infrastructure error, not the code's fault, and nothing is cached for it.
 */
export async function buildItem(brief: ObjectBrief, dir: string): Promise<RunResult | { infraError: string }> {
  const resultFile = path.join(dir, "result.json");
  if (!fs.existsSync(resultFile)) {
    const job = { code: path.join(dir, "code.py"), size: brief.size, free: brief.kind === "plant" ? ["w", "d"] : [], outDir: dir, res: 640, samples: 24 };
    let lastErr = "";
    for (let attempt = 1; attempt <= 2 && !fs.existsSync(resultFile); attempt++) {
      try {
        await blenderJob("run_object.py", path.join(dir, "job.json"), job);
      } catch (err) {
        lastErr = (err as Error).message.split("\n").slice(-8).join("\n");
      }
    }
    if (!fs.existsSync(resultFile)) return { infraError: `Blender did not finish: ${lastErr}` };
  }
  return JSON.parse(fs.readFileSync(resultFile, "utf8")) as RunResult;
}
