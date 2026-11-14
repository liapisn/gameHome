# Furniture accuracy: plan for the next three changes

Follows [blender-loop-plan.md](blender-loop-plan.md). That plan built the pipeline
(gate → detect → lift → check → Blender). This one fixes why its output looks wrong.

## Problem

Furnished rooms come out as misplaced, oddly sized blocks. Measured on the committed scenes in
`src/data/scenes/` (all built with `gemini-3.1-pro-preview`):

| Symptom | Evidence | Cause |
|---|---|---|
| Implausible sizes | fridge 1.04 m deep, vanity 0.24 m tall, sofa 0.36 m tall, "mirror cabinet" 9 cm wide | `sanitize()` in `lift.ts` clamps depth only; height and maximum width are unchecked |
| Depth pinned at the limit | fridge 1.04 = 0.65 × 1.6, kitchen run 0.96 = 0.6 × 1.6, larder 0.8 = 0.5 × 1.6 | Far floor contacts stretch along the view ray; the 1.6× ceiling is too loose |
| Duplicates | listing-15970 kitchen: 3 overlapping cabinet runs, 4 "wall cabinets" | `generic` items only merge on geometry, which disagrees by 0.5–1 m between photos |
| Guesses rendered as fact | 9 of 35 photo items have confidence 0.3 | No confidence floor |
| Blocks, not furniture | every Blender item is a bevelled cuboid | `build_scene.py` has no asset path; `SceneItem.asset` is never set or read |
| Furniture from other rooms | sofa in listing-8218 Kitchen / Entry; 12 of 24 posed photos in the wrong room on listing-15970 | Owner room hint is prompt context only; the gate fails a photo only above 70% outside contacts |

Not in scope here: joint pose refinement and solving camera pitch. They are the largest source of
position error and the next plan after this one.

## Change 1: plausible sizes, fewer duplicates, no weak guesses

All in `src/lib/scene/lift.ts` unless noted. No model calls; rebuilds from cached detections.

1. **Size limits per kind.** Replace the single depth rule in `sanitize()` with a table beside
   `KIND_SIZE`: `[min, max]` for width, depth and height per kind (for example fridge depth
   0.55–0.8, height 1.4–2.1; sofa height 0.6–1.0; vanity height 0.7–0.95). A dimension outside its
   range is clamped, anchored at the wall for wall-backed items and at the floor for height.
   `generic` keeps wide limits.
2. **Use the typical size when the measurement is far off.** If a measured dimension is beyond
   twice the limit, the contacts were wrong rather than imprecise: take the `KIND_SIZE` value
   and lower the item's confidence by one step.
3. **Wall-hung items.** Minimum 0.2 m on the visible face, and thickness from `KIND_SIZE`, so
   mirrors and pictures don't collapse to slivers.
4. **Merge `generic` by label.** In `sameThing()` and the cross-photo merge loop, treat two
   `generic` candidates as the same kind only when their normalised labels match (lower-case,
   singular, stop-words dropped: "wall cabinets" = "wall cabinet"). Then the existing
   "seen at most once per photo" rule can merge them like named kinds.
5. **Drop overlapping same-kind items.** After merging, when two items of one kind overlap by more
   than half the smaller footprint and share a height band, keep the higher-confidence one.
6. **Confidence floor.** In `buildRoomScene`, leave out photo items below 0.45 unless `builtIn`.
   Log what was dropped. Rule-based fill then covers the gap as it does today.
7. **Kind must suit the room.** Drop a detected kind that cannot belong to the room type
   (sofa or bed in a bathroom, bathtub in a kitchen). Open-plan groups from `detect.ts` stay
   compatible.

**Done when**

- `scripts/selftest-lift.mts` gains cases for each limit and still passes.
- Rebuilding the five committed scenes from cache gives no item outside its kind's limits, one
  cabinet run per wall in the listing-15970 kitchen, and no sofa in listing-8218 `main/r3`.
- Scene scores do not fall by more than 0.02 in any room.

## Change 2: real furniture models

Today both renderers draw primitives: `Furnishings.tsx` in the viewer, cuboids in Blender.

