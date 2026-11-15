/**
 * Room agent (docs/two-layer-plan.md, part 4): one room's furniture briefs → one model per brief.
 * The room agent does the thinking for the whole room; the item calls only write code.
 *
 *   1. design sheet   Carbon, 6 items per call, sees the room's photos and every item
 *   2. item code      Hydrogen, one call per item, all in parallel (code-worker.ts writeCode)
 *   3. build          boxd, run_object.py, all in parallel (code-worker.ts buildItem)
 *   4. critique       Carbon, every item's renders beside its photo crop, judged together
 *   5. rounds         rewrite only what failed; ROOM_ROUNDS rounds, then one more pass for
 *                     items whose last try failed to build (flagged)
 *
 * Positions and sizes stay as measured: nothing here moves or resizes furniture; a size the photos
 * contradict is reported as `sizeConflict`.
 *
 * Cache, per item under its workDir: room-sheet.json (its sheet from the room's design call),
 * r<n>/code.py, r<n>/result.json (a build that ran), r<n>/review.json (the room critique's
 * verdict), result.json and agent.json (finished). Room-wide under `dir`: agent/style.json and the
 * raw answers. Runs from the per-object worker (design.json, r<n>/ with critique.json) are reused:
 * the old design sheet seeds the room's, and the best old build is judged before any new code is
 * written. Delete an item's agent.json to build it again.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { generateStructured, geminiRoomModel, type Part } from "@/lib/ai/structured";
import {
  buildItem, Critique, DesignSheet, designSheet, feedbackFrom, fmt, img, passes, text, writeCode, type RoomContext, type RunResult,
} from "./code-worker";
import { cropViews } from "./crops";
import type { ObjectBrief, ObjectResult } from "./types";
import { pool } from "./util";

const ROOM_ROUNDS = Number(process.env.ROOM_ROUNDS ?? 3);
/** Item code and builds in flight at once (each build is its own boxd machine; the pool caps machines). */
const CONCURRENCY = Number(process.env.OBJECT_CONCURRENCY ?? 30);
/** Items per design call: a sheet is ~1.3–2.2k tokens, and Carbon's output limit counts thinking too. */
const DESIGN_CHUNK = 6;
/** Items per critique call (3 images each). */
const REVIEW_CHUNK = 12;
const MAX_PHOTOS = 6;

// --------------------------------------------------------------------------- schemas

const StyleFields = {
  style: z.string().describe("The room's style in two sentences: era, finishes, how lived-in"),
  palette: z.array(z.object({ name: z.string(), color: z.string().describe("Hex") })).describe("Recurring colours"),
  materials: z.array(z.string()).describe("Recurring materials, e.g. 'light oak veneer', 'matte black steel'"),
};
const ItemDesign = DesignSheet.extend({
  assetId: z.string().describe("The item's id exactly as given"),
  matches: z.array(z.string()).describe("Ids of other items in this room this one must match in style or finish (chairs ↔ table, a pair of units); empty if none"),
});
const RoomDesignFirst = z.object({ ...StyleFields, items: z.array(ItemDesign).describe("One entry per item asked for") });
const RoomDesignMore = z.object({ items: z.array(ItemDesign).describe("One entry per item asked for") });

type RoomStyle = { style: string; palette: { name: string; color: string }[]; materials: string[] };
type ItemSheet = DesignSheet & { matches: string[] };

const Review = Critique.extend({
  assetId: z.string().describe("The item's id exactly as given"),
  consistency: z.string().describe("What doesn't match the rest of the room (finish, style, colour of pieces it must match); empty if fine"),
});
type Review = z.infer<typeof Review>;
const RoomReview = z.object({ items: z.array(Review).describe("One entry per item shown, by its id") });

// --------------------------------------------------------------------------- state

interface Run {
  n: number;
  dir: string;
  code: string;
  result?: RunResult;
  /** The room critique's verdict; null: asked, but the answer left this item out. */
  review?: Review | null;
  /** Score from the old per-object critic (critique.json), only to pick an old run to reuse. */
  oldScore?: number;
}

