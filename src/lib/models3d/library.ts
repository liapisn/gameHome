/**
 * Library furniture: a photographed item gets a ready-made model of the same kind from Amazon
 * Berkeley Objects (assets/library/index.json, built by scripts/build-library.mts), prepared once on
 * boxd and scaled to the measured box. Positions and sizes never come from the library.
 * Which of the best-proportioned models an item gets is picked by Gemini from the item's photo crop
 * and the candidates' thumbnails (LIBRARY_PICK=rank: by hash, no photo looked at).
 * See docs/library-small-plan.md, Parts 5–6, and docs/library-full-plan.md, Parts A and E.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { generateStructured, type Part } from "@/lib/ai/structured";
import { normaliseLabel } from "@/lib/scene/lift";
import type { SceneKind } from "@/lib/scene/types";
import { fitFor } from "./object-worker";
import type { ObjectResult } from "./types";
import { blenderJob } from "./util";

export interface LibraryModel {
  /** "abo:B075X4QMX3" */
  id: string;
  kind: SceneKind;
  /** Lower-case short noun, used to match generic items: "chair", "stool", "ottoman". */
  label: string;
  /** The listing's item name. */
  name: string;
  /** Metres, w along the front, d front to back, h height. */
  size: { w: number; d: number; h: number };
  /** ABO: the S3 .glb. Packs: a prepared file under assets/library/models/. */
  url: string;
  /** ABO: the 256 px product photo URL. Packs: a png under assets/library/thumbs/. */
  thumb: string;
  source?: LibrarySource;
  /** Licence line for the credits; "" when none is needed (CC0). */
  credit?: string;
}

export type LibrarySource = "abo" | "kenney" | "quaternius";
export const sourceOf = (m: Pick<LibraryModel, "id" | "source">): LibrarySource => m.source ?? (m.id.split(":")[0] as LibrarySource);

export const LIBRARY_CREDIT = "3D models from the Amazon Berkeley Objects dataset, provided by Amazon.com, simplified and resized (CC BY 4.0).";

const INDEX = path.resolve("assets/library/index.json");
const CACHE = path.resolve("exports/library-cache");
/** How many of the best-proportioned models an item chooses among. */
const TOP = 6;
/** Pack models (Kenney, Quaternius) are used only for kinds where ABO has fewer candidates than this. */
const MIN_ABO = 3;

let index: LibraryModel[] | null = null;
export function libraryIndex(): LibraryModel[] {
  if (!index) index = fs.existsSync(INDEX) ? (JSON.parse(fs.readFileSync(INDEX, "utf8")).models as LibraryModel[]) : [];
  return index;
}

/** `gemini` (default): Gemini picks among the candidates from the photo. `rank`: by hash, no photo. */
export const libraryPickMode = (): "gemini" | "rank" => (process.env.LIBRARY_PICK === "rank" ? "rank" : "gemini");

/** `library` (default): ready-made models. `code`: the model-written code worker. */
export const modelStyle = (): "library" | "code" => (process.env.MODEL_STYLE === "code" ? "code" : "library");

/** A stable number from a string (FNV-1a), so the same room always gets the same models. */
function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type Size = { w: number; d: number; h: number };

/**
 * The library models an item could get, best proportions first: same kind (for `generic`, models
 * whose label is in the item's label, the longest such label). ABO first; pack models only when ABO
 * has fewer than MIN_ABO of the kind. Empty: nothing of this kind, the item stays a box.
 */
export function candidates(item: { kind: string; label: string; size: Size }, n = TOP, models = libraryIndex()): LibraryModel[] {
  let cands = models.filter((m) => m.kind === item.kind);
  if (item.kind === "generic") {
    const label = ` ${normaliseLabel(item.label)} `;
    const hits = cands.filter((m) => label.includes(` ${m.label} `));
    const longest = Math.max(0, ...hits.map((m) => m.label.length));
    cands = hits.filter((m) => m.label.length === longest);
  }
  const abo = cands.filter((m) => sourceOf(m) === "abo");
  if (abo.length >= MIN_ABO) cands = abo;
  if (!cands.length) return [];
  const i = item.size;
  const r = (a: number, b: number) => Math.max(a, 1e-3) / Math.max(b, 1e-3);
  const flat = fitFor(i) === "flat";
  const score = (m: LibraryModel) =>
    flat
      ? Math.abs(Math.log(r(m.size.w, m.size.d) / r(i.w, i.d)))
      : Math.abs(Math.log(r(m.size.w, m.size.h) / r(i.w, i.h))) + Math.abs(Math.log(r(m.size.d, m.size.h) / r(i.d, i.h)));
  return cands
    .map((m) => ({ m, s: score(m) }))
    .sort((a, b) => a.s - b.s || a.m.id.localeCompare(b.m.id))
    .slice(0, n)
    .map((x) => x.m);
}

