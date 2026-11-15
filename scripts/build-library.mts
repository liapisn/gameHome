/**
 * Build the furniture library index from Amazon Berkeley Objects (ABO, CC BY 4.0, public S3, no key).
 * Downloads the listing and 3D-model metadata into exports/library-src/ (git-ignored), sorts every
 * listing that has a 3D model into one of our kinds, and writes assets/library/index.json (committed).
 * Kinds: the keyword rules below filter and give a hint, then Gemini sorts every remaining listing
 * (100 per call, cached in exports/library-src/classify/). LIBRARY_CLASSIFY=rules: rules only.
 * Pack models (Kenney, Quaternius), when prepared by `blender/prep_library.py --pack`, are added
 * from exports/library-src/<pack>/pack.json and sorted by name.
 * See docs/library-small-plan.md, Part 4, and docs/library-full-plan.md, Parts B and E.
 *   npx tsx --env-file=.env.local scripts/build-library.mts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { z } from "zod";
import { generateStructured } from "../src/lib/ai/structured";
import { LIBRARY_CREDIT, type LibraryModel, type LibrarySource } from "../src/lib/models3d/library";
import { KIND_GUIDE } from "../src/lib/scene/detect";
import { SCENE_KINDS, type SceneKind } from "../src/lib/scene/types";

const ABO = "https://amazon-berkeley-objects.s3.amazonaws.com";
const SRC = path.resolve("exports/library-src");
const OUT = path.resolve("assets/library/index.json");

async function download(url: string, file: string) {
  if (fs.existsSync(file)) return;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

function csv(file: string): Record<string, string>[] {
  const lines = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8").trim().split(/\r?\n/);
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [head[i], v])));
}

type Size = { w: number; d: number; h: number };
type Sorted = { kind: SceneKind; label: string } | null;
type Rule = [words: string[], to: Sorted];

/** Whole words (plural s/es allowed), any language, case-insensitive. */
const has = (text: string, words: string[]) => words.some((w) => new RegExp(`(^|[^\\p{L}])${w}(e?s)?($|[^\\p{L}])`, "iu").test(text));

const K = (kind: SceneKind, label: string): Sorted => ({ kind, label });

/** Product types kindOf has rules for; a listing of any other type is sent to the classifier only if its name has a furniture word. */
const KNOWN_TYPES = new Set(["SOFA", "BED", "BED_FRAME", "RUG", "CHAIR", "STOOL_SEATING", "OTTOMAN", "BENCH", "TABLE", "DESK", "CABINET", "DRESSER", "SHELF", "HOME_FURNITURE_AND_DECOR", "LAMP", "LIGHT_FIXTURE", "ARTIFICIAL_PLANT", "PLANTER"]);
const FURNITURE_WORDS = ["sofa", "couch", "chair", "table", "bed", "cabinet", "shelf", "bookcase", "bookshelf", "desk", "stool", "ottoman", "bench", "wardrobe", "armoire", "dresser", "nightstand", "sideboard", "buffet", "rug", "lamp", "plant", "toilet", "vanity", "fridge", "refrigerator"];

/**
 * Our kind for an ABO listing; null = not furniture we place. Keyword rules are tried on the item
 * name first and only then on its category (`node`), so "Side End Table" in "Console Tables" is a
 * side table; first matching rule wins, then the size fallback.
 */