type Flag = { kind: "code" | "infra"; error: string };

interface Item {
  brief: ObjectBrief;
  crops: string[];
  sheet: ItemSheet;
  runs: Run[];
  /** Built with code but no result yet (an earlier build that stalled): rebuild it, don't rewrite. */
  pending: Run | null;
  /** Built this round, waiting for the critique. */
  candidate: Run | null;
  /** Round 1: an old build to judge instead of writing new code. */
  reuse: Run | null;
  /** The run the next rewrite starts from, and what to fix in it. */
  base: Run | null;
  feedback: string;
  flag: Flag | null;
  done: boolean;
  sizeFlags: number;
  sizeErrors: number;
  sizeConflict?: ObjectResult["sizeConflict"];
}

const readJson = <T>(f: string): T | undefined => (fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as T) : undefined);
const writeJson = (f: string, v: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2));
};

/** Runs already on disk: r1/ … with their code, result, verdict (new) or critique (old worker). */
function loadRuns(workDir: string): { runs: Run[]; pending: Run | null } {
  if (!fs.existsSync(workDir)) return { runs: [], pending: null };
  const all: Run[] = fs
    .readdirSync(workDir)
    .flatMap((d) => (/^r\d+$/.test(d) ? [Number(d.slice(1))] : []))
    .sort((a, b) => a - b)
    .flatMap((n) => {
      const dir = path.join(workDir, `r${n}`);
      const codeFile = path.join(dir, "code.py");
      if (!fs.existsSync(codeFile)) return [];
      return [{
        n,
        dir,
        code: fs.readFileSync(codeFile, "utf8"),
        result: readJson<RunResult>(path.join(dir, "result.json")),
        review: readJson<Review>(path.join(dir, "review.json")),
        oldScore: readJson<{ score: number }>(path.join(dir, "critique.json"))?.score,
      }];
    });
  const last = all.at(-1);
  const pending = last && !last.result ? last : null;
  return { runs: all.filter((r) => r.result), pending };
}

const nextN = (it: Item) => Math.max(0, ...it.runs.map((r) => r.n), it.pending?.n ?? 0) + 1;
const scoreOf = (r: Run) => r.review?.score ?? r.oldScore ?? -1;
const sizeOf = (est: number[]) => (est.length === 3 ? { w: est[0], d: est[1], h: est[2] } : undefined);

// --------------------------------------------------------------------------- 1. design sheet

