# Library furniture, full version on top of the small one

The small version ([library-small-plan.md](library-small-plan.md)) is built on this branch and works
end to end. This plan adds everything else from the full plan,
[library-placement-plan.md](https://github.com/liapisn/gameHome/blob/library-placement-plan/docs/library-placement-plan.md),
**on this branch, on top of the existing code**. Nothing is rebuilt from scratch. Keep every
`MODEL_STYLE` / env switch, so each part can be turned off to see what it changed.

Expected implementation time: about **2 hours**, plus one index run (~15 min). Do the parts in order:
each one is useful on its own, and they're sorted by how much they change what you see.

## What the small version does today (don't redo it)

- **Already done:**
  - Parts 1–3: Hydrogen at low thinking, 90 s timeout, the cut-off prompt and the lift guard.
  - `assets/library/index.json`: ABO only, kinds from the `kindOf` rules in
    `scripts/build-library.mts`.
  - `blender/prep_library.py`, cached in `exports/library-cache/<id>/`.
  - `src/lib/models3d/library.ts`:
    - `pickModel` ranks by proportions and takes one of the best 5 by hash. **No photo is looked
      at.**
    - `prepareModel` and `libraryObject`.
  - `room-worker.ts`: library step 2, per-axis `stretch` / `scaleFor`, `library` in `room.json`.
  - `build_scene.py`: list scale.
  - Credits in `app-tour.ts` and on the model page.
- **Why results look off,** largest first:
  1. **The model is chosen blind.** A sofa with arms, a round table or a bed with a tall headboard
     gets any model of the same kind whose proportions fit. → Part A.
  2. **Wrong kinds in the index from keyword rules** (side tables as nightstands, stools as chairs,
     odd items in `generic`). → Part B.
  3. **Bathrooms and kitchens are boxes** (ABO has no toilet, bath, shower, vanity, fridge or
     kitchen units). → Part E (needs a manual download).
  4. **Position noise:** one detect call per photo, and app tours get only 1 check round. → Parts C
     and D.

## Manual downloads

**Only Part E needs any.** If they aren't there, Part E is skipped and everything else works.

- **Kenney Furniture Kit** (CC0): https://kenney.nl/assets/furniture-kit, "Download" button.
  Unzip into `exports/library-src/kenney/`.
- **Quaternius Ultimate House Interior Pack** (CC0):
  https://quaternius.com/packs/ultimatehomeinterior.html, "Download" button. Unzip into
  `exports/library-src/quaternius/`. The pack has FBX, OBJ and Blend; the FBX or OBJ folder is
  enough.

`exports/` is git-ignored; the source zips are never committed.

---

## Part A: Gemini picks the model from the photo (~30 min) — biggest visible change

File: `src/lib/models3d/library.ts`, called from `room-worker.ts` step 2.

1. **Candidates:**
   - Split `pickModel` into `candidates(item, models, n = 6)`, which is today's filter and
     proportion score sorted and cut to `n` (raise `TOP` from 5 to 6), and the pick.
   - Keep `pickModel` as the fallback: top candidate by hash, as today.
2. **One call per room, after the briefs are made and before preparing,** with Hydrogen at low
   thinking (the default):
   - **Inputs per item:**
     - the item's first crop (the same crops `sameModels` / `cropViews` already make, 512 px);
     - its label and measured size;
     - its 6 candidates' thumbnails (the ABO `thumb` URLs; fetch with `fetch`, resize to 256 px
       with `sharp`, which is already a dependency of the crops; skip a thumbnail that fails);
     - each candidate's name and size.
   - Items with no photo view (`views` empty) skip the call and take the fallback.
   - **Schema:** `{ picks: [{ assetId, candidate: 0..5, why }] }`.
   - **Prompt:** "For each object, pick the candidate closest to the photo in kind and overall
     shape: arms or not, legs or a solid base, single or double, round or square, headboard or
     not, number of seats. Colour, fabric and exact style don't matter. If none is the same kind
     of object, answer -1."
   - **-1:** the item stays a box (the same path as "no library model" today).