/** The fallback pick: one of the best-proportioned candidates, chosen by `seed` (stable per room). */
export function pickModel(item: { kind: string; label: string; size: Size }, seed: string, models = libraryIndex()): LibraryModel | null {
  const best = candidates(item, TOP, models);
  return best.length ? best[hash(seed) % best.length] : null;
}

// ------------------------------------------------------------------ Gemini picks from the photo

const Picks = z.object({
  picks: z.array(
    z.object({
      assetId: z.string(),
      candidate: z.number().int().describe("Index of the chosen candidate (0-based), or -1 if none is the same kind of object"),
      why: z.string().describe("A few words: the shape that decided it"),
    }),
  ),
});

const PICK_SYSTEM = `You match photographed furniture to ready-made 3D models from a catalogue.
For each object, pick the candidate closest to the photo in kind and overall shape: arms or not, legs
or a solid base, single or double, round or square, headboard or not, number of seats. Colour, fabric
and exact style don't matter: the model is resized to the measured size and recoloured later.
If none is the same kind of object, answer -1.`;

export interface PickRequest {
  assetId: string;
  label: string;
  size: Size;
  /** The item's first photo crop; null = no photo, the fallback is used. */
  crop: string | null;
  cands: LibraryModel[];
  /** Seed for the fallback pick. */
  seed: string;
}
export interface PickResult {
  model: LibraryModel | null;
  picked: "gemini" | "rank";
  why: string;
}