async function roomDesign(
  briefs: ObjectBrief[],
  crops: Map<string, string[]>,
  photos: string[],
  agentDir: string,
  say: (m: string) => void,
): Promise<{ style: RoomStyle; sheets: Map<string, ItemSheet> }> {
  const sheetFile = (b: ObjectBrief) => path.join(b.workDir, "room-sheet.json");
  const sheets = new Map<string, ItemSheet>();
  for (const b of briefs) {
    const s = readJson<ItemSheet>(sheetFile(b));
    if (s) sheets.set(b.assetId, s);
  }
  const styleFile = path.join(agentDir, "style.json");
  let style = readJson<RoomStyle>(styleFile);
  const todo = briefs.filter((b) => !sheets.has(b.assetId));
  if (!todo.length && style) return { style, sheets };

  const photoParts: Part[] = [text("Photos of the room:"), ...(await Promise.all(photos.slice(0, MAX_PHOTOS).map((p) => img(p, 1024))))];
  const roster = briefs.map((b) => `${b.assetId}: ${b.label} (${b.kind})${sheets.has(b.assetId) ? ` — ${sheets.get(b.assetId)!.summary}` : ""}`).join("\n");

  const call = async (chunk: ObjectBrief[], k: number, withStyle: boolean) => {
    const parts: Part[] = [...photoParts, text(`Every item of this room (id: label), for \`matches\`:\n${roster}`)];
    if (style) parts.push(text(`The room's style, already decided: ${JSON.stringify(style)}`));
    for (const b of chunk) {
      const old = readJson<DesignSheet>(path.join(b.workDir, "design.json"));
      const c = crops.get(b.assetId) ?? [];
      parts.push(
        text(
          `Item ${b.assetId}: ${b.label} (${b.kind}). Target size ${fmt(b.size)}.${b.color ? ` Main colour about ${b.color}.` : ""}${b.material ? ` Mostly ${b.material}.` : ""}${b.note ? ` Note: ${b.note}.` : ""}` +
            (b.fit === "exact" && b.wall
              ? ` Fitted unit built to measure along a wall: exactly ${b.wall.length.toFixed(2)} m long${b.wall.cornerAt ? `, turning a corner at its ${b.wall.cornerAt} end` : ""}.${b.wall.notes ? ` ${b.wall.notes}` : ""} No sides or top it doesn't have.`
              : ""),
        ),
        ...(c.length ? [text("Crops of it (other things may be at the edges, ignore them):"), ...(await Promise.all(c.slice(0, 2).map((f) => img(f, 768))))] : [text("No photo shows it: design a typical one that fits this room.")]),
        ...(old ? [text(`Its current design sheet (keep what is right; align it with the room):\n${JSON.stringify(old)}`)] : []),
      );
    }
    parts.push(
      text(
        `${withStyle ? "First describe the room's style, palette and recurring materials. Then w" : "W"}rite a design sheet for each of these items: ${chunk.map((b) => b.assetId).join(", ")}. ` +
          "Pieces that belong together (chairs and their table, matching units, a pair) must share finishes and colours; list them in `matches`.",
      ),
    );
    const res = await generateStructured({
      model: geminiRoomModel(),
      schema: withStyle ? RoomDesignFirst : RoomDesignMore,
      system:
        "You are an interior designer measuring a real room's furniture from photos, so a 3D artist can rebuild every piece as simple, clean geometry that belongs together. " +
        "Look carefully: count legs, drawers, doors, cushions, shelves; note shapes (tapered, rounded, slatted), proportions and exact colours. " +
        "Coordinates per item: metres, the item's own frame with its footprint centred on x = 0, y = 0, its front facing -y and the floor at z = 0. Parts must fit inside the target size.",
      parts,
      effort: "low",
    });
    writeJson(path.join(agentDir, `design-${Date.now()}-${k}.json`), res.data);
    return res.data;
  };

  const save = (items: z.infer<typeof ItemDesign>[], chunk: ObjectBrief[]) => {
    for (const it of items) {
      const b = chunk.find((x) => x.assetId === it.assetId);
      if (!b) continue;
      const sheet: ItemSheet = { summary: it.summary, front: it.front, parts: it.parts, assumptions: it.assumptions, matches: it.matches };
      sheets.set(b.assetId, sheet);
      writeJson(sheetFile(b), sheet);
    }
  };

  const chunks: ObjectBrief[][] = [];
  for (let i = 0; i < todo.length; i += DESIGN_CHUNK) chunks.push(todo.slice(i, i + DESIGN_CHUNK));
  // The first call decides the room's style; the rest get it passed in (in parallel).
  if (!style) {
    const first = chunks.shift() ?? [];
    const a = (await call(first, 0, true)) as z.infer<typeof RoomDesignFirst>;
    style = { style: a.style, palette: a.palette, materials: a.materials };
    writeJson(styleFile, style);
    save(a.items, first);
    say(`room style: ${style.style.slice(0, 140)}`);
  }
  await Promise.all(chunks.map(async (c, k) => save((await call(c, k + 1, false)).items, c)));

  // An item the answer left out still gets a sheet: its own design call.
  await pool(
    todo.filter((b) => !sheets.has(b.assetId)),
    CONCURRENCY,
    async (b) => {
      say(`[${b.assetId}] not in the room's design answer: own design sheet`);
      const sheet = { ...(await designSheet(b, crops.get(b.assetId) ?? [])), matches: [] };
      sheets.set(b.assetId, sheet);
      writeJson(sheetFile(b), sheet);
    },
  );
  return { style, sheets };
}

// --------------------------------------------------------------------------- 4. critique

