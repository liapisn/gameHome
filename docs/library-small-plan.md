# Library furniture: small implementation (about 1 hour)

The short version of
[library-placement-plan.md](https://github.com/liapisn/gameHome/blob/library-placement-plan/docs/library-placement-plan.md)
(branch `library-placement-plan`). Same idea, only the pieces that matter most now; everything
else is listed under "Later" and can be added without changing what is built here.

**The idea:** nobody builds furniture. The measuring decides where every item is and how big it
is. A ready-made model of **the same kind** is taken from a free library and scaled to that size.
A bed in the photo becomes a bed from the library, even if its colour and shape differ.

## Manual downloads

**None for this plan.** The only library used here is Amazon Berkeley Objects (ABO). Its data is
public on S3 and the index script downloads it by itself (no account, no key). The Blender
installation on boxd already exists (snapshot `gh-blender-5-3`).

(Only the "Later" item for bathroom and fridge models needs a manual download, see the end.)

## What changes, in short

1. Gemini calls: `gemini-4-hydrogen` at low thinking by default, shorter timeouts (Part 1).
2. Detection prompt: no points on items cut off by the photo frame (Part 2).
3. Lift guard: drop items whose floor points span too far or land outside the room (Part 3).
4. A library index of ABO models, sorted into our kinds by simple rules (Part 4).
5. Each photographed item gets the ABO model of its kind with the closest proportions, prepared
   on boxd and scaled to the measured box (Parts 5–6).

Positions and sizes never come from the library or a model call: they stay as measured.

Models: every Gemini call uses `gemini-4-hydrogen` at low thinking, except floor plan reading and
room estimates (keep `"medium"`) and the house review (`gemini-4-carbon`, low).

## Part 1: model defaults and timeouts (`src/lib/ai/structured.ts`)

1. `GEMINI_DEFAULT_MODEL = "gemini-4-hydrogen"`.
2. Default thinking: `req.effort ?? "low"` (today `"high"`). Same change in the Claude branch is
   not needed (no Anthropic key), but keep it consistent: `"low"` there too.
3. Add `export const geminiRoomModel = () => process.env.GEMINI_MODEL_ROOM ?? "gemini-4-carbon";`
   beside `geminiObjectModel`.
4. `MAX_OUTPUT` already has `gemini-4-hydrogen: 65536`; nothing to add.
5. Timeout: `CALL_TIMEOUT_MS` default from 12 minutes to **90 s**, retries from 4 attempts to
   **3**. The local runs set `GEMINI_CALL_TIMEOUT_MS=360000` as an environment variable in their npm
   scripts (`build:scene`, `build:models`, `build:tour`, `worker`), since a room agent call with many
   images can take minutes and runs with no time limit. (Not in the script body: `structured.ts`
   reads the variable when it is imported, before any top-level code of the script runs.)
6. Remove explicit `effort: "high"` where a call should now be low:
   - `src/lib/tour/place-photo.ts:124` → delete the line (defaults to low).
   - `src/lib/models3d/critic.ts:104` (house review) → `model: geminiRoomModel(), effort: "low"`.
   - `pickTurn` (`critic.ts:66`, `"medium"`) → delete the line.
   - `src/lib/floorplan-parser/parse.ts` and `src/lib/tour/estimate-room.ts` keep `"medium"`.
7. Env: set `GEMINI_MODEL=gemini-4-hydrogen` in Vercel and `.env.local`; `GEMINI_MODEL_ROOM` and
   `GEMINI_MODEL_OBJECT` only if overriding. (The owner sets Vercel; never commit keys.)

## Part 2: cut-off items in the prompts (`src/lib/scene/detect.ts`, `check.ts`)

Add to `SYSTEM` in `detect.ts`, in the floorPoints bullet:

> If the object's floor line is cut off by the edge of the photo (a sofa or bed whose base runs out
> of the frame), give only the floor points you can really see on the floor, or none. Never put a
> point on the image edge, on the object's top or on a cushion.

Add the same sentence to the check prompt in `check.ts` (around line 75, where it asks for the
real `floorPoints` of misplaced objects).

## Part 3: guard before lifting is trusted (`src/lib/scene/lift.ts`, `liftDetection`)

In the floor-items branch (around line 335, where `pts` is filtered with `nearRoom(p, room, 0.5)`):

