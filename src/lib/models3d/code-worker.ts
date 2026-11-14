/**
 * Object worker, code edition (docs/boxd-models-plan.md, part 3): one object's photos → Blender code
 * written by Gemini → a .glb built and rendered on a boxd machine → critic → revised code.
 *
 *   crops → design sheet → code → run_object.py on boxd → critic → revise   (up to MAX_RUNS runs)
 *
 * Every step is cached under the brief's workDir (design.json, then r1/ … r5/ with code.py, the
 * run's result and renders, and critique.json), so a rerun repeats nothing. The best-scoring run
 * wins. Model-written code only ever runs on boxd (run-blender.ts refuses run_object.py locally).
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { generateStructured, geminiObjectModel, type Part } from "@/lib/ai/structured";
import { cropViews } from "./crops";
import type { ObjectBrief, ObjectResult } from "./types";
import { blenderJob, cachedJson } from "./util";

const MAX_RUNS = Number(process.env.OBJECT_MAX_RUNS ?? 5);
const PASS_SCORE = 7;
const VIEWS = ["front", "left", "right", "back", "top", "clay"] as const;

// --------------------------------------------------------------------------- helpers

const jpeg = async (file: string, size = 768) =>
  (await sharp(file).rotate().resize(size, size, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 86 }).toBuffer()).toString("base64");
const img = async (file: string, size?: number): Promise<Part> => ({ type: "image", data: await jpeg(file, size), mediaType: "image/jpeg" });
const text = (t: string): Part => ({ type: "text", text: t });
const fmt = (s: ObjectBrief["size"]) => `${s.w.toFixed(2)} m wide (X) × ${s.d.toFixed(2)} m deep (Y) × ${s.h.toFixed(2)} m tall (Z)`;

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

const DesignSheet = z.object({
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
type DesignSheet = z.infer<typeof DesignSheet>;

async function designSheet(brief: ObjectBrief, crops: string[]): Promise<DesignSheet> {
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
- Build exactly the target size: the parts together span w along X, d along Y and h along Z.
  Derive every dimension from w, d, h (e.g. leg_h = h * 0.4), so the proportions hold.
- Build this one object and nothing else: no floor, walls, rug, lights, cameras or other furniture.
- Use the gh functions; raw bpy/bmesh only for what they can't do. Imports allowed: math, random, bpy, bmesh, mathutils.
  No file, network or os access.
- Materials from gh (gh.wood("#8b6a4f"), gh.fabric("#7d8590", 0.6), ...), colours from the design sheet.
- Keep it light: under 50,000 triangles. Name parts with name=... .
- Clean, designed geometry is the goal, not photographic texture: get the parts, proportions, shapes and colours right.`;

async function writeCode(brief: ObjectBrief, sheet: DesignSheet, crops: string[], prev?: { code: string; feedback: string; renders: string[] }) {
  const parts: Part[] = [
    text(`gh_parts library reference:\n\n${ghPartsReference()}`),
    text(CODE_RULES),
    text(`The object: ${brief.label}. Target size ${fmt(brief.size)}.`),
    text(`Design sheet (from the photos):\n${JSON.stringify(sheet, null, 1)}`),
  ];
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
    effort: "high",
  });
  return res.data;
}

// --------------------------------------------------------------------------- 3. critic

const Critique = z.object({
  score: z.number().describe("0–10: 10 = the same design at this level of detail; 7 = clearly the same object, right parts, proportions and colours, small differences; 4 = right kind of object, wrong design; 0–2 = wrong object or broken"),
  missing: z.array(z.string()).describe("Parts the real object has that the model lacks; empty if none"),
  facing: z.boolean().describe("The front render shows the object's front"),
  fixes: z
    .array(z.object({ part: z.string(), problem: z.string(), fix: z.string().describe("Concrete: sizes in metres, hex colours, shapes") }))
    .describe("Most damaging first; empty if nothing to fix"),
  summary: z.string().describe("One line"),
});
type Critique = z.infer<typeof Critique>;

async function critique(brief: ObjectBrief, crops: string[], renders: Record<string, string>): Promise<Critique> {
  const parts: Part[] = [
    text(`The real object: a ${brief.label}, ${fmt(brief.size)}.`),
    ...(crops.length ? [text("Photos of it:"), ...(await Promise.all(crops.map((c) => img(c, 768))))] : [text("No photo of it exists: judge it as a typical one.")]),
    text("Renders of the 3D model (front, front-left, front-right, back, top, and clay = shape only):"),
  ];
  for (const v of VIEWS) if (renders[v]) parts.push(text(v), await img(renders[v], 512));
  parts.push(
    text(
      "Compare the model with the real object. The model is meant to be clean, simplified geometry: do not mark down missing wood grain, fabric texture, wrinkles or photographic lighting. " +
        "Do mark down wrong or missing parts, wrong proportions, wrong shapes, wrong colours or materials, and a model facing the wrong way.",
    ),
  );
  const res = await generateStructured({
    model: geminiObjectModel(),
    schema: Critique,
    system: "You review 3D models of furniture against photos of the real piece, for a 3D copy of a home. Be specific and strict, but fair about the simplified style.",
    parts,
    effort: "medium",
  });
  return res.data;
}

const feedbackFrom = (c: Critique) =>
  [
    `Score ${c.score}/10: ${c.summary}`,
    ...(c.facing ? [] : ["The front render does not show the object's front: its front must face -Y."]),
    ...c.missing.map((m) => `Missing: ${m}`),
    ...c.fixes.map((f, i) => `${i + 1}. ${f.part}: ${f.problem} → ${f.fix}`),
  ].join("\n");

// --------------------------------------------------------------------------- worker

interface RunResult {
  ok: boolean;
  error: string | null;
  dims: [number, number, number] | null;
  tris: number;
  glb?: string;
  renders: Record<string, string>;
}

interface Run {
  n: number;
  code: string;
  result?: RunResult;
  critique?: Critique;
  /** For the next run: the error or the critic's fixes. */
  feedback: string;
}