async function critiqueRoom(items: Item[], style: RoomStyle, agentDir: string, tag: string): Promise<void> {
  const chunks: Item[][] = [];
  for (let i = 0; i < items.length; i += REVIEW_CHUNK) chunks.push(items.slice(i, i + REVIEW_CHUNK));
  await Promise.all(
    chunks.map(async (chunk, k) => {
      const parts: Part[] = [text(`The room: ${style.style}`)];
      for (const it of chunk) {
        const r = it.candidate!.result!;
        parts.push(
          text(`Item ${it.brief.assetId}: the real ${it.brief.label}, ${fmt(it.brief.size)}.${it.sheet.matches.length ? ` Must match: ${it.sheet.matches.join(", ")}.` : ""}`),
          ...(it.crops.length ? [text("Photo of it:"), await img(it.crops[0], 768)] : [text("No photo of it exists: judge it as a typical one.")]),
          text("Renders of its 3D model (front, then clay = shape only):"),
          ...(await Promise.all(["front", "clay"].filter((v) => r.renders[v]).map((v) => img(r.renders[v], 512)))),
        );
      }
      parts.push(
        text(
          "Compare each model with its real object. The models are meant to be clean, simplified geometry: do not mark down missing wood grain, fabric texture, wrinkles or photographic lighting. " +
            "Do mark down wrong or missing parts, wrong proportions of parts, wrong shapes, wrong colours or materials, and a model facing the wrong way. " +
            "Each overall size was measured elsewhere and the model is stretched to it: score the design within that size, and if the real object's overall proportions are clearly different, set sizeWrong instead of scoring it down. " +
            "Judge them together: pieces that must match share finish and style. Give one entry per item id above.",
        ),
      );
      const res = await generateStructured({
        model: geminiRoomModel(),
        schema: RoomReview,
        system: "You review 3D models of a room's furniture against photos of the real pieces, for a 3D copy of a home. Be specific and strict, but fair about the simplified style.",
        parts,
        effort: "low",
      });
      writeJson(path.join(agentDir, `round-${tag}-${k}.json`), res.data);
      for (const it of chunk) {
        const v = res.data.items.find((x) => x.assetId === it.brief.assetId) ?? null;
        it.candidate!.review = v;
        if (v) writeJson(path.join(it.candidate!.dir, "review.json"), v);
      }
    }),
  );
}

// --------------------------------------------------------------------------- the agent

export interface RoomAgentRun {
  briefs: ObjectBrief[];
  /** The room's photos (absolute paths), for the design call. */
  photos: string[];
  /** The room's work folder; the agent's own files go in `<dir>/agent/`. */
  dir: string;
  log: (m: string) => void;
}

