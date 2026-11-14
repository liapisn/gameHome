# Furnished rooms from generated 3D models: the worker tree

Replaces Change 2 ("real furniture models") of [furniture-accuracy-plan.md](furniture-accuracy-plan.md).
Changes 1 and 3 of that plan are merged to `main` and are what this plan starts from.

**For the agent implementing this:** read this file top to bottom, then
[blender-loop-plan.md](blender-loop-plan.md) for how the existing pipeline works. Reuse code from
AnyScene as listed under "Code to take from AnyScene"; do not rewrite what is listed there.

## Goal

Every piece of furniture seen in a listing's photos becomes its own detailed 3D model, generated
from those photos, placed where the photos show it. Today each item is a coloured box
(`blender/build_scene.py`).

Decisions already made with the owner:

- Cost does not matter (hackathon credits). Use the best settings and both 3D generators.
- Ignore rate limits for now, but retry failed calls.
- Make models as detailed as possible. Browser performance is a later problem.
- Only a Gemini key is available for reasoning, so workers are our own TypeScript, not the
  Claude Agent SDK. Image and 3D generation run on fal (`FAL_KEY`).

Decided after reviewing this plan against `main` (2026-11-14):

1. **Item boxes are stored on the item.** `SceneItem.views` keeps each item's box in every photo,
   so stored scenes of admin-built tours can be cropped too. Older scenes fall back to the build's
   `detections.json`.
2. **Virtually staged photos** are removed from the listings by hand; nothing in code for now.
3. **Orientation is fixed by the room worker**, not the object worker: it renders every model at
   0°, 90°, 180° and 270° from each photo's camera and Gemini picks the turn that matches the photo.
   The object worker's front check (step 6 below) is dropped.
4. **Anything that repeats is made once and placed many times**: the room worker asks Gemini which
   items are copies of one product and briefs one model per group; a dining table also gets one
   chair model placed for every chair.