const passes = (c?: Critique) => !!c && c.score >= PASS_SCORE && c.missing.length === 0 && c.facing;

export async function runCodeObjectWorker(brief: ObjectBrief, log: (m: string) => void = () => {}): Promise<ObjectResult> {
  const say = (m: string) => log(`[${brief.assetId}] ${m}`);
  fs.mkdirSync(brief.workDir, { recursive: true });
  fs.writeFileSync(path.join(brief.workDir, "brief.json"), JSON.stringify(brief, null, 2));
  const crops = await cropViews(brief);
  const sheet = await cachedJson(path.join(brief.workDir, "design.json"), () => designSheet(brief, crops));
  say(`design sheet: ${sheet.parts.length} part(s) — ${sheet.summary.slice(0, 120)}`);

  const runs: Run[] = [];
  for (let n = 1; n <= MAX_RUNS; n++) {
    const dir = path.join(brief.workDir, `r${n}`);
    fs.mkdirSync(dir, { recursive: true });
    const prev = runs.at(-1);

    // Code (cached as code.py).
    const codeFile = path.join(dir, "code.py");
    if (!fs.existsSync(codeFile)) {
      const out = await writeCode(
        brief,
        sheet,
        crops,
        prev && { code: prev.code, feedback: prev.feedback, renders: prev.result?.ok ? ["front", "left", "right", "back"].map((v) => prev.result!.renders[v]).filter(Boolean) : [] },
      );
      fs.writeFileSync(codeFile, out.code);
      fs.writeFileSync(path.join(dir, "plan.txt"), out.plan);
    }
    const run: Run = { n, code: fs.readFileSync(codeFile, "utf8"), feedback: "" };
    runs.push(run);

    // Build and render on boxd (cached as result.json).
    const resultFile = path.join(dir, "result.json");
    if (!fs.existsSync(resultFile)) {
      const job = { code: codeFile, size: brief.size, free: brief.kind === "plant" ? ["w", "d"] : [], outDir: dir, res: 640, samples: 24 };
      // A Blender that doesn't finish is retried once on a fresh machine (machines occasionally
      // stall); a second failure is reported as this run's error.
      for (let attempt = 1; attempt <= 2 && !fs.existsSync(resultFile); attempt++) {
        try {
          await blenderJob("run_object.py", path.join(dir, "job.json"), job);
        } catch (err) {
          const msg = (err as Error).message.split("\n").slice(-8).join("\n");
          if (attempt === 1) say(`run ${n}: Blender did not finish, retrying (${msg.split("\n")[0]})`);
          else fs.writeFileSync(resultFile, JSON.stringify({ ok: false, error: `Blender did not finish: ${msg}`, renders: {} }, null, 2));
        }
      }
    }
    run.result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as RunResult;
    if (!run.result.ok) {
      run.feedback = `The code did not produce a usable model.\n${run.result.error}`;
      say(`run ${n}: error — ${run.result.error?.split("\n").filter(Boolean).at(-1)}`);
      continue;
    }

    // Critic (cached as critique.json).
    run.critique = await cachedJson(path.join(dir, "critique.json"), () => critique(brief, crops, run.result!.renders));
    run.feedback = feedbackFrom(run.critique);
    say(`run ${n}: ${run.critique.score}/10${passes(run.critique) ? " pass" : ""} — ${run.critique.summary}`);
    if (passes(run.critique)) break;
  }

  const scored = runs.filter((r) => r.result?.ok && r.critique);
  const best = scored.sort((a, b) => b.critique!.score - a.critique!.score)[0] ?? runs.find((r) => r.result?.ok);
  let result: ObjectResult;
  if (best?.result?.ok && best.result.dims) {
    const [w, d, h] = best.result.dims;
    const dir = path.join(brief.workDir, `r${best.n}`);
    result = {
      assetId: brief.assetId,
      status: "ok",
      glb: best.result.glb ?? path.join(dir, "object.glb"),
      size: { w, d, h },
      preview: best.result.renders.front,
      attempts: runs.length,
      score: best.critique?.score,
      script: path.join(dir, "code.py"),
      reason: best.critique ? `run ${best.n}, ${best.critique.score}/10: ${best.critique.summary}` : `run ${best.n}, not reviewed`,
      invented: brief.views.length === 0,
    };
  } else {
    result = {
      assetId: brief.assetId,
      status: "failed",
      attempts: runs.length,
      reason: `no run produced a model: ${runs.at(-1)?.result?.error?.split("\n").filter(Boolean).at(-1) ?? "unknown"}`,
      invented: brief.views.length === 0,
    };
  }
  fs.writeFileSync(path.join(brief.workDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}