export function kindOf(type: string, node: string, name: string, size: Size): Sorted {
  if (has(name, ["mirror", "cover", "slipcover", "cushion", "pillow", "rug pad", "headboard", "outdoor", "patio", "folding"])) return null;
  const pick = (rules: Rule[], fallback: Sorted): Sorted => {
    for (const text of [name, node]) for (const [words, to] of rules) if (has(text, words)) return to;
    return fallback;
  };
  const chair = (): Sorted =>
    pick(
      [
        [["office", "desk", "executive", "gaming", "escritorio", "scrivania", "bürostuhl", "task"], K("generic", "office chair")],
        [["dining", "esszimmer", "comedor", "sedie", "sillas", "küchenstuhl", "armless", "side chair"], K("generic", "chair")],
        [["armchair", "accent", "lounge", "recliner", "club", "wingback", "wing-back", "poltrona", "fauteuil", "sessel", "sillón", "swivel"], K("armchair", "armchair")],
      ],
      size.w >= 0.65 ? K("armchair", "armchair") : K("generic", "chair"),
    );
  switch (type) {
    case "SOFA":
      // Pieces of a modular sectional ("Left L-Section", "Sectional Component") aren't a whole sofa.
      if (has(name, ["section", "component", "l-section", "left-facing", "right-facing", "armless"])) return null;
      // Single seats sold as sofas ("1 seater", "fauteuil") are armchairs.
      if (size.w < 1.05 || has(name, ["armchair", "fauteuil", "1 seater", "chair"])) return size.w < 1.3 ? K("armchair", "armchair") : K("sofa", "sofa");
      return K("sofa", "sofa");
    case "BED":
    case "BED_FRAME":
      if (has(name, ["nightstand", "bedside"])) return K("nightstand", "nightstand");
      return size.w >= 0.8 ? K("bed", "bed") : null;
    case "RUG":
      return size.h <= 0.05 ? K("rug", "rug") : null;
    case "CHAIR":
      return chair();
    case "STOOL_SEATING":
      return K("generic", "stool");
    case "OTTOMAN":
      return K("generic", "ottoman");
    case "BENCH":
      return K("bench", "bench");
    case "TABLE":
      return pick(
        [
          [["nightstand", "night stand", "bedside", "nachttisch", "comodino", "mesita de noche", "table de chevet"], K("nightstand", "nightstand")],
          [["tv", "media", "television", "fernseh"], K("tvUnit", "tv unit")],
          [["coffee", "kaffeetisch", "couchtisch", "basse", "tavolino"], K("coffeeTable", "coffee table")],
          [["end table", "side table", "beistelltisch", "accent table", "nesting"], K("nightstand", "side table")],
          [["dining", "esstisch", "comedor", "pranzo", "kitchen table"], K("diningTable", "dining table")],
          [["console"], K("console", "console")],
        ],
        size.h < 0.55 ? K("coffeeTable", "coffee table") : size.h >= 0.65 && size.w >= 1.0 ? K("diningTable", "dining table") : K("console", "console"),
      );
    case "DESK":
      return K("desk", "desk");
    case "CABINET":
      if (has(name, ["vanity", "cart", "bathroom", "medicine"])) return null;
      return pick(
        [
          [["wardrobe", "armoire", "kleiderschrank"], K("wardrobe", "wardrobe")],
          [["tv", "media", "television", "fernseh"], K("tvUnit", "tv unit")],
          [["buffet", "sideboard"], K("sideboard", "sideboard")],
        ],
        size.h >= 1.5 ? K("wardrobe", "wardrobe") : K("sideboard", "sideboard"),
      );
    case "DRESSER":
      return K("sideboard", "dresser");
    case "SHELF":
      if (has(name, ["floating", "wall shelf"])) return null;
      return pick([[["bookcase", "bücherregal", "bookshelf"], K("bookshelf", "bookshelf")]], size.h >= 1.2 ? K("bookshelf", "bookshelf") : K("shelves", "shelves"));
    case "HOME_FURNITURE_AND_DECOR":
      return pick(
        [
          [["television", "tv", "media"], K("tvUnit", "tv unit")],
          [["rug"], size.h <= 0.05 ? K("rug", "rug") : null],
        ],
        has(name, ["chair"]) ? chair() : null,
      );
    case "LAMP":
      return size.h >= 1.2 ? K("floorLamp", "floor lamp") : null;
    case "LIGHT_FIXTURE":
      return has(name, ["pendant", "chandelier"]) ? K("pendant", "pendant") : null;
    case "ARTIFICIAL_PLANT":
      return K("plant", "plant");
    case "PLANTER":
      return has(name, ["plant"]) ? K("plant", "plant") : null;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ Gemini sorting (Part B)

const Sorting = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      kind: z.enum([...SCENE_KINDS, "skip"]),
      label: z.string().describe("Lower-case short noun for the object, singular: 'chair', 'office chair', 'stool', 'ottoman', 'sofa', 'side table'"),
    }),
  ),
});

const SORT_SYSTEM = `You sort a catalogue of furniture 3D models into the object kinds a room-rebuilding tool uses,
so a detected object can be replaced by a model of the same kind.

${KIND_GUIDE}

Rules for this catalogue:
- armless dining and accent chairs → generic, label "chair"; office and desk chairs → generic, label "office chair";
  stools → generic "stool"; ottomans and poufs → generic "ottoman".
- armchairs, accent chairs with arms, recliners → armchair.
- end and side tables → nightstand only when the name says bedside or nightstand; otherwise coffeeTable when
  under 0.55 m tall, else console.
- TV stands and media storage → tvUnit. Dressers and chests of drawers → sideboard.
- headboards alone, pillows, vases, fans, frames, mirrors, electronics, outdoor furniture, parts of a
  sectional sofa (corner, left/right arm piece, armless piece), and everything else not in the kinds → skip.
The rule hint is a keyword guess: keep it when it is right, change it when it is wrong.
For generic, keep the label to the nouns above when one fits; for other kinds the label is the kind in words.`;