1. **Outside the room:** filter with `nearRoom(p, room, 0.15)` instead of `0.5`. If the detection had
   2 or more floor points and fewer than half survive, return
   `{ candidate: null, …, reason: "floor points outside the room" }`.
2. **Span too long:** after the filter, if the long side of the kept points' bounding rectangle is
   over **4 m** (over **6 m** for `kitchen` and `rug`, the legitimate long runs; the long side, not
   the diagonal, so a 3 × 4 m rug passes), return
   `{ candidate: null, …, reason: "floor points span too far" }`.
3. The check loop needs no change: its corrections go back through `liftDetection`, so a
   correction that fails the guard is rejected like any other bad lift and the round is not kept.
4. Name both thresholds as constants beside `NEAR_CONTACT` (`MAX_SPAN = 4`, `MAX_SPAN_LONG = 6` for kitchen and rug,
   `FLOOR_TOLERANCE = 0.15`).

**Test:** two cases in `scripts/selftest-lift.mts`: a sofa whose two floor points lift 5 m apart is
dropped; a kitchen whose points span 5 m is kept; a 3 × 4 m rug (corners 5 m apart diagonally) is
kept.

## Part 4: the library index (`scripts/build-library.mts`, new; run once, output committed)

Run: `npx tsx scripts/build-library.mts`. Downloads into `exports/library-src/` (git-ignored),
writes `assets/library/index.json` (commit it) and prints the number of models per kind.

Downloads (all public, checked 2026-11-15):
- `https://amazon-berkeley-objects.s3.amazonaws.com/archives/abo-listings.tar` (83 MB): JSON lines
  in `listings/metadata/listings_*.json.gz`, fields used: `item_id`, `item_name` (array of
  `{value}`), `product_type` (array of `{value}`), `node` (array of `{node_name}`, a category path),
  `main_image_id`, `3dmodel_id`. 7,953 listings have a `3dmodel_id`.
- `https://amazon-berkeley-objects.s3.amazonaws.com/3dmodels/metadata/3dmodels.csv.gz` (340 KB):
  `3dmodel_id, path, …, faces, extent_x, extent_y, extent_z`. Extents are metres in glTF axes
  (Y up): `w = extent_x`, `h = extent_y`, `d = extent_z`. Example: sofa `B075X4QMX3` is
  2.20 × 0.90 deep × 0.91 tall; its listing says 87 in wide, 37.75 in deep, 33 in high.
- `https://amazon-berkeley-objects.s3.amazonaws.com/images/metadata/images.csv.gz`: maps
  `image_id` → `path`; thumbnails (256 px) at `images/small/<path>`. Store the URL only, for the
  model page and later use.

Entry:

```ts
interface LibraryModel {
  id: string;            // "abo:B075X4QMX3"
  kind: SceneKind;       // src/lib/scene/types.ts
  label: string;         // lower-case short noun for generic items: "chair", "stool", "ottoman"
  name: string;          // item_name (first English value, else first)
  size: { w: number; d: number; h: number };   // metres
  url: string;           // https://amazon-berkeley-objects.s3.amazonaws.com/3dmodels/original/<path>
  thumb: string;
}
```

**Sorting rules** (`kindOf(type, node, name, size)`, a pure function; `node` = last segment of the
first `node_name`; match words case-insensitively in `name + node`; first rule that matches wins).
These cover the product types that have 3D models (counts from the listings):