1. **Library.** `assets/furniture/<kind>/<variant>.glb` plus `assets/furniture/index.json`
   listing each model's kind, native size, front direction and licence. Start with the ten kinds
   that appear most: sofa, armchair, coffeeTable, diningTable, bed, wardrobe, fridge, toilet,
   vanity, tvUnit. CC0 sources only (Poly Haven, Kenney, Quaternius); record the source per file.
   Models are origin at floor centre, +Z up, front along the `Furnishing` front axis.
2. **Selection.** `src/lib/scene/assets.ts`: `pickAsset(item)` returns the variant whose
   proportions are closest to the item's `w × d × h`, or nothing when the best match would need
   more than 35% stretch on any axis. Sets `SceneItem.asset`. Deterministic, using `item.seed` to
   break ties.
3. **Blender.** `build_scene.py` imports the asset when `asset` is set, scales it to the box,
   applies the item's rotation and tints the main material towards `color`. Falls back to the
   cuboid. Kitchen runs, wall cabinets and other built-ins stay parametric: they must fit the wall
   exactly, which a fixed model cannot.
4. **Viewer.** `Furnishings.tsx` loads `asset` with `useGLTF` and falls back to the existing
   primitive. Serve models from `public/furniture/` (they are ours to publish, unlike fixture photos).
5. **Export.** `room.glb` then carries real meshes; check Draco size stays under about 2 MB a room.

**Done when**

- `npm run blender:scene -- --tour listing-8218 --room main/r2 --no-color` renders a sofa,
  coffee table and TV unit as models, and the camera self-test still passes.
- The viewer shows the same models at `/tour/listing-8218`.
- Every file in the library has a licence entry.

**Open question:** generated look-alike models (image-to-3D on photo crops) would match each home
better than a library, at a cost per item and with poor results on occluded objects. Library
first; revisit once Change 1 and 3 make positions trustworthy.

## Change 3: right photo, right room

1. **Structured room hint.** Add nullable `media.room_type` (the `RoomType` enum) in a new
   Supabase migration. `photo-manager.tsx` gets a room-type select beside the free-text hint.
   The worker passes it through the manifest as `photos[].roomType`; fixtures can set it too.
2. **Placement obeys the owner.** In `build-tour.ts`, when a photo has an owner level, restrict
   the model's choice to that level's rooms; when it has a room type, to rooms of that type
   (open-plan groups count as one). Today both are only sentences in the prompt.
3. **Gate obeys the owner.** `buildRoomScene` takes `ownerRoomType` per photo next to
   `ownerMismatch` and fails a photo whose owner type conflicts with the room, before any model call.
4. **Stricter contact rule.** Lower `MAX_OUTSIDE` from 0.7 towards the plan's original 0.2, but
   count only contacts of items lifted within 4 m of the camera, so objects seen through a doorway
   don't fail a good photo. Pick the value from the fixtures, not by guess.
5. **Pose quality counts.** A photo whose pose is not an `edges` fit passes only if its contact
   check has at least 3 contacts and none outside.
6. **Measure.** Extend `scripts/eval-gate.mts` to score the default (non-model) gate against the
   manifest labels and print kept-right / rejected-wrong per listing.

**Done when**

- On listing-15970 the default gate rejects at least 10 of the 12 wrong placements and keeps at
  least 10 of the 12 right ones (the target the first plan missed).
- On listing-8218 it still rejects both misplaced photos and keeps at least 7 of 9.
- A photo with an owner room type never lands in a conflicting room.

## Order

Change 1 first: it is small, needs no new data and makes every later comparison cleaner.
Change 3 next, because models placed in the wrong room are worse than boxes there.
Change 2 last.

## Risks

- **Clamping hides pose errors** instead of fixing them. Keep the raw measured size in
  `detections.json` so pose work can still be scored.
- **A stricter gate leaves rooms with no usable photo.** Those fall back to rule-based furniture;
  report the count per tour so it is visible.
- **Stretched models look wrong.** The 35% limit in `pickAsset` exists for this; tune it by eye.
- **Licences.** Only CC0 models go in `public/`.
