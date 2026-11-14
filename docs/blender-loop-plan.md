# Photos → furnished 3D rooms: implementation plan (v2)

Branch: `blender-pipeline`. Status: plan only, nothing implemented yet. This replaces the first
draft, which had the model estimate distances and score its own renders (see "Why v2" at the end).

## Goal

From a listing's photos, build 3D furniture and fixtures that match what the photos show, and
serve them in the existing three.js tour. The model **sees the photos and the model it is
building** twice: as 3D boxes drawn on the real photo (geometry), and as a Blender render next to
the photo (look).

## Principle

The repo already works this way for camera poses: **the model points, geometry measures.**
The vision model picks pixels and names things. Code turns pixels into metres using the solved
camera. The model is never asked for a distance in metres or a quality score that decides
anything.

```
tour.json (plans, photo → room, camera poses)
   │
   ▼
0. gate      is this photo really in this room, with a usable pose?   → keep / drop
1. detect    one call per photo: items, floor-contact pixels, colours
2. lift      pixels + pose → positions and sizes in metres; merge across photos → scene.json
3. check     draw scene boxes on each photo; model corrects pixels; box overlap is the score
             (repeat 2–3, at most 3 rounds)
4. look      Blender: real models + materials, render from the photo's pose, colour pass
5. export    scene.json for the viewer now; compressed .glb from Blender later
```

## What already exists (reuse)

| Need | In the repo |
|---|---|
| Floor plan in metres (walls, openings, rooms) | `src/lib/floorplan.ts`, `src/lib/floorplan-parser/` |
| Photo → level, room, finishes | `src/lib/tour/place-photo.ts` |
| Camera pose per photo | `src/lib/tour/estimate-pose.ts` → `TourPhoto.pose` (x, y, yaw, hfov, height, horizon; pitch is always 0) |
| 3D → photo projection, drawn over the photo | `scripts/debug-edges.mts` (`proj`) |
| Plan ↔ three.js world, photo camera | `src/lib/tour/space.ts` |
| Furniture format and rule-based layout | `Furnishing`, `furnishPlan()`, `footprint()` in `src/lib/tour/furnish.ts` |
| Furniture rendering in the viewer | `src/components/tour/Furnishings.tsx` |
| Images + prompt → zod-validated JSON (Gemini or Claude) | `src/lib/ai/structured.ts` |
| House shell as .glb | `npm run export:glb` |
| Ground truth for scoring | `fixtures/listing-15970/manifest.json` (photo → level/room labels) |

## Test data (listing-15970)

Rooms are keyed `${levelId}/${roomId}` (`roomKey`). Room ids repeat per level.

- **Primary test room: `upper/r1` Kitchen.** 3 posed photos (06, 07, 08), all `edges` fits, all in
  the right room per the manifest.
- Second room: `upper/r11` Living Room. 4 posed photos; 02 and 03 are correct, 04 is the dining
  room, 25 is another unit.
- Known-bad set for the gate: 12 of the 24 posed photos are in the wrong room per the manifest,
  9 of them `edges` fits marked high confidence (for example 13, 15, 27, 37 in `ground/r1` Office).
  The stored tour may predate the engine's owner-hint support; rebuild it in milestone 0.
- Photos are third-party and watermarked. Nothing derived from them goes in `public/`.

## Data contract: `scene.json`

One file per room. It extends `Furnishing`, so the viewer and `furnishPlan()` keep working.