| product_type (count) | rule → kind |
|---|---|
| SOFA (859) | `sofa`; skip if the name says cover/slipcover |
| BED (140), BED_FRAME (52) | `bed` |
| RUG (817) | `rug` |
| CHAIR (1,184) | office/desk/executive/gaming/escritorio/scrivania/bürostuhl → `generic` "office chair"; arm/accent/lounge/recliner/club/wingback/poltrona/fauteuil → `armchair`; dining/esszimmer/comedor/sedie/sillas → `generic` "chair"; else `armchair` if `w ≥ 0.65`, otherwise `generic` "chair" |
| STOOL_SEATING (340) | `generic` "stool" |
| OTTOMAN (288) | `generic` "ottoman" |
| BENCH (39) | `bench` |
| TABLE (584) | nightstand/bedside/nachttisch → `nightstand`; coffee/kaffeetisch/basse → `coffeeTable`; console → `console`; dining/esstisch/comedor → `diningTable`; end/side → `nightstand`; else by size: `h < 0.55` → `coffeeTable`, `h ≥ 0.65 && w ≥ 1.0` → `diningTable`, else `console` |
| DESK (145) | `desk` |
| CABINET (137) | wardrobe/armoire/kleiderschrank → `wardrobe`; tv/media → `tvUnit`; buffet/sideboard → `sideboard`; else `wardrobe` if `h ≥ 1.5`, else `sideboard` |
| DRESSER (62) | `sideboard` |
| SHELF (106) | floating → skip; bookcase/bücherregal or `h ≥ 1.2` → `bookshelf`; else `shelves` |
| HOME_FURNITURE_AND_DECOR (549) | television/tv/media → `tvUnit`; rug → `rug`; chair → CHAIR rules; else skip |
| LAMP (345) | `floorLamp` if `h ≥ 1.2`, else skip |
| LIGHT_FIXTURE (195) | pendant/chandelier → `pendant`; else skip |
| ARTIFICIAL_PLANT, PLANTER with "plant" in the name | `plant`; other planters skip |
| everything else (wall art, mirrors, pillows, headboards, vases, fans, electronics, …) | skip |

Also skip any model with a side under 2 cm or over 6 m, or more than 1.5 M faces.

Check after the run: sofa, bed, armchair, coffeeTable, diningTable, tvUnit, rug, nightstand, desk
and sideboard each have at least 20 models. A wrong entry seen later is fixed by hand in
`index.json`.

## Part 5: preparing a model (`blender/prep_library.py`, new; runs on boxd)

Job JSON: `{ "url": "<ABO .glb>", "out": "<dir>", "maxTris": 60000, "maxTexture": 1024 }`.

1. Download `url` on the boxd machine (`urllib.request`, S3 is fast from there) to `/work/in.glb`.
2. `bpy.ops.wm.read_factory_settings(use_empty=True)`, import the glTF, apply all transforms, join
   the meshes into one object.
3. Origin at the centre of the footprint, bottom at z = 0. Keep the importer's orientation (glTF +Z
   becomes Blender −Y, our front); the orientation check fixes models that face another way.
4. If over `maxTris`, add a Decimate modifier (collapse, ratio `maxTris / tris`) and apply it.
5. Every image texture larger than `maxTexture`: `image.scale(…)` down to `maxTexture` on its
   longer side, then pack it.
6. Export `<out>/object.glb` (glTF binary, `export_image_format="JPEG"` where supported), write
   `<out>/result.json` `{ ok, dims: [w, d, h], tris, error }`, print `PREP_LIBRARY_DONE`.

In `src/lib/models3d/util.ts`, add `PREP_LIBRARY_DONE` to `MARKER`. It runs through the existing
`blenderJob` (boxd runner), one machine per model, in parallel.

Cache: `exports/library-cache/<id with ":" → "-">/object.glb` and `result.json`, shared by all
rooms and tours. A model is prepared once, ever.

## Part 6: picking and placing (`src/lib/models3d/library.ts` new, `room-worker.ts`, `build_scene.py`)

