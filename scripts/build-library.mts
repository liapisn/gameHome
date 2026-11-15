/**
 * Build the furniture library index from Amazon Berkeley Objects (ABO, CC BY 4.0, public S3, no key).
 * Downloads the listing and 3D-model metadata into exports/library-src/ (git-ignored), sorts every
 * listing that has a 3D model into one of our kinds by simple rules, and writes
 * assets/library/index.json (committed). See docs/library-small-plan.md, Part 4.
 *   npx tsx scripts/build-library.mts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { LibraryModel } from "../src/lib/models3d/library";
import type { SceneKind } from "../src/lib/scene/types";

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
  const skipped = { size: 0, faces: 0 };
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json.gz")).sort()) {
    for (const line of zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString("utf8").split("\n")) {
      if (!line.includes('"3dmodel_id"')) continue;
      const l = JSON.parse(line) as Listing;
      const id = l["3dmodel_id"]!;
      const m = models.get(id);
      if (!m || out.has(`abo:${id}`)) continue;
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
      const sorted = kindOf(l.product_type?.[0]?.value ?? "", node, name, size);
      if (!sorted) continue;
      if (sorted.kind !== "rug" && size.h < 0.02) {
        skipped.size++;
        continue;
      }
      const img = l.main_image_id ? images.get(l.main_image_id) : undefined;
      out.set(`abo:${id}`, {
        id: `abo:${id}`,
        kind: sorted.kind,
        label: sorted.label,
        name,
        size: { w: round(size.w), d: round(size.d), h: round(size.h) },
        url: `${ABO}/3dmodels/original/${m.path}`,
        thumb: img ? `${ABO}/images/small/${img}` : "",
      });
    }
  }

  const list = [...out.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ source: "Amazon Berkeley Objects (CC BY 4.0), credit: Amazon.com", models: list }, null, 1) + "\n");

  const counts = new Map<string, number>();
  for (const m of list) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  console.log(`\n${list.length} models (skipped ${skipped.size} by size, ${skipped.faces} by faces) → ${path.relative(process.cwd(), OUT)}`);
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${n}`);
  const generic = new Map<string, number>();
  for (const m of list.filter((x) => x.kind === "generic")) generic.set(m.label, (generic.get(m.label) ?? 0) + 1);
  console.log(`  generic: ${[...generic].map(([l, n]) => `${l} ${n}`).join(", ")}`);

  const need: SceneKind[] = ["sofa", "bed", "armchair", "coffeeTable", "diningTable", "tvUnit", "rug", "nightstand", "desk", "sideboard"];
  const short = need.filter((k) => (counts.get(k) ?? 0) < 20);
  if (short.length) {
    console.error(`\nFAIL: fewer than 20 models for ${short.join(", ")}`);
    process.exit(1);
  }
  console.log("\nall needed kinds have at least 20 models");
}

const round = (v: number) => Math.round(v * 1000) / 1000;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