```ts
type SceneKind = FurnishingKind | "generic";   // "generic" = a labelled box for anything else

interface SceneItem extends Omit<Furnishing, "kind"> {
  kind: SceneKind;
  label: string;                 // what the model called it: "corner sofa", "display cabinet"
  color?: string;                // "#rrggbb", overrides the seed colour
  material?: "fabric" | "wood" | "metal" | "ceramic" | "glass" | "stone" | "plastic";
  builtIn?: boolean;             // fitted kitchen, wardrobes, fireplace: fixed parts of the home
  group?: string;                // pieces of one object, e.g. the two runs of an L-shaped kitchen
  asset?: string;                // library or generated model; falls back to the primitive
  source: "photos" | "rules";    // detected, or filled in by furnishPlan()
  seenIn: string[];              // photo ids
  confidence: number;            // 0..1 from view count, distance and fit
}

interface RoomScene {
  tourId: string; levelId: string; roomId: string;
  look: RoomLook;
  items: SceneItem[];
  photos: { id: string; gate: "pass" | "fail"; reason: string }[];
  score: number | null;          // mean box overlap from the check stage
}
```

v1 limits, on purpose: rotations stay multiples of 90° in plan axes (`footprint()` assumes it).
L-shapes are two items sharing a `group`. Free rotation is a later change.

## Stages

### 0. Gate: `src/lib/scene/gate.ts`

A photo enters the pipeline only if it passes. Signals, cheapest first:

1. **Owner hints.** The admin uploads carry the owner's floor and room note. Trust them over the
   model's pick when they disagree.
2. **Pose quality.** Start with `fit.method === "edges"`. Others can pass only on signals 3–4.
3. **Outline check (one model call).** Draw the room outline and its doors and windows on the
   photo with the stored pose (as `debug-edges.mts` does). Ask: do the ceiling lines sit on the
   ceiling edges, the corners on corners, and each drawn opening on a real door or window? Answer
   per element, then pass or fail.
4. **Floor-point sanity (free, from stage 1).** If more than about 20% of detected floor points
   land outside the room, the room or pose is wrong: fail the photo.
5. **Cross-photo consistency.** Within a room, a photo whose floor and wall colours disagree with
   the others is flagged.

**Measured against the manifest.** Target on listing-15970: reject at least 10 of the 12 wrong
placements and keep at least 10 of the 12 right ones. If the gate can't reach that, fix
placement before building further.

### 1. Detect: `src/lib/scene/detect.ts`

One `generateStructured` call per gated photo. Per item:

- `label`, `kind` (from the list, else `generic`), `builtIn`, `color`, `material`
- `box`: 2D bounding box, `[ymin, xmin, ymax, xmax]` in 0–1000 (Gemini's native format)
- `floorPoints`: the visible bottom corners of its footprint, `[y, x]` in 0–1000, 2 to 4 points
- `topPoints`: for one or two floor points, the point straight above on the item's top edge
- `againstWall`: whether its back touches a wall

Wall-hung items (art, upper cabinets, TV) give their box and the wall they hang on instead of
floor points. Rugs give their visible corners.

### 2. Lift: `src/lib/scene/lift.ts` and `project.ts`

`project.ts` holds the one shared camera model: `project(pose, aspect, [x, y, z]) → [u, v]`
(moved out of `debug-edges.mts`) and its inverse for a known height:

```
f = 0.5 · height / ((v − horizon) · tan(hfov/2) · aspect)      distance ahead, for a floor pixel
l = (u − 0.5) · 2 · f · tan(hfov/2)                              offset to the right
x = pose.x + f·cos(yaw) − l·sin(yaw);   y = pose.y + f·sin(yaw) + l·cos(yaw)
z_top = height − 2 · (v_top − horizon) · f · tan(hfov/2) · aspect   item height from a top pixel
```

Then, per item:

- Fit a 90°-aligned rectangle to its floor points. When only the front edge is visible, take
  the depth from a per-kind table and extend it away from the camera.
- `againstWall`: snap the back to the nearest wall face within 0.3 m. Clamp inside the room
  polygon and out of door zones (reuse `RoomLayout` helpers).
- Weight each point by distance: error grows roughly with distance squared, so near views win.
- **Merge across photos:** same kind and overlapping footprints (or centres within 0.6 m) are one
  item; average with the weights; `confidence` rises with each extra view.
- Fill what no photo shows with `furnishPlan()` items marked `source: "rules"`, only where they
  don't collide with detected items.

Also writes a top-down SVG of the room with every footprint and the camera positions, for
checking by eye.

### 3. Check loop: `src/lib/scene/check.ts` and `overlay.ts`

- **Overlay:** draw every item's 3D box on each photo with `project()`, labelled with its id.
  Pure Node (`sharp` + SVG), a few milliseconds per photo, same maths as the viewer.
- **Score, no model involved:** for each item and photo, overlap (IoU) between the projected box's
  2D bounds and the detected `box`. Room score = mean over matches, with a penalty for detected
  items that have no box and boxes that match nothing.
- **Model call per photo:** given the overlay, list (a) boxes that don't fit, with corrected
  floor and top pixels, (b) missing items, with their pixels, (c) boxes with nothing under them.
  Corrections go back through the lift. The model never moves anything in metres.
- **Rules:** keep a round only if the score rose. Stop when nothing changes or the gain is under
  0.02. At most 3 rounds.

### 4. Look: Blender

`blender/build_scene.py`, run with `blender -b --factory-startup -P … -- <args>`, started from
`src/lib/blender/run-blender.ts` (`BLENDER_PATH`, default
`C:\Program Files\Blender Foundation\Blender 5.3\blender.exe`; fail on a version mismatch).

- **Build:** import the shell .glb, apply `look`, place each item's asset scaled to `w × d × h`,
  or a primitive when there is no asset. Plan `(x, y, h)` → Blender `(x, −y, h)`, rotation `−rot`
  about Z.
- **Camera self-test (no model):** render the bare shell from a photo's pose and compare its
  edges with the outline `project()` draws. They must coincide, including photos whose `horizon`
  is not 0.5 (lens `shift_y`). This catches mirroring and frustum mistakes before any use.
- **Colour pass:** photo beside render, one or two model calls per room, edits limited to
  `color`, `material`, `look` and `asset`.
- **Export:** one Draco-compressed .glb per room or level.

### 5. Viewer

- **First:** `Furnishings.tsx` reads `color` and draws `generic` as a labelled box. `TourViewer`
  uses a room's `scene.json` instead of `furnishPlan()` when one exists. Photographed rooms then
  have furniture, with a toggle between **photo view** (today's projection) and **3D view**.
- **Later:** load the Blender .glb with `useGLTF` in place of primitives.

## Files

```
src/lib/scene/types.ts      SceneItem, RoomScene, zod schemas
src/lib/scene/project.ts    shared camera model (project + inverse)
src/lib/scene/gate.ts       stage 0
src/lib/scene/detect.ts     stage 1
src/lib/scene/lift.ts       stage 2
src/lib/scene/overlay.ts    box overlays and top-down SVG
src/lib/scene/check.ts      stage 3
src/lib/engine/build-scene.ts   orchestrates a room or a whole tour
scripts/build-scene.mts     npm run build:scene -- --tour listing-15970 --room upper/r1 [--all]
scripts/selftest-lift.mts   synthetic cameras: project known boxes, lift them back, compare
blender/build_scene.py      stage 4
src/lib/blender/run-blender.ts
src/data/scenes/<tour>/<level>-<room>.json
```

Per-run artefacts (overlays, renders, scores) go to `exports/<tour>/<level>-<room>/`, which stays
out of git.

## Milestones

| # | Deliverable | Done when |
|---|---|---|
| 0 | App runs here | `npm install`, `.env.local` with the Gemini key, tour opens at `/tour/listing-15970`, `debug-edges` overlays written, tour rebuilt with the current engine and its room accuracy recorded |
| 1 | `project.ts` + self-test | Synthetic boxes projected and lifted back land within 2 cm; `debug-edges` uses the shared code |
| 2 | Gate | Gate decisions scored against the manifest; target met or placement fixed |
| 3 | Detect + lift for `upper/r1` | `scene.json` and top-down SVG for the Kitchen; fridge, table, both cabinet runs present and inside the room |
| 4 | Viewer shows it | Kitchen in the browser with detected furniture and the photo/3D toggle |
| 5 | Check loop | Overlays and scores per round; score rises or holds over up to 3 rounds; second room (`upper/r11`) run |
| 6 | Blender builder | Camera self-test passes; render + colour pass; .glb loads in the viewer |
| 7 | Better models | Library or generated assets for the common kinds; optional photo-textured furniture (below) |
| 8 | Whole tour + worker | `build:scene --all`; optional step after `buildTour` in `scripts/worker.mts` |

Milestones 0–5 need no Blender. The hackathon demo is reachable at milestone 4 or 5.

## Options after the core works

- **Fixed things first.** Fitted kitchens, bathroom fixtures, fireplaces, floors and wall colours
  define a home more than movable furniture. Prioritise `builtIn` items in detection and assets.
- **Photo-textured furniture.** With boxes in the right place, project the best photo onto them in
  Blender and bake it to textures. Furniture then carries its real look and holds up as you walk
  away from the photo spot. Needs unwatermarked photos.
- **Look-alike models.** Image-to-3D on photo crops (fal credits) instead of a generic library.
  Untested here; occluded items will come out poorly.
- **Baked lighting.** Leave until everything else works; the viewer's lights are enough for a demo.

## Setup

- `npm install` (there is no `node_modules` on this PC yet).
- `.env.local`: `GEMINI_API_KEY`. The stored tour and the probe both ran on
  `gemini-3.1-pro-preview` (what `gemini-pro-latest` resolved to).
- Blender 5.3 is installed; headless .glb export is verified.

## Cost

About 5 model calls per gated photo: 1 gate, 1 detect, up to 3 check. The detect probe used about
1,200 input tokens and took 7 seconds. A 24-photo tour is on the order of 120 calls. The hackathon
key's rate limits are still unknown, so run rooms one at a time first.

## Risks

- **Placement accuracy** is the biggest. If the gate can't separate right rooms from wrong ones,
  nothing after it is trustworthy. Owner hints are the strongest fix.
- **Lift error.** The probe was one photo with a precise pose. Expect ±0.2–0.3 m, worse for far
  objects and shallow viewing angles: the right-hand cabinet came out 0.15 m deep, where about
  0.4 m is likely.
- **Poses assume level cameras** (pitch 0) and one horizon row. Tilted phone photos will lift badly
  until pitch is solved.
- **Occlusion.** Floor contacts hidden behind other furniture give no points; those items rely on
  another view or the per-kind depth table.
- **Thin coverage.** Most rooms have 1–3 photos and 25 of 48 are unplaced, so much of the house is
  filled by rules, not photos.
- **Blender API drift** in 5.3 against older examples; pin the version.
- **Licensing and privacy.** Fixture photos are third-party. For real listings, photo-derived
  textures can carry personal items, which the product spec says to blur.

## Why v2

Checked against the code and `fixtures/listing-15970`:

- The first draft's test room, "`r1` with 8 posed photos", was two rooms on different levels.
- 12 of 24 posed photos in the stored tour are in the wrong room, including 9 of 19 high-confidence
  `edges` fits. A loop without a gate would furnish rooms from other rooms' photos.
- The first draft had the model move items by metres and score renders from 0 to 5. Both are noisy,
  so keeping the "best" round would follow noise.
- It rendered in Blender every round, which is slow and needs the camera rebuilt in a second
  coordinate system. Overlays on the photo use the repo's own projection.
- **Probe:** on kitchen photo 06 the model marked floor-contact pixels and code lifted them with the
  stored pose. All 22 points landed inside the room; the fridge measured 0.66 m wide and the
  cabinet fronts lined up with it. One call, 7 seconds.