1. **`pickModel(item, index)`** in `library.ts`:
   - Candidates: models with `kind === item.kind`. For `generic` items, models whose `label` word
     appears in the item's normalised label (`normaliseLabel` from `lift.ts`), e.g. a "bar stool"
     item matches "stool". No candidates → `null` (the item stays a box, as today).
   - Score: `|ln((m.w/m.h) / (i.w/i.h))| + |ln((m.d/m.h) / (i.d/i.h))|`; for flat items
     (`fitFor(size) === "flat"`) use `|ln((m.w/m.d) / (i.w/i.d))|` only.
   - Take the best 5 and choose among them with a hash of the tour id and item id (items have no `seed` field; so the same room always gets the
     same models, but two different rooms don't all get the identical sofa).
2. **`room-worker.ts`, step 2:** when `MODEL_STYLE` is `library` (the default on this branch), replace
   the `pool(..., runObjectWorker)` block with: for each brief, `pickModel` (use the lead item of the
   brief's group; dining-table chairs pick from `generic` "chair"), then prepare it (Part 5, cached),
   then an `ObjectResult` `{ assetId, status: "ok", glb, size: dims, attempts: 1, reason: "library <id>" }`.
   No pick, or preparation failed → no result, so the item keeps its box. `MODEL_STYLE=code` keeps
   today's code worker.
3. **Built-to-measure kitchens and wardrobes** (`BUILT_TO_MEASURE` in `briefs.ts`): no library pick;
   they stay boxes sized to their wall run.
4. **Scale on all three axes, after the turn:** Blender scales on the model's own axes before
   rotating, so a 90° or 270° turn swaps which model axis lies along the item's width. Store the
   per-axis factors as `[i.w / r.size.w, i.d / r.size.d, i.h / r.size.h]` at placement, and when the
   turn is known (orientation step, and in each `turnAll` render job) swap x and y for 90° and 270°:
   `[i.d / r.size.w, i.w / r.size.d, i.h / r.size.h]`. `Placement.scale` becomes
   `number | [number, number, number]` (fix the uses in `room-worker.ts`, e.g. the rounding in the
   report). In `blender/build_scene.py`
   (line ~171, `s = it.get("scale", 1)`), accept a number or a 3-array:
   `obj.scale = tuple(s) if isinstance(s, list) else (s, s, s)`. Skip the `MAX_PROPORTION_OFF`
   stand-in check for library results (log the stretch instead): the measured size is what counts.
5. **Facing:** keep the existing orientation step (`pickTurn`, 4 renders per room) unchanged.
6. **Credits:** `room.json` gets `library: [{ itemId, modelId }]`. On the model page
   (`src/app/app/properties/[id]/model/page.tsx`), when any room used an ABO model, show one line:
   "3D models from the Amazon Berkeley Objects dataset, provided by Amazon.com, simplified and resized (CC BY 4.0)." (The
   licence requires this credit.)

## Testing (only this)

1. `npx tsc --noEmit` and `npm run lint`.
2. `npx tsx scripts/selftest-lift.mts` with the two guard cases from Part 3.
3. `npx tsx scripts/build-library.mts`: the kind counts print and pass the check in Part 4.
4. One room: `npm run build:scene -- --tour listing-8218 --room main/r2 --fresh`, then
   `npm run build:models -- --tour listing-8218 --room main/r2`. Done when the photo items are
   library models of their kind, sized to their boxes, facing sensibly in the `compare-*.jpg`
   images, and `room.glb` is under about 30 MB.

The whole house (`npm run build:models -- --tour listing-8218`) is the owner's first real run, not
part of the implementation.

## Expected time per house

Scene build ~3–5 min. Furniture: preparing new library models ~30–60 s each in parallel (cached
afterwards), orientation and final build ~3–6 min. **About 7–10 minutes for a first house**,
less once the cache is warm.

## Later (not in this plan, in order of value)

1. **Kenney / Quaternius for missing kinds** (~15 min). Toilet, bathtub, shower, vanity and fridge
   stay boxes until then. **Needs a manual download:** the Kenney Furniture Kit
   (https://kenney.nl/assets/furniture-kit, "Download" button) and the Quaternius Ultimate House
   Interior Pack (https://quaternius.com/packs/ultimatehomeinterior.html, "Download" button), both
   CC0, unzipped into `exports/library-src/kenney/` and `exports/library-src/quaternius/`. Then
   import them in `build-library.mts` with sizes measured by `prep_library.py`.
2. **Three detect calls per photo with median points** (~30 min): Part 4 of
   placement-first-plan.md. Removes pointing outliers the guard misses.
3. **Gemini pick among the top 6 by photo crop** (~15 min): closer shapes (arms or not, round or
   square). Part 6c of library-placement-plan.md.
4. **`--rescene` for app tours** (~20 min): 3 check rounds for tours built in the app. Part 5 of
   placement-first-plan.md.
5. **Compare script** (~15 min): Part 7 of library-placement-plan.md.
6. **Gemini sorting of the index** instead of rules (~10 min + one run): fewer wrong kinds.

## Risks

- **A model faces the wrong way or has odd proportions.** The orientation check and per-axis scaling
  cover most; look at the `compare-*.jpg` images of the test room.
- **Stretching distorts details** (wide arms on a stretched sofa). Accepted: size and place come
  first. The proportion ranking keeps stretch small.
- **Wrong kind from the rules** (a stool sorted as a table). Fix the entry in `index.json`.
- **Large files.** The prepare step decimates and shrinks textures; check the size in test step 4.
- **The 0.15 m guard drops good items** near doorways or plan errors: raise `FLOOR_TOLERANCE` to
  0.25, don't remove the guard.