const THUMBS = path.join(CACHE, "thumbs");
/** A candidate's thumbnail as a 256 px JPEG, cached; null when it can't be had. */
async function thumb(m: LibraryModel): Promise<Buffer | null> {
  if (!m.thumb) return null;
  const file = path.join(THUMBS, `${m.id.replace(/[:/]/g, "-")}.jpg`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  try {
    let src: Buffer;
    if (/^https?:/.test(m.thumb)) {
      const res = await fetch(m.thumb, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      src = Buffer.from(await res.arrayBuffer());
    } else src = fs.readFileSync(path.resolve(m.thumb));
    const out = await sharp(src).resize(256, 256, { fit: "inside" }).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
    fs.mkdirSync(THUMBS, { recursive: true });
    fs.writeFileSync(file, out);
    return out;
  } catch {
    return null;
  }
}

const fmt = (s: Size) => `${s.w.toFixed(2)} × ${s.d.toFixed(2)} × ${s.h.toFixed(2)} m (w × d × h)`;

async function askBatch(batch: PickRequest[]): Promise<Map<string, { candidate: number; why: string }>> {
  const parts: Part[] = [];
  for (const r of batch) {
    const crop = await sharp(r.crop!).rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    parts.push({ type: "text", text: `Object ${r.assetId}: "${r.label}", measured ${fmt(r.size)}. Photo:` });
    parts.push({ type: "image", data: crop.toString("base64"), mediaType: "image/jpeg" });
    for (const [k, m] of r.cands.entries()) {
      const t = await thumb(m);
      parts.push({ type: "text", text: `  candidate ${k}: ${m.name.slice(0, 90)} — ${fmt(m.size)}${t ? "" : " (no picture)"}` });
      if (t) parts.push({ type: "image", data: t.toString("base64"), mediaType: "image/jpeg" });
    }
  }
  parts.push({ type: "text", text: `Answer one pick for each object: ${batch.map((r) => r.assetId).join(", ")}.` });
  const res = await generateStructured({ schema: Picks, system: PICK_SYSTEM, parts, effort: "low" });
  return new Map(res.data.picks.map((p) => [p.assetId, { candidate: p.candidate, why: p.why }]));
}

/** Items per pick call: each brings its crop and up to six thumbnails. */
const PICK_BATCH = Number(process.env.LIBRARY_PICK_BATCH ?? 12);

/**
 * Choose a library model for every request: one Gemini call per batch of PICK_BATCH items (batches in
 * parallel), cached in `cacheFile` by asset and candidate ids, so a rebuild with the same candidates
 * makes no call. Items without a crop, a failed call, or LIBRARY_PICK=rank take the fallback; an
 * answer of -1 leaves the item a box.
 */
export async function pickModels(reqs: PickRequest[], cacheFile: string, log: (m: string) => void = () => {}): Promise<Map<string, PickResult>> {
  type Cached = Record<string, { cands: string[]; candidate: number; why: string }>;
  const cache: Cached = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
  const out = new Map<string, PickResult>();
  const fallback = (r: PickRequest, why: string): PickResult => ({ model: pickModel({ kind: r.cands[0]?.kind ?? "", label: r.label, size: r.size }, r.seed, r.cands), picked: "rank", why });
  const ask: PickRequest[] = [];
  for (const r of reqs) {
    if (!r.cands.length) out.set(r.assetId, { model: null, picked: "rank", why: "no library model of this kind" });
    else if (libraryPickMode() === "rank") out.set(r.assetId, fallback(r, "LIBRARY_PICK=rank"));
    else if (!r.crop) out.set(r.assetId, fallback(r, "no photo crop"));
    else if (r.cands.length === 1) out.set(r.assetId, { model: r.cands[0], picked: "rank", why: "only candidate" });
    else {
      const c = cache[r.assetId];
      if (c && c.cands.join() === r.cands.map((m) => m.id).join())
        out.set(r.assetId, { model: c.candidate < 0 ? null : (r.cands[c.candidate] ?? null), picked: "gemini", why: c.why });
      else ask.push(r);
    }
  }
  const batches: PickRequest[][] = [];
  for (let i = 0; i < ask.length; i += PICK_BATCH) batches.push(ask.slice(i, i + PICK_BATCH));
  await Promise.all(
    batches.map(async (batch) => {
      const answers = await askBatch(batch).catch((err) => {
        log(`library pick: call failed for ${batch.length} item(s), taking the ranked pick — ${(err as Error).message.slice(0, 160)}`);
        return null;
      });
      for (const r of batch) {
        const a = answers?.get(r.assetId);
        if (!a || a.candidate >= r.cands.length || a.candidate < -1) {
          out.set(r.assetId, fallback(r, answers ? "no usable answer" : "pick call failed"));
          continue;
        }
        cache[r.assetId] = { cands: r.cands.map((m) => m.id), candidate: a.candidate, why: a.why };
        out.set(r.assetId, { model: a.candidate < 0 ? null : r.cands[a.candidate], picked: "gemini", why: a.why });
      }
    }),
  );
  if (ask.length) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  }
  for (const r of reqs) {
    const p = out.get(r.assetId)!;
    if (r.cands.length) log(`library pick: ${r.assetId} → ${p.model?.id ?? "none, keeping the box"} (${p.picked}: ${p.why})`);
  }
  return out;
}

interface PrepResult {
  ok: boolean;
  dims: [number, number, number] | null;
  tris: number;
  error: string | null;
}

const inFlight = new Map<string, Promise<PrepResult>>();

/** Prepare a library model on boxd (decimated, textures shrunk, origin on the floor). Cached for good. */
export function prepareModel(m: LibraryModel): Promise<PrepResult & { glb: string }> {
  const dir = path.join(CACHE, m.id.replace(/:/g, "-"));
  const glb = path.join(dir, "object.glb");
  const resultFile = path.join(dir, "result.json");
  let p = inFlight.get(m.id);
  if (!p) {
    p = (async () => {
      if (!/^https?:/.test(m.url)) {
        // Pack models were prepared once by prep_library.py --pack: used as they are.
        const file = path.resolve(m.url);
        if (!fs.existsSync(file)) return { ok: false, dims: null, tris: 0, error: `missing ${m.url}` };
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(file, glb);
        return { ok: true, dims: [m.size.w, m.size.d, m.size.h] as [number, number, number], tris: 0, error: null };
      }
      if (fs.existsSync(resultFile) && fs.existsSync(glb)) {
        const cached = JSON.parse(fs.readFileSync(resultFile, "utf8")) as PrepResult;
        if (cached.ok) return cached;
      }
      await blenderJob("prep_library.py", path.join(dir, "job.json"), { url: m.url, out: dir, maxTris: 60000, maxTexture: 1024 });
      return JSON.parse(fs.readFileSync(resultFile, "utf8")) as PrepResult;
    })();
    inFlight.set(m.id, p);
    p.catch(() => inFlight.delete(m.id));
  }
  return p.then((r) => ({ ...r, glb }));
}

/** The library's stand-in for the object worker: prepare the picked model, report like an object result. */
export async function libraryObject(assetId: string, m: LibraryModel): Promise<ObjectResult> {
  const prep = await prepareModel(m);
  if (!prep.ok || !prep.dims) throw new Error(`library ${m.id}: ${prep.error?.split("\n")[0] ?? "preparation failed"}`);
  const [w, d, h] = prep.dims;
  return { assetId, status: "ok", glb: prep.glb, size: { w, d, h }, attempts: 1, reason: `library ${m.id} (${m.name.slice(0, 60)})` };
}