5. **Fitted kitchens and wardrobes are built to measure** (boxes in the photo's colours), not
   generated: a generated run rarely matches its wall.
6. Where photos are sent is not a concern for the hackathon.

## Shape

Three layers of workers. Each layer starts the next and waits for it.

```
House worker (1)
 ├─ Room worker (one per room with gated photos)
 │   ├─ Object worker (one per piece of furniture)   → one prepared .glb each
 │   ├─ Object worker …
 │   └─ Finishes worker (one per room)                → floor, wall, door looks
 │   then: place models, check, render beside the photos → room.glb
 └─ Room worker …
 then: join rooms → house.glb
```

A "worker" is a fixed sequence of steps in code, with Gemini making the judgement calls at set
points through `generateStructured` (`src/lib/ai/structured.ts`). It is not a free-form tool
loop. Fan-out is `Promise.all`.

| Layer | Steps in code | Where Gemini decides |
|---|---|---|
| House | Load tour, plans and scenes; start room workers; join results | Final look at the whole house |
| Room | Brief each object; start object workers; swap models in for boxes; grounding and collision checks; render from each photo's camera | Whether crops in different photos are one object; whether each returned model is acceptable; placement fixes |
| Object | Crop from every photo → clean product image → two 3D generators → prepare in Blender → same-light renders | Whether the clean image matches the crops; which mesh is better; which way is the front; retry or accept |

## What `main` already provides

| Need | Where |
|---|---|
| Photos in the right room | Owner floor, room type and room id are enforced at placement and at the gate (`build-tour.ts`, `build-scene.ts`). `TourPhoto.owner` carries them. |
| One item per real object | `mergeCandidates` in `src/lib/scene/lift.ts` merges across photos, including `generic` by normalised label. Each `SceneItem` has `seenIn` (photo ids) and `detections` (detection ids, each with a 2D `box`). |
| Plausible size in metres | `KIND_LIMITS` and `fitSize` in `lift.ts`. `SceneItem.w/d/h`, with the raw measurement in `measured` when clamped. |
| Weak guesses removed | `screenItems` drops items under `MIN_CONFIDENCE` (0.45) or of a kind that cannot be in the room. |
| Room shell in metres | `buildDollhouseScene` → `sceneToGlb`, used by `scripts/blender-scene.mts`. |
| Camera per photo, matched in Blender | `photoCamera` in `src/lib/scene/project.ts`; `build_scene.py` cameras; `--selftest` proves they agree to under 0.5 px. |
| Photo beside render | `compare-<photo>.jpg` from `scripts/blender-scene.mts`. |
| Colour pass | `src/lib/scene/look.ts`. |

So the room worker does not need to re-detect or re-merge: it starts from a `RoomScene`
(`npm run build:scene`), and its "same object" call is a check on that merge, not a replacement.

## Where it runs

Tour builds now run as a Vercel workflow (`src/workflows/build-tour.ts`). Its steps are short
function invocations with no shared disk and no Blender, so this stage cannot run there.

- **Now:** a CLI and the local worker, on a machine with Blender 5.3 and both keys.
  This PC has Blender 5.3 and `FAL_KEY` in `.env.local`. It has no `GEMINI_API_KEY` yet
  (`vercel env pull`, or add it by hand) and no `node_modules` (`npm install`).
- **Later:** a hosted Blender worker. AnyScene's `builder/app.py` shows how to run Blender on fal
  Serverless; out of scope here.

## Code to take from AnyScene

Source: **https://github.com/apekshik/anyscene** (MIT licence, read at commit `88c1daf`).

```bash
git clone --depth 1 https://github.com/apekshik/anyscene.git ../anyscene-ref
```

Clone it beside this repo, not inside it. Read `SKILL.md` and `builder/CRAFT.md` first: they are
the lessons from about 300 generated props and most of them apply here. Copy or port the files
below, and put this header on each one:

```
Adapted from https://github.com/apekshik/anyscene (<original path>), MIT licence.
```

Add `THIRD_PARTY_NOTICES.md` at the repo root with AnyScene's MIT licence text and the list of
files taken.

| AnyScene file | Becomes | How |
|---|---|---|
| `generate/fal.mjs` | `src/lib/fal/client.ts` | Port to TypeScript. Keep: queue submit, poll every 4 s, the `pending.json` resume so an interrupted run never pays twice, the "is it really a GLB" check, the spend log. Drop: the Windows registry key lookup and the $1000 cap. Add: image upload for crops. |
| `generate/models.mjs` | `scripts/fal-models.mts` | Port as is. Run it first to confirm the endpoint ids below still exist. |
| `endpoint/props.py` | `src/lib/models3d/reference.ts`, `mesh.ts` | Port the logic: `_crop` with 15% padding, the crop → clean-reference edit call, the `SCAN` prompt text word for word, the `MESH` settings for both generators, two retries, identical objects share one asset. |
| `scenes/tokyo-electronics-repair/scripts/prep.py` and `load_asset` in `endpoint/assemble.py` | `blender/prep_prop.py` | Copy and make it take a job file. Keep: join meshes, front to −Y (`FRONT_YAW`: Tripo 90, Meshy 0), clear Tripo's baked node rotation, set `rotation_mode = "XYZ"` before rotating, scale to real size, origin at bottom centre, repack only resized textures. Change: no decimation and textures up to 4K (full detail was chosen). |
| `pipeline/render_compare.py` | `blender/render_compare.py` | Copy. Renders every candidate under the same studio light, textured and clay, so they can be judged fairly. |
| `pipeline/grounding.py` | `blender/grounding.py` | Copy. Finds and fixes objects floating above or sunk into the floor, measured at their lowest vertices. |
| `scenes/tokyo-electronics-repair/scripts/validate.py` | `blender/validate_room.py` | Adapt: FLOAT, CLIP, OUT and SCALE checks against our room polygon and item sizes instead of its hard-coded room. |
| `swap` and `place_mesh` in `endpoint/assemble.py` | into `blender/build_scene.py` | Port the idea: build with boxes first, then replace each box whose model has arrived, then re-run grounding. |
| `CRITIC` prompt and `critic_schema` in `builder/scene_builder.py` | `src/lib/models3d/critic.ts` | Reuse the structure (scores per category, most damaging fixes first, pass threshold). Replace the categories with ours (below) and call Gemini through `generateStructured`. |
| `endpoint/refine.py`, `endpoint/refine_blender.py` | later | Glass, lit screens and lamps on generated props. Generators bake glass opaque; take this when a TV or glass cabinet looks wrong. |
| `builder/blender_gpu.py` | `blender/gpu.py` | Copy if renders use Cycles: headless Blender renders on the CPU unless told otherwise. |

Not taken: the cinematic parts (`camera/`, `breakdown/`, `farm/`, `blender_addon/`), the planner
that invents room layouts (`endpoint/planner.py`: our layout comes from the floor plan and lift),
and the Agent SDK harness.

fal endpoints used there (confirm with `scripts/fal-models.mts`):

- `openai/gpt-image-2.5/sunburst/edit`: crops → clean product image
- `openai/gpt-image-2.5/sunburst/text-to-image`: for objects no photo shows
- `tripo3d/h3.1/image-to-3d`: about 3.5 min, best for large hard-surface pieces
- `meshy/v7.1/image-to-3d`: 8 to 10 min, won about 70% of comparisons, mostly small items

Expect 10 to 20% of generation jobs to fail transiently. Retry the same job.

## Contracts

```ts
/** Room worker → object worker. */
interface ObjectBrief {
  itemId: string;                 // SceneItem.id
  label: string;                  // "three-seat grey fabric sofa"
  kind: SceneKind;
  /** Every view of this one object. The worker must model this object and nothing else. */
  views: { photoId: string; photoFile: string; box: Box2D; marked: string /* photo with the object outlined */ }[];
  /** Target size in metres from lift.ts, and how strictly to hit it. */
  size: { w: number; d: number; h: number };
  fit: "free" | "exact";          // exact: built-ins that must meet a wall run
  /** Built-ins only: what it has to fit. */
  wall?: { length: number; cornerAt: "left" | "right" | "both" | "none"; notes: string };
  color?: string; material?: SceneMaterial;
  workDir: string;
}

/** Object worker → room worker. */
interface ObjectResult {
  itemId: string;
  status: "ok" | "failed";
  glb?: string;                   // prepared model
  size?: { w: number; d: number; h: number };   // as built
  generator?: "tripo-h31" | "meshy";
  reference?: string;             // the clean product image
  preview?: string;               // same-light render
  attempts: number;
  reason: string;                 // why this one was picked, or why it failed
}
```

A prepared `.glb` is in metres, Z up in Blender, origin at the centre of its footprint on the
floor (back-centre for wall-hung items), front facing −Y. This is AnyScene's convention, so its
scripts work unchanged.

## Object worker: `src/lib/models3d/object-worker.ts`

1. **Crops.** Cut each view from its photo with 15% padding.
2. **Clean reference.** Send all crops to the edit endpoint with: "Recreate the {label} shown in
   these photos as one clean, complete object. They show the same object from different angles.
   Keep its exact design, colours, materials and condition." plus the `SCAN` text. Never send a
   raw crop to a 3D generator: it is occluded, in perspective and (for fixtures) watermarked.
3. **Reference check (Gemini).** Crops beside the clean image: same object, complete, nothing
   extra, no text or logos? If not, regenerate with the stated problem added to the prompt.
4. **Mesh.** Send the reference to both generators at once.
5. **Prepare.** `blender/prep_prop.py` on each result, scaled to `size`:
   uniformly by height for upright things and by footprint for flat ones (as AnyScene does).
   For `fit: "exact"`, then stretch each axis to the target, up to 15%.
6. **Front check (Gemini).** Render the prepared model from four sides; Gemini says which image
   shows the front. Rotate if it is not −Y. Generators guess the front from a three-quarter view
   and get it wrong often enough that sofas would face the wall.
7. **Pick (Gemini).** `blender/render_compare.py`, then crops | reference | Tripo | Meshy,
   textured and clay. Gemini picks one or rejects both, with a one-line reason.
8. **Size check (code).** Any axis more than 25% off the target fails the attempt.
9. **Retry.** Up to 3 attempts, each told what was wrong with the last. Then return the best
   attempt, or `failed`.

Every paid call is cached on disk by a hash of its inputs, like `cached()` in `build-scene.ts`,
so a rerun costs nothing.

Special cases:

- **Identical objects** (dining chairs, a pair of nightstands): one asset, placed several times.
- **Art and mirrors:** no 3D generation. A framed plane textured with the rectified photo crop.
- **Rugs:** a flat plane textured with a cleaned top-down image from the edit endpoint.
- **Items from rules** (`source: "rules"`, no photo): text-to-image reference in the room's
  palette, then the same steps. Mark the result as invented.
- **Fitted kitchens and wardrobes:** one object worker per run, `fit: "exact"`, with the wall
  length and corner in the brief. An L-shaped kitchen is one brief with both runs.

## Room worker: `src/lib/models3d/room-worker.ts`

1. Load the `RoomScene`; build it first if missing (`buildRoomScene`).
2. **Identity check (Gemini).** Per item, show its crops from all photos: one object or several?
   Split or merge items on the answer. Outline the object in each photo for the brief.
3. Write an `ObjectBrief` per item; start all object workers and the finishes worker together.
4. Build the room in Blender with boxes at once, so a render exists while models generate.
5. As results arrive, replace boxes with models (`build_scene.py`, new `asset` path per item).
6. **A failed object** keeps a stand-in the room worker builds itself: the viewer's primitive for
   that kind if there is one, else the box. A failure never loses the room.
7. `blender/grounding.py --fix`, then `blender/validate_room.py`.
8. Render from every gated photo's camera; write photo | render pairs.
9. **Placement check (Gemini), up to 3 rounds.** Per pair, per item: fine, facing the wrong way
   (turn by 90° steps), wrong model (send back to its object worker with the reason), or not in
   the photo. Positions stay as measured by lift: the model never moves things in metres.
10. Export `room.glb` (shell, finishes, models) and `room.json` (what was built, picks, reasons,
    failures, spend).

## Finishes worker: `src/lib/models3d/finishes.ts`

The walls, doors and windows stay as built from the floor plan: the camera poses are solved
against that geometry, and rebuilding it would break every placement. This worker only dresses it.

- Floor: a tileable texture generated from a floor crop, at the right scale.
- Walls and ceiling: colour from the photos (extend `look.ts`).
- Doors and windows: frame colour and style per opening, from the photos.

## House worker: `src/lib/models3d/house-worker.ts`

1. Load the tour and its plans; list rooms with `sceneRooms`.
2. Start one room worker per room, all at once.
3. Join the room files into `house.glb`, each room at its plan position and level height.
4. **Final check (Gemini):** a top-down render and one render per room. Uses the critic schema
   with these categories: identity (models match the photos), proportions, placement,
   materials and colour, completeness. Fixes go back to the named room worker, one round.
5. Write `house.json`: per room and per object status, generator picked, attempts, spend.

## Files

```
src/lib/fal/client.ts            fal queue client (ported)
src/lib/models3d/reference.ts    crops → clean reference
src/lib/models3d/mesh.ts         reference → Tripo and Meshy
src/lib/models3d/critic.ts       Gemini judgements: reference, front, pick, placement, house
src/lib/models3d/object-worker.ts
src/lib/models3d/room-worker.ts
src/lib/models3d/finishes.ts
src/lib/models3d/house-worker.ts
src/lib/models3d/types.ts        ObjectBrief, ObjectResult
blender/prep_prop.py             (adapted)
blender/render_compare.py        (copied)
blender/grounding.py             (copied)
blender/validate_room.py         (adapted)
blender/build_scene.py           + load a model per item, swap, finishes
scripts/build-models.mts         npm run build:models -- --tour <id> [--room <level>/<room>] [--item <id>]
scripts/fal-models.mts           check fal endpoint ids
THIRD_PARTY_NOTICES.md
```

Output goes to `exports/<tour>/models/` (already out of git): `objects/<item>/`, `rooms/<room>/`,
`house.glb`, `house.json`. For admin-built tours the worker uploads the same layout beside
`tour.json` in Storage.

## Milestones

| # | Deliverable | Done when |
|---|---|---|
| 0 | Setup | `npm install`; `GEMINI_API_KEY` and `FAL_KEY` in `.env.local`; `npm run blender:scene -- --tour listing-8218 --room main/r2 --selftest` passes; AnyScene cloned; `scripts/fal-models.mts` lists all four endpoints |
| 1 | One object by hand | The sofa of listing-8218 `main/r2`: crops, clean reference, both meshes, prepared, compare sheet written. No Gemini judgement yet |
| 2 | Object worker | Same sofa through the full loop with reference check, front check, pick and retries; reruns from cache with no paid calls |
| 3 | Room worker | `main/r2` with every item replaced or explained; grounding and validation clean; photo beside render for photos 01 and 02 |
| 4 | Finishes and built-ins | Kitchen run in `main/r3` fits its wall; floors textured in all rooms |
| 5 | House worker | All listing-8218 rooms in parallel; `house.glb` opens in Blender; `house.json` complete |
| 6 | Worker | `npm run worker -- --furnish --models` stores the models with the tour |
| 7 | Viewer | Later: load `room.glb` in `/tour/<id>`, with a lighter copy if needed |

Milestones 1 to 3 are the demo. Build them on listing-8218 `main/r2` (Living/Dining Room), which
has two gated photos and the most free-standing furniture.

## Risks

- **Look-alike, not a scan.** The clean reference is a redrawing of the object, so models
  resemble the furniture; they are not exact copies. The pick step keeps the closest.
- **Positions are still only as good as the camera poses** (0.5 to 1 m disagreement between
  photos was measured). Detailed models make a misplaced item more noticeable. Joint pose
  refinement remains the next accuracy work.
- **Time.** Meshy takes 8 to 10 min per object and retries multiply it. Everything runs in
  parallel, so a room takes about as long as its slowest object: plan for 15 to 30 min.
- **Size.** Full-detail models can be 100 MB or more per room. Fine for Blender; the viewer
  milestone will need a reduced copy.
- **Endpoint ids and settings** come from AnyScene as of late October 2026; check them first.
- **Fixture photos are third-party.** Nothing derived from them goes in `public/` or git.
