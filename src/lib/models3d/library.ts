/**
 * Library furniture: a photographed item gets a ready-made model of the same kind from Amazon
 * Berkeley Objects (assets/library/index.json, built by scripts/build-library.mts), prepared once on
 * boxd and scaled to the measured box. Positions and sizes never come from the library.
 * See docs/library-small-plan.md, Parts 5–6.
 */
import fs from "node:fs";
import path from "node:path";
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
  url: string;
  thumb: string;
}

export const LIBRARY_CREDIT = "3D models from the Amazon Berkeley Objects dataset, provided by Amazon.com, simplified and resized (CC BY 4.0).";

const INDEX = path.resolve("assets/library/index.json");
const CACHE = path.resolve("exports/library-cache");
/** How many of the best-proportioned models an item chooses among. */
const TOP = 5;

let index: LibraryModel[] | null = null;
export function libraryIndex(): LibraryModel[] {
  if (!index) index = fs.existsSync(INDEX) ? (JSON.parse(fs.readFileSync(INDEX, "utf8")).models as LibraryModel[]) : [];
  return index;
}

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
 * The library model for an item: same kind (for `generic`, a model whose label is in the item's
 * label, the longest such label), closest proportions, one of the best few chosen by `seed`.
 * null: nothing of this kind; the item stays a box.
 */
export function pickModel(item: { kind: string; label: string; size: Size }, seed: string, models = libraryIndex()): LibraryModel | null {
  let cands = models.filter((m) => m.kind === item.kind);
  if (item.kind === "generic") {
    const label = ` ${normaliseLabel(item.label)} `;
    const hits = cands.filter((m) => label.includes(` ${m.label} `));
    const longest = Math.max(0, ...hits.map((m) => m.label.length));
    cands = hits.filter((m) => m.label.length === longest);
  }
  if (!cands.length) return null;
  const i = item.size;
  const r = (a: number, b: number) => Math.max(a, 1e-3) / Math.max(b, 1e-3);
  const flat = fitFor(i) === "flat";
  const score = (m: LibraryModel) =>
    flat
      ? Math.abs(Math.log(r(m.size.w, m.size.d) / r(i.w, i.d)))
      : Math.abs(Math.log(r(m.size.w, m.size.h) / r(i.w, i.h))) + Math.abs(Math.log(r(m.size.d, m.size.h) / r(i.d, i.h)));
  const best = cands
    .map((m) => ({ m, s: score(m) }))
    .sort((a, b) => a.s - b.s || a.m.id.localeCompare(b.m.id))
    .slice(0, TOP);
  return best[hash(seed) % best.length].m;
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

/** The library's stand-in for the object worker: pick, prepare, report like an object result. */
export async function libraryObject(
  assetId: string,
  item: { kind: string; label: string; size: Size },
  seed: string,
): Promise<{ result: ObjectResult; model: LibraryModel } | null> {
  const m = pickModel(item, seed);
  if (!m) return null;
  const prep = await prepareModel(m);
  if (!prep.ok || !prep.dims) throw new Error(`library ${m.id}: ${prep.error?.split("\n")[0] ?? "preparation failed"}`);
  const [w, d, h] = prep.dims;
  return { model: m, result: { assetId, status: "ok", glb: prep.glb, size: { w, d, h }, attempts: 1, reason: `library ${m.id} (${m.name.slice(0, 60)})` } };
}