export async function runRoomAgent(run: RoomAgentRun): Promise<Map<string, ObjectResult>> {
  const { log } = run;
  const agentDir = path.join(run.dir, "agent");
  const results = new Map<string, ObjectResult>();

  // Finished items (agent.json, not flagged) are reused as they are.
  const briefs: ObjectBrief[] = [];
  for (const b of run.briefs) {
    const fin = readJson<{ done: boolean }>(path.join(b.workDir, "agent.json"));
    const res = readJson<ObjectResult>(path.join(b.workDir, "result.json"));
    if (fin?.done && res && !res.flag) results.set(b.assetId, res);
    else briefs.push(b);
  }
  if (results.size) log(`room agent: ${results.size} item(s) already finished`);
  if (!briefs.length) return results;

  const crops = new Map<string, string[]>();
  await pool(briefs, CONCURRENCY, async (b) => {
    fs.mkdirSync(b.workDir, { recursive: true });
    fs.writeFileSync(path.join(b.workDir, "brief.json"), JSON.stringify(b, null, 2));
    crops.set(b.assetId, await cropViews(b));
  });

  const { style, sheets } = await roomDesign(briefs, crops, run.photos, agentDir, log);
  const sheetOf = (id: string): ItemSheet | undefined =>
    sheets.get(id) ?? readJson<ItemSheet>(path.join(path.dirname(briefs[0].workDir), id, "room-sheet.json"));

  const items: Item[] = briefs.map((b) => {
    const { runs, pending } = loadRuns(b.workDir);
    // The best old build is judged first (no new code); a build that stalled is rebuilt as it is.
    const reuse = pending ? null : ([...runs].filter((r) => r.result?.ok).sort((a, c) => scoreOf(c) - scoreOf(a) || c.n - a.n)[0] ?? null);
    const lastFailed = runs.at(-1)?.result?.ok === false ? runs.at(-1)! : null;
    return {
      brief: b,
      crops: crops.get(b.assetId) ?? [],
      sheet: sheets.get(b.assetId)!,
      runs,
      pending,
      candidate: null,
      reuse,
      base: lastFailed,
      feedback: lastFailed ? `The code did not produce a usable model.\n${lastFailed.result!.error}` : "",
      flag: null,
      done: false,
      sizeFlags: 0,
      sizeErrors: 0,
    };
  });
  const say = (it: Item, m: string) => log(`[${it.brief.assetId}] ${m}`);
  for (const it of items) if (it.reuse) say(it, `reusing r${it.reuse.n}${it.reuse.review ? ` (${it.reuse.review.score}/10)` : it.reuse.oldScore !== undefined ? ` (old ${it.reuse.oldScore}/10)` : ""}`);

  const roomFor = (it: Item): RoomContext => ({
    ...style,
    matches: it.sheet.matches.flatMap((id) => {
      const s = id !== it.brief.assetId ? sheetOf(id) : undefined;
      return s ? [{ label: briefs.find((b) => b.assetId === id)?.label ?? id, sheet: s }] : [];
    }),
  });

  /** Steps 2–3 for one item: code (new, or the stalled run's), then a build. Sets candidate or flag. */
  const produce = async (it: Item) => {
    let r: Run;
    if (it.pending) {
      r = it.pending;
    } else {
      const n = nextN(it);
      const dir = path.join(it.brief.workDir, `r${n}`);
      fs.mkdirSync(dir, { recursive: true });
      const b = it.base;
      const out = await writeCode(
        it.brief,
        it.sheet,
        it.crops,
        roomFor(it),
        b ? { code: b.code, feedback: it.feedback, renders: b.result?.ok ? ["front", "left", "right", "back"].map((v) => b.result!.renders[v]).filter(Boolean) : [] } : undefined,
      );
      fs.writeFileSync(path.join(dir, "code.py"), out.code);
      fs.writeFileSync(path.join(dir, "plan.txt"), out.plan);
      r = { n, dir, code: out.code };
    }
    it.flag = null;
    const built = await buildItem(it.brief, r.dir);
    if ("infraError" in built) {
      // A machine problem, not the code's fault: rebuild this same code later.
      it.pending = r;
      it.flag = { kind: "infra", error: built.infraError.split("\n")[0] };
      say(it, `r${r.n}: ${it.flag.error}; flagged, rebuilding later`);
      return;
    }
    it.pending = null;
    r.result = built;
    it.runs.push(r);
    if (!built.ok) {
      it.base = r;
      it.feedback = `The code did not produce a usable model.\n${built.error}`;
      if (built.error?.startsWith("Size off")) {
        it.sizeErrors++;
        it.feedback += `\nThe target size is measured and fixed: build exactly ${fmt(it.brief.size)}, whatever the photos seem to show.`;
      }
      const last = built.error?.split("\n").filter(Boolean).at(-1) ?? "unknown error";
      it.flag = { kind: "code", error: last };
      say(it, `r${r.n}: code error — ${last}; flagged, rewriting next round`);
      return;
    }
    it.candidate = r;
  };

  /** Apply the critique's verdict on this round's build. */
  const judge = (it: Item) => {
    const r = it.candidate!;
    it.candidate = null;
    const v = r.review;
    if (!v) {
      // The critique skipped it: keep the build, unreviewed (docs/two-layer-plan.md, risks).
      say(it, `r${r.n}: no verdict from the room critique; keeping it`);
      it.done = true;
      return;
    }
    it.base = r;
    it.feedback = feedbackFrom(v);
    say(it, `r${r.n}: ${v.score}/10${passes(v) ? " pass" : ""} — ${v.summary}`);
    if (passes(v)) {
      it.done = true;
      return;
    }
    if (v.sizeWrong) it.sizeFlags++;
    // The photos and the measured size disagree: more code can't fix that.
    if (it.sizeFlags >= 2 || (it.sizeFlags >= 1 && it.sizeErrors >= 1)) {
      it.sizeConflict = { target: it.brief.size, ...(sizeOf(v.realSize) ? { estimate: sizeOf(v.realSize) } : {}) };
      say(it, `size conflict: target ${fmt(it.brief.size)}${v.realSize.length === 3 ? `, photos suggest ${v.realSize.map((x) => x.toFixed(2)).join(" × ")} m` : ""}; stopping`);
      it.done = true;
    }
  };

  // Rounds 1…ROOM_ROUNDS, then one more pass only for items whose last try was flagged.
  for (let round = 1; round <= ROOM_ROUNDS + 1; round++) {
    const active = items.filter((it) => !it.done && (round <= ROOM_ROUNDS || it.flag));
    if (!active.length) break;
    log(`room agent: round ${round > ROOM_ROUNDS ? `${round} (flagged items)` : round}, ${active.length} item(s)`);
    await pool(active, CONCURRENCY, async (it) => {
      if (round === 1 && it.reuse) {
        it.candidate = it.reuse;
        return;
      }
      await produce(it).catch((err) => {
        it.flag = { kind: "code", error: (err as Error).message.split("\n")[0] };
        say(it, `code call failed — ${it.flag.error}; flagged`);
      });
    });
    const toReview = active.filter((it) => it.candidate && it.candidate.review === undefined);
    if (toReview.length) await critiqueRoom(toReview, style, agentDir, String(round));
    for (const it of active) if (it.candidate) judge(it);
  }

  // ------------------------------------------------------------------ results
  for (const it of items) {
    const b = it.brief;
    const reviewed = it.runs.filter((r) => r.result?.ok && r.review);
    const best = reviewed.sort((a, c) => c.review!.score - a.review!.score)[0] ?? [...it.runs].filter((r) => r.result?.ok).sort((a, c) => scoreOf(c) - scoreOf(a))[0];
    if (!it.sizeConflict && best?.review?.sizeWrong) {
      const est = sizeOf(best.review.realSize);
      it.sizeConflict = { target: b.size, ...(est ? { estimate: est } : {}) };
      say(it, `size conflict: target ${fmt(b.size)}${est ? `, photos suggest ${best.review.realSize.map((v) => v.toFixed(2)).join(" × ")} m` : ""}`);
    }
    const flag = it.flag ?? undefined;
    let result: ObjectResult;
    if (best?.result?.ok && best.result.dims) {
      const [w, d, h] = best.result.dims;
      const score = best.review?.score ?? best.oldScore;
      result = {
        assetId: b.assetId,
        status: "ok",
        glb: best.result.glb ?? path.join(best.dir, "object.glb"),
        size: { w, d, h },
        preview: best.result.renders.front,
        attempts: it.runs.length,
        score,
        script: path.join(best.dir, "code.py"),
        reason: best.review ? `run ${best.n}, ${best.review.score}/10: ${best.review.summary}` : `run ${best.n}, not reviewed`,
        invented: b.views.length === 0,
        ...(it.sizeConflict ? { sizeConflict: it.sizeConflict } : {}),
        ...(flag ? { flag } : {}),
      };
    } else {
      result = {
        assetId: b.assetId,
        status: "failed",
        attempts: it.runs.length,
        reason: `no run produced a model: ${flag?.error ?? it.runs.at(-1)?.result?.error?.split("\n").filter(Boolean).at(-1) ?? "unknown"}`,
        invented: b.views.length === 0,
        ...(flag ? { flag } : {}),
      };
    }
    writeJson(path.join(b.workDir, "result.json"), result);
    writeJson(path.join(b.workDir, "agent.json"), { done: true, flag: flag ?? null });
    results.set(b.assetId, result);
  }
  return results;
}