3. **Batch** at most 12 items per call (with 6 thumbnails each, that's about 85 images). Run the
   batches in parallel. Cache the answers at `<room workDir>/library-pick.json`, keyed by assetId
   and candidate ids, so a rebuild with the same candidates makes no call.
4. **If the call fails,** every item takes the fallback and the room still builds. Log
   `library pick: <assetId> → <id> (<why>)`.
5. **Dining chairs:** the chair brief (label "dining chair") already goes through the generic
   "chair" match. It takes part in the same call, with the table's crop.
6. **Env:** `LIBRARY_PICK=gemini` (default) | `rank` (today's behaviour).

**Test:** build one room (see Testing), then look at the log's picks and `compare-*.jpg`.

## Part B: Gemini sorts the index instead of keyword rules (~25 min + one run)

File: `scripts/build-library.mts`.

1. **Keep `kindOf` as the first filter:** a listing it returns `null` for, apart from the
   catch-all `default`, stays out. Its result is sent along as a hint.
2. **Classifier:** for every remaining listing (and every listing of an unknown `product_type`
   whose name has a furniture word), send batches of 100 to Gemini: Hydrogen, low thinking,
   `generateStructured` from `src/lib/ai/structured.ts`.
   - **Input per model:** `id`, item name, product type, last node segment, size in metres,
     rule hint.
   - **Answer per model:** `{ id, kind | "skip", label }`.
   - **System prompt:** `KIND_GUIDE` from `src/lib/scene/detect.ts`, so kinds mean the same thing
     as in detection, plus the rules from the full plan:
     - armless dining and accent chairs → `generic` "chair";
     - armchairs, accent chairs with arms, recliners → `armchair`;
     - end and side tables → `nightstand` only when the name says bedside/nightstand; otherwise
       `coffeeTable` under 0.55 m tall, else `console`;
     - TV stands and media storage → `tvUnit`;
     - dressers and chests of drawers → `sideboard`;
     - headboards alone, pillows, vases, fans, frames, electronics and parts of sectionals →
       `skip`.
3. **Cache** each batch's answer at `exports/library-src/classify/<n>.json`, so a re-run costs
   nothing. About 60–80 calls, run 8 at a time.
4. **Output:**
   - Add `source: "abo" | "kenney" | "quaternius"` and `credit: string` to `LibraryModel`.
   - Print the per-kind counts and **how many changed kind from the rules**, with 20 examples, so
     the owner can eyeball them.
5. **Env:** `LIBRARY_CLASSIFY=rules` keeps today's index (for comparison).
6. **Commit** the new `index.json`.

## Part C: three detect calls per photo, median points (~30 min)

This is Part 4 of
[placement-first-plan.md](https://github.com/liapisn/gameHome/blob/placement-first-plan/docs/placement-first-plan.md),
unchanged. In short:

1. **`DETECT_VOTES`** (env, default 3; 1 = today's behaviour). In `src/lib/engine/build-scene.ts`
   (the `detect-${id}.v2.json` cache at line ~184), call `detectPhoto` that many times in
   parallel. Cache `{ cameraRoom, runs }` in `detect-<photo>.v3.json`.
2. **`voteDetections(runs, minVotes = 2)`** in `src/lib/scene/detect.ts`:
   - **Matching:** match items by kind (and `normaliseLabel` for `generic`) with box IoU ≥ 0.4,
     greedily.
   - **Kept:** an item found in ≥ 2 runs; `builtIn` items with one vote.
   - **Box:** the median box.
   - **Points:** a median per point from partners within 60 units. Drop points with no partner.
     If a floor item is left with no points, keep the base run's points.
   - **Other fields** from the base run (the run with the most items); `cameraRoom` by majority.
3. **Check loop:** unchanged.

**Test:** one case in `scripts/selftest-lift.mts`. One run's sofa floor point is 200 units off,
and the voted point lands within 5 units of the other two. An item in only one run is dropped.

## Part D: `--rescene` for app tours and overlays next to the renders (~20 min)

This is Part 5 of placement-first-plan.md.

1. **`--rescene`** in `scripts/build-models.mts`, with `--property`:
   - after `downloadAppTour`, rebuild each furnished room's scene with
     `buildRoomScene({ …, rounds: 3, workDir: <dir>/scenes/<level>-<room> })`, rooms in parallel;
   - furnish from those scenes;
   - upload them with the models, by the same path the workflow uses to store scenes.
   - Without the flag nothing changes. Vercel keeps `rounds: 1`.
2. **Overlays:** `build:models` copies the scene build's last-round overlays (`r<N>-*.jpg`,
   `topdown.png`) into `exports/<tour>/models/rooms/<key>/overlays/`, when the scene's work dir
   exists.

## Part E: Kenney / Quaternius for kinds ABO lacks (~30 min) — needs the manual download

1. **`blender/prep_library.py --pack <dir>` mode,** one boxd job per pack:
   - **Upload:** the unzipped folder goes up as the job's input. If it's over about 50 MB, upload
     only the FBX/OBJ subfolder.
   - **Per file:** import each `.fbx` / `.obj` / `.glb`, join it, put the origin at the floor
     centre, and export `assets/library/models/<source>-<name>.glb`.
   - **Thumbnail:** render a 256 px Eevee thumbnail to `assets/library/thumbs/<id>.png`.
   - **`pack.json`:** write `{ file, dims: [w, d, h], tris }` per model.
   - **Front:** check one bed and one toilet by eye. If a pack's models face +Y, add a
     per-source `turn: 180` in the index instead of fixing files.
2. **`build-library.mts`:** when `exports/library-src/kenney/` or `.../quaternius/` exists, read
   `pack.json`, classify the names with the Part B classifier (names only), and add entries with:
   - `source`, `credit: "CC0"`;
   - `url` = the local `assets/library/models/...` path;
   - `thumb` = the local png.
3. **`library.ts` / `prepareModel`:** a local `url` (not http) skips the boxd prep and uses the
   file as is. These models are small low-poly files.
4. **Candidates:** prefer ABO. Use pack models only when ABO has fewer than 3 candidates of the
   kind. In practice that's toilet, bathtub, shower, vanity, fridge, kitchen pieces and
   pot plants.
5. **Commit** `assets/library/models/` and `thumbs/`. They're CC0 and small; check the total is
   under ~30 MB.

## Part F: switches and comparison (~15 min)

1. **`LIBRARY_FITTED=box`** (default) | `code`. With `code`, `BUILT_TO_MEASURE` items (fitted
   kitchens, wardrobes) and `fit: "exact"` briefs go through the existing `runObjectWorker`
   instead of staying boxes. That's one `if` in room-worker step 2.
2. **`room.json`:** `library` entries get `source` and `picked: "gemini" | "rank"`. Credits in
   `app-tour.ts` collect each used source's `credit` (ABO's line once; CC0 needs none).
3. **`scripts/compare-builds.mts <dirA> <dirB> [...]`:** prints a table per room with:
   - the scene score;
   - the house review score (`house.json`);
   - library / box / stand-in counts;
   - placement problems;
   - build time.

   Add `startedAt` / `finishedAt` to `house.json` in `house-worker.ts`. Copy
   `exports/<tour>/models/` aside before each comparison run.

---

## Testing (keep it to this)

1. `npx tsc --noEmit`, `npm run lint`, `npx tsx scripts/selftest-lift.mts` (the old cases + voting).
2. **Index:** `npx tsx --env-file=.env.local scripts/build-library.mts`. The per-kind counts print,
   the main kinds have ≥ 20 each, and the changed-kind examples look right.
3. **One room, before and after:**
   - Copy the current `exports/listing-8218/models/rooms/main-r2/` aside.
   - Run `npm run build:scene -- --tour listing-8218 --room main/r2 --fresh`, then
     `npm run build:models -- --tour listing-8218 --room main/r2`.
   - **Done when:** the log shows Gemini picks with reasons, the overlays sit next to
     `compare-*.jpg`, and the furniture shapes match the photo better than the copy.
4. **Part E only,** if downloaded: build one bathroom room. The toilet and bath are pack models,
   not boxes.
5. The house run and the comparison are the owner's.

## Expected time per house

- **About 8–13 min for a first house:** the old 7–12 min, plus about 15 s per room for the pick
  call and about 10 s per photo for voting. The three detect calls run at once, so they cost little
  extra time but triple the detect tokens.
- **Warm cache:** about 6–9 min.
- **Cheaper runs:** `DETECT_VOTES=1` and `LIBRARY_PICK=rank` bring cost and time back to the small
  version.

## Risks

- **Thumbnails show the product photo, not the 3D model.** For ABO they match closely enough. If
  picks look wrong, render the prepared models instead (`prep_library.py` can render one 256 px
  view per model; it's slower the first time).
- **Too many images per call:** lower the batch from 12 items to 6.
- **Classifier mistakes:** fix the entry in `index.json` by hand, or add a rule hint.
- **Pack models face the wrong way or are in centimetres:** per-source `turn` / scale in
  `pack.json`; the orientation check covers facing.
- **Mixed styles** (realistic ABO next to low-poly packs): accepted, packs are used only where ABO
  has nothing.