type ToSort = { id: string; name: string; type: string; node: string; size: Size; hint: Sorted };
const CLASSIFY = path.join(SRC, "classify");
const BATCH = 100;

async function classify(items: ToSort[], tag: string): Promise<Map<string, Sorted>> {
  fs.mkdirSync(CLASSIFY, { recursive: true });
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const batches: ToSort[][] = [];
  for (let i = 0; i < sorted.length; i += BATCH) batches.push(sorted.slice(i, i + BATCH));
  const out = new Map<string, Sorted>();
  let done = 0;
  let next = 0;
  const run = async () => {
    while (next < batches.length) {
      const n = next++;
      const batch = batches[n];
      const file = path.join(CLASSIFY, `${tag}-${n}.json`);
      const ids = batch.map((b) => b.id);
      let answer: z.infer<typeof Sorting>["models"] | null = null;
      if (fs.existsSync(file)) {
        const c = JSON.parse(fs.readFileSync(file, "utf8")) as { ids: string[]; models: z.infer<typeof Sorting>["models"] };
        if (c.ids.join() === ids.join()) answer = c.models;
      }
      if (!answer) {
        const lines = batch.map((b) =>
          JSON.stringify({
            id: b.id,
            name: b.name.slice(0, 160),
            type: b.type || undefined,
            category: b.node || undefined,
            size: `${b.size.w.toFixed(2)} w × ${b.size.d.toFixed(2)} d × ${b.size.h.toFixed(2)} h m`,
            hint: b.hint ? `${b.hint.kind} "${b.hint.label}"` : "none",
          }),
        );
        for (let attempt = 1; ; attempt++) {
          try {
            const res = await generateStructured({ schema: Sorting, system: SORT_SYSTEM, parts: [{ type: "text", text: `Sort every one of these ${batch.length} models (answer each id once):\n${lines.join("\n")}` }], effort: "low" });
            answer = res.data.models;
            break;
          } catch (err) {
            if (attempt >= 2) throw err;
          }
        }
        fs.writeFileSync(file, JSON.stringify({ ids, models: answer }));
      }
      const got = new Map(answer.map((a) => [a.id, a]));
      for (const b of batch) {
        const a = got.get(b.id);
        // Not answered: the rule hint stands.
        out.set(b.id, !a ? b.hint : a.kind === "skip" ? null : { kind: a.kind, label: a.kind === "generic" ? normalise(a.label) : (b.hint?.kind === a.kind ? b.hint.label : a.label.toLowerCase()) });
      }
      done++;
      if (done % 10 === 0 || done === batches.length) console.log(`  sorted ${done}/${batches.length} batch(es)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, batches.length) }, run));
  return out;
}

/** Labels match item labels word for word (library.ts): lower case, singular, no punctuation. */
const normalise = (l: string) =>
  l.toLowerCase().replace(/[^a-z ]+/g, " ").trim().split(/\s+/).map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)).join(" ");

// ------------------------------------------------------------------ packs (Part E)

type PackEntry = { file: string; name: string; dims: [number, number, number]; tris: number; thumb?: string };

const MODEL_EXT = [".glb", ".gltf", ".fbx", ".obj"];
const EXTRA_EXT = [".bin", ".mtl", ".png", ".jpg", ".jpeg"];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/**
 * Models of the CC0 packs unzipped into exports/library-src/<pack>/: prepared once on boxd
 * (prep_library.py pack mode) into assets/library/models/ and thumbs/, listed in <pack>/pack.json.
 * One file per model name, preferring glb > gltf > fbx > obj when a pack ships several formats.
 */
async function packModels(): Promise<{ source: LibrarySource; entry: PackEntry }[]> {
  const out: { source: LibrarySource; entry: PackEntry }[] = [];
  for (const source of ["kenney", "quaternius"] as const) {
    const dir = path.join(SRC, source);
    if (!fs.existsSync(dir)) continue;
    const packJson = path.join(dir, "pack.json");
    if (!fs.existsSync(packJson)) {
      const all = walk(dir).filter((f) => !path.basename(f).startsWith("."));
      const byName = new Map<string, string>();
      for (const f of all) {
        const ext = path.extname(f).toLowerCase();
        if (!MODEL_EXT.includes(ext)) continue;
        const key = path.basename(f, path.extname(f)).toLowerCase();
        const cur = byName.get(key);
        if (!cur || MODEL_EXT.indexOf(ext) < MODEL_EXT.indexOf(path.extname(cur).toLowerCase())) byName.set(key, f);
      }
      const files = [...byName.values()].sort();
      const extra = all.filter((f) => EXTRA_EXT.includes(path.extname(f).toLowerCase()));
      const mb = [...files, ...extra].reduce((n, f) => n + fs.statSync(f).size, 0) / 1e6;
      console.log(`${source}: preparing ${files.length} model(s) on boxd (${mb.toFixed(0)} MB to upload)…`);
      const { blenderJob } = await import("../src/lib/models3d/util");
      await blenderJob("prep_library.py", path.join(dir, "job.json"), {
        pack: source,
        files,
        extra,
        models: path.resolve("assets/library/models"),
        thumbs: path.resolve("assets/library/thumbs"),
        packJson,
      });
    }
    for (const e of JSON.parse(fs.readFileSync(packJson, "utf8")) as (PackEntry & { file: string | null; error?: string })[]) {
      if (!e.file || !e.dims) continue;
      out.push({ source, entry: { ...e, file: path.relative(process.cwd(), e.file), thumb: e.thumb ? path.relative(process.cwd(), e.thumb) : undefined } });
    }
  }
  return out;
}

type Listing = {
  item_name?: { language_tag?: string; value: string }[];
  product_type?: { value: string }[];
  node?: { node_name: string }[];
  main_image_id?: string;
  "3dmodel_id"?: string;
};

async function main() {
  fs.mkdirSync(SRC, { recursive: true });
  const tar = path.join(SRC, "abo-listings.tar");
  await download(`${ABO}/archives/abo-listings.tar`, tar);
  await download(`${ABO}/3dmodels/metadata/3dmodels.csv.gz`, path.join(SRC, "3dmodels.csv.gz"));
  await download(`${ABO}/images/metadata/images.csv.gz`, path.join(SRC, "images.csv.gz"));
  if (!fs.existsSync(path.join(SRC, "listings/metadata"))) execFileSync("tar", ["xf", tar, "-C", SRC]);

  const models = new Map(csv(path.join(SRC, "3dmodels.csv.gz")).map((r) => [r["3dmodel_id"], r]));
  const images = new Map(csv(path.join(SRC, "images.csv.gz")).map((r) => [r.image_id, r.path]));

  const dir = path.join(SRC, "listings/metadata");
  const out = new Map<string, LibraryModel>();
  const toSort: ToSort[] = [];
  const meta = new Map<string, { url: string; thumb: string }>();
  const seen = new Set<string>();
  const skipped = { size: 0, faces: 0 };
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json.gz")).sort()) {
    for (const line of zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString("utf8").split("\n")) {
      if (!line.includes('"3dmodel_id"')) continue;
      const l = JSON.parse(line) as Listing;
      const id = l["3dmodel_id"]!;
      const m = models.get(id);
      if (!m || seen.has(id)) continue;
      // glTF is Y up: width x, height y, depth z, in metres.
      const size = { w: Number(m.extent_x), d: Number(m.extent_z), h: Number(m.extent_y) };
      // Under 2 cm on a side is a broken extent, except a rug's thickness.
      const sides = [size.w, size.d, size.h];
      if (Math.min(size.w, size.d) < 0.02 || size.h < 0.002 || Math.max(...sides) > 6) {
        skipped.size++;
        continue;
      }
      if (Number(m.faces) > 1_500_000) {
        skipped.faces++;
        continue;
      }
      const names = l.item_name ?? [];
      const name = (names.find((n) => n.language_tag?.startsWith("en")) ?? names[0])?.value ?? "";
      const node = (l.node?.[0]?.node_name ?? "").split("/").filter(Boolean).pop() ?? "";
      const type = l.product_type?.[0]?.value ?? "";
      const hint = kindOf(type, node, name, size);
      // The rules filter first: a known type they reject stays out; an unknown type goes on only
      // if its name says it is furniture.
      if (!hint && (KNOWN_TYPES.has(type) || !has(name, FURNITURE_WORDS))) continue;
      seen.add(id);
      const img = l.main_image_id ? images.get(l.main_image_id) : undefined;
      toSort.push({ id: `abo:${id}`, name, type, node, size, hint });
      meta.set(`abo:${id}`, { url: `${ABO}/3dmodels/original/${m.path}`, thumb: img ? `${ABO}/images/small/${img}` : "" });
    }
  }

  const rulesOnly = process.env.LIBRARY_CLASSIFY === "rules";
  console.log(`${toSort.length} listing(s) to sort${rulesOnly ? " (rules only)" : " with Gemini"}`);
  const kinds = rulesOnly ? new Map(toSort.map((t) => [t.id, t.hint])) : await classify(toSort, "abo");
  const changed: string[] = [];
  let changedN = 0;
  for (const t of toSort) {
    const sorted = kinds.get(t.id) ?? null;
    const h = t.hint ? `${t.hint.kind}/${t.hint.label}` : "none";
    const g = sorted ? `${sorted.kind}/${sorted.label}` : "skip";
    if (h !== g) {
      changedN++;
      if (changed.length < 20 || (changedN % 37 === 0 && changed.length < 40)) changed.push(`  ${h.padEnd(26)} → ${g.padEnd(26)} ${t.name.slice(0, 70)}`);
    }
    if (!sorted) continue;
    if (sorted.kind !== "rug" && t.size.h < 0.02) {
      skipped.size++;
      continue;
    }
    out.set(t.id, {
      id: t.id,
      kind: sorted.kind,
      label: sorted.label,
      name: t.name,
      size: { w: round(t.size.w), d: round(t.size.d), h: round(t.size.h) },
      ...meta.get(t.id)!,
      source: "abo",
      credit: LIBRARY_CREDIT,
    });
  }

  // Pack models: CC0, local files, sorted by name only.
  const packs = await packModels();
  if (packs.length) {
    const items: ToSort[] = packs.map(({ source, entry }) => ({
      id: `${source}:${entry.name}`,
      name: entry.name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"),
      type: "",
      node: "",
      size: { w: entry.dims[0], d: entry.dims[1], h: entry.dims[2] },
      hint: null,
    }));
    const pk = rulesOnly ? new Map<string, Sorted>() : await classify(items, "packs");
    for (const [n, { source, entry }] of packs.entries()) {
      const sorted = pk.get(items[n].id);
      if (!sorted) continue;
      const [w, d, h] = entry.dims;
      out.set(items[n].id, { id: items[n].id, kind: sorted.kind, label: sorted.label, name: items[n].name, size: { w: round(w), d: round(d), h: round(h) }, url: entry.file, thumb: entry.thumb ?? "", source, credit: "" });
    }
    console.log(`packs: ${[...out.values()].filter((m) => m.source !== "abo").length} of ${packs.length} model(s) kept`);
  }

  const list = [...out.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ source: "Amazon Berkeley Objects (CC BY 4.0), credit: Amazon.com; Kenney and Quaternius packs (CC0)", classify: rulesOnly ? "rules" : "gemini", models: list }, null, 1) + "\n");

  const counts = new Map<string, number>();
  for (const m of list) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  console.log(`\n${list.length} models (skipped ${skipped.size} by size, ${skipped.faces} by faces) → ${path.relative(process.cwd(), OUT)}`);
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${n}`);
  const generic = new Map<string, number>();
  for (const m of list.filter((x) => x.kind === "generic")) generic.set(m.label, (generic.get(m.label) ?? 0) + 1);
  console.log(`  generic: ${[...generic].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(", ")}`);
  if (!rulesOnly) {
    console.log(`\n${changedN} listing(s) changed kind from the rules; examples (rule → Gemini):`);
    for (const c of changed) console.log(c);
  }

  const need: SceneKind[] = ["sofa", "bed", "armchair", "coffeeTable", "diningTable", "tvUnit", "rug", "nightstand", "desk", "sideboard"];
  const short = need.filter((k) => (counts.get(k) ?? 0) < 20);
  if (short.length) {
    console.error(`\nFAIL: fewer than 20 models for ${short.join(", ")}`);
    process.exit(1);
  }
  console.log("\nall needed kinds have at least 20 models");
}

const round = (v: number) => Math.round(v * 1000) / 1000;

main()
  .then(async () => {
    const { closePool } = await import("../src/lib/boxd/runner");
    await closePool();
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
