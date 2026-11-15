# Furniture built as Blender code, run on boxd

Replaces how objects are made in [agent-tree-plan.md](agent-tree-plan.md), which is implemented on
`main` (`src/lib/models3d/`). The three layers of workers stay. What changes:

1. **No fal and no AnyScene code.** Image-to-3D was too expensive and too fragile. Remove both
   completely (list below).
2. **Each object is written as Blender Python by Gemini**, from the photos of that object, then
   rendered, compared with the photos and revised.
3. **Blender never runs on the laptop.** Every Blender run happens on a boxd machine.

**For the agent implementing this:** read this file, then `src/lib/models3d/` as it is on `main`.
Most of it stays. The work is one new Blender runner, one new object worker, a small helper
library for Blender, and deletions.

## Shape

```
House worker (laptop, Node)                 src/lib/models3d/house-worker.ts   (stays)
 └─ Room worker, one per room               src/lib/models3d/room-worker.ts    (stays, small edits)
     ├─ Object worker, one per object       src/lib/models3d/object-worker.ts  (rewritten)
     │     Gemini writes the object as Blender code
     │     → its own boxd machine builds, measures, renders it
     │     → Gemini compares the renders with the photos → revised code   (up to 5 runs)
     │     → one .glb
     └─ then: room built and rendered on a boxd machine → room.glb
 └─ then: house joined on a boxd machine → house.glb
```

The laptop only sends instructions and files. Workers at every layer run at the same time.

## Why this can work where image-to-3D did not

- **Size, position and facing are right by construction.** The code builds the object in a known
  frame (metres, front towards −Y, standing on the floor), so there is nothing to detect or fix
  afterwards. Most of the old pipeline's failures were in that fixing.
- **Fitted furniture fits.** A kitchen run is built to the exact wall length.
- **Models are light.** A few thousand triangles each, so the browser viewer is not a problem.
- **Cost is boxd time and Gemini calls only.** About €1 to €2 of boxd per house (measured rates below).

What it costs: models look clean and designed, not photographic. Hard-edged furniture (tables,
cabinets, beds, shelves, appliances) comes out well. Soft or organic things (plants, throws,
rumpled bedding, ornate chairs) come out simplified. The helper library and the revise loop
below are what keep quality up; do not skip either.

## boxd: measured on this account (2026-11-14)

| | |
|---|---|
| Limit | 100 machines at once, subscription active |
| Machine | Ubuntu 24.04, 8 vCPU, 32 GB, no GPU |
| Snapshot | `gh-blender-5-3`: Blender 5.3.0 at `/usr/local/bin/blender`, already saved in the account |
| Start from snapshot | 3 to 4 s alone, 12 to 16 s when 20 start together |
| Cycles on CPU, 960×640, 16 samples | about 20 s (15 to 38 s with 20 machines busy) |
| Cycles on CPU, 1280×853, 64 samples | about 66 s |
| Eevee | 118 s: slower than Cycles without a GPU. **Use Cycles on CPU for everything.** |
| Import a 164 MB room | 29 s |
| Price | at most €0.70 per machine-hour for this size, billed per second |

SDK: `@boxd-sh/sdk` (0.3.2 tested), ESM, reads `BOXD_API_KEY` from `.env.local`.

```ts
import { Boxd } from "@boxd-sh/sdk";
const boxd = new Boxd({ timeout: 15 * 60_000 });          // default is 60 s: too short for exec
const m = await boxd.machines.create({ name, fromSnapshot: "gh-blender-5-3", config: { autoDestroyTimeout: 3600 } });
await boxd.machines.waitUntilReady(m.id);
await boxd.machines.files.upload(m.id, "/work/job.json", bytes);          // or { fromPath }
const r = await boxd.machines.exec(m.id, { command: "blender -b --factory-startup -P /work/x.py -- /work/job.json", timeout: 10 * 60_000 });
const png = await boxd.machines.files.download(m.id, "/work/out/front.png");   // Uint8Array
await boxd.machines.delete(m.id);
```

Notes from testing: `r.stdout`, `r.stderr`, `r.exitCode`. A just-deleted machine can stay in
`machines.list()` for a few seconds. Machines started from the snapshot keep its 8 vCPU.

## Part 1: the boxd Blender runner

Every Blender run already goes through one function, `blenderJob(script, jobFile, job)` in
`src/lib/models3d/util.ts`. Keep its signature and put boxd behind it.

New `src/lib/boxd/runner.ts`:

- **`withMachine(fn)`**: lease a machine from a pool (start from the snapshot when none is free,
  up to `BOXD_MACHINES`, default 30), run `fn`, return it to the pool. `closePool()` deletes every
  machine; call it in a `finally` in `scripts/build-models.mts` and on SIGINT. Every machine also
  gets `autoDestroyTimeout: 3600` so a crashed run cleans itself up.
- **`runOnMachine(machine, script, job)`**:
  1. Walk the job JSON. Every string that is an existing local file is uploaded to
     `/work/in/<hash><ext>` and replaced by that path. Output paths (the job's `out`, `outDir`,
     `glb` fields, as the scripts in `blender/` name them) are replaced by paths under `/work/out/`.
  2. Upload the script and anything it imports from `blender/`.
  3. `exec` Blender with a timeout. Success is the script's marker line (`MARKER` in `util.ts`),
     as today: Blender exits 0 even when the script raised.
  4. `tar` `/work/out`, download it, unpack it to the local output paths. Clear `/work`.
- `blenderJob` calls `withMachine` + `runOnMachine`. **Delete the one-at-a-time queue**: each job
  has its own machine. `BLENDER_RUNNER=local` keeps the old local path for the fixed scripts only.
- `scripts/boxd-snapshot.mts`: rebuilds the snapshot from scratch, so it is reproducible:
  `ubuntu:24.04`, 8 vCPU / 32G; `apt-get install curl xz-utils ca-certificates libxi6 libxxf86vm1
  libxfixes3 libxrender1 libgl1 libegl1 libxkbcommon0 libsm6 libice6 libx11-6 libxext6
  libglu1-mesa`; download `blender-5.3.0-linux-x64.tar.xz` from download.blender.org, check it
  against the published sha256, unpack to `/opt`, link to `/usr/local/bin/blender`;
  `boxd.snapshots.create(id, "gh-blender-5-3")`. With `--clean` it instead deletes every machine
  whose name starts with the pool's prefix (leftovers from a crashed run).

In the scripts under `blender/`, set `scene.cycles.device = "CPU"` and Cycles as the engine where
they render (`build_scene.py` tries Eevee first today).

**Done when:** `npm run blender:scene -- --tour listing-8218 --room main/r2 --selftest` passes
with Blender running on boxd and no Blender process on the laptop.

## Part 2: the helper library, `blender/gh_parts.py`

Gemini writes better and shorter code when it composes tested pieces than when it writes raw
`bpy` each time, and raw `bpy` written from memory breaks on Blender 5.3 API changes. Write this
once by hand, run every function on the snapshot, and upload it with each object job.

Shapes (all in metres, returning the object, taking a material):

- `box`, `rounded_box(size, radius)`, `cylinder`, `cone`, `sphere`, `tube(path, radius)`
- `panel(w, h, t)`, `slab_top(w, d, t, overhang, edge_radius)`
- `leg(height, top, bottom, shape="square"|"round")`, `leg_set(w, d, inset, ...)` (four at once)
- `cushion(w, d, h, puff)` (subdivided and slightly inflated), `pillow`
- `door_front(w, h, style="flat"|"shaker"|"glass", handle=...)`, `drawer_front`, `handle(kind, length)`
- `shelf_unit(w, d, h, shelves, back)`, `frame(w, h, bar)` (bed frames, chair backs, railings)
- `mattress`, `lampshade`, `plant_pot`, `foliage(radius, height, density)` (leaf cards on stems)
- `mirror_x(obj)`, `array(obj, count, offset)`, `bevel(obj, width)`, `smooth(obj)`, `join(objs, name)`

Materials (Principled BSDF, procedural, no image files):
`wood(color, grain)`, `painted(color, gloss)`, `fabric(color, weave)`, `leather(color)`,
`metal(color, brushed)`, `chrome()`, `glass(tint)`, `ceramic(color)`, `stone(color, veining)`,
`plastic(color)`, `rattan(color)`.

Also `blender/test_gh_parts.py`: calls every function once and renders a contact sheet.

**Done when:** `test_gh_parts.py` runs clean on a machine from the snapshot and the sheet looks right.

## Part 3: the object worker (rewrite `src/lib/models3d/object-worker.ts`)

Input and output stay `ObjectBrief` → `ObjectResult` (`types.ts`), so the room worker barely
changes. One boxd machine is leased for the whole object and reused across its runs.

1. **Crops.** `cropViews(brief)` as today (move it out of `reference.ts` into `crops.ts`).
2. **Design sheet (Gemini, high effort).** From every crop, the label and the target size: a parts
   list. For each part: what it is, its size and position in metres inside the object's box,
   material and colour (hex, read from the photo), and how visible it is in the photos. Plus what
   cannot be seen and is assumed. This makes the model look before it codes.
3. **Code (Gemini, high effort).** Writes one Python function:

   ```python
   def build(gh, size):      # gh = gh_parts, size = (w, d, h) in metres
       ...                   # origin at the centre of the footprint on the floor, front towards -Y
       return [objects]
   ```

   The prompt carries the `gh_parts` reference (signatures and one-line descriptions), the frame
   rules, and "build this one object and nothing else: no floor, no walls, no lights". Raw `bpy`
   is allowed for what the library lacks.
4. **Run on boxd: `blender/run_object.py`** (fixed harness, written by hand):
   - empty scene; `exec` the code inside `try`/`except` and keep the traceback;
   - checks: at least one mesh, finite bounds, under 500k triangles, nothing below the floor;
   - measure the bounding box. Within 30% of the target on every axis: scale each axis to the
     target exactly and re-centre the origin. Further off: report it as an error;
   - render with Cycles on CPU, 640 px, 24 samples, neutral studio light: front, back, both
     three-quarter views, top, and one untextured view. About 10 s each;
   - export `object.glb`; write `result.json` (`ok`, `error`, `dims`, `tris`, part names).
5. **Critic (Gemini, medium effort).** The crops beside the renders. Returns a score from 0 to 10
   and a list of fixes, most damaging first, each naming a part: wrong shape, missing part, wrong
   proportion, wrong colour or material, facing the wrong way. Passes at 7 or more with no part missing.
6. **Revise.** Send back the previous code with either the traceback or the critic's fixes, and
   ask for the full corrected function. Up to **5 runs** in total. Keep the best-scoring run.
7. **Return** the best run's `.glb`, its front render as `preview`, score, runs used and the
   critic's summary as `reason`. If no run ever produced a mesh: `status: "failed"`, and the room
   worker keeps the box, as it does now.

Each run is cached under `workDir/r1/ … r5/` (design sheet, code, result, renders, critique), so
a rerun repeats nothing.

Changes to `types.ts`: drop `Generator` and `reference`; add `score`, `script` (path of the
chosen code), and to `ObjectBrief` an optional `fit: "exact"` with `wall: { length, cornerAt, notes }`.

### Which Gemini model

Decided with the owner: **the whole pipeline moves to Gemini 4.** Carbon everywhere, except the
object workers (the third layer), which run on Hydrogen because there are many of them and each
makes about a dozen calls.

The committed tours and scenes were built with `gemini-3.1-pro-preview` (what `gemini-pro-latest`
resolved to). No step should use a Gemini 3 model after this change.

Reported as current in mid-November 2026 (from third-party listings; **confirm both ids against
the Gemini API's model list with the key before anything else**):

| Part | Model |
|---|---|
| Floor plan reading, photo placement, room estimates (`build-tour.ts`, `floorplan-parser/`) | `gemini-4-carbon` |
| Furniture detection, gate, check loop, colour pass (`src/lib/scene/`) | `gemini-4-carbon` |
| House worker: final check | `gemini-4-carbon` |
| Room worker: same-object check, turn check, placement | `gemini-4-carbon` |
| **Object worker: design sheet, code, revisions, object critic** | **`gemini-4-hydrogen`** |

Carbon is listed as Google's strongest model (released 2026-11-10), Hydrogen as the fast one
(released 2026-11-12).

To make that possible:

- In `src/lib/ai/structured.ts`, change the default from `gemini-pro-latest` to `gemini-4-carbon`
  (`GEMINI_MODEL` still overrides it), and let `generateStructured` take an optional `model` per
  call. The object worker passes `GEMINI_MODEL_OBJECT`, default `gemini-4-hydrogen`.
- Set `GEMINI_MODEL=gemini-4-carbon` on the Vercel deployment too: tour builds run there.
- Its `thinkingConfig: { thinkingLevel }` was written for Gemini 3. Check what Gemini 4 accepts
  with one call before running anything else; a wrong field fails every model call.
- **Re-check the photo gate.** Its thresholds were chosen from 3.1 Pro's answers. After the
  switch, run `scripts/eval-gate.mts` on listing-15970 and listing-8218 and confirm it still
  rejects the wrong photos and keeps the right ones; retune `MAX_OUTSIDE` if not.
- **Bake-off at milestone 3:** build the same sofa once with `gemini-4-hydrogen` and once with
  `gemini-4-carbon` and compare the renders side by side. Writing an object as code is the
  hardest thing this pipeline asks of a model. If Hydrogen's sofa is clearly worse, set
  `GEMINI_MODEL_OBJECT=gemini-4-carbon`; it is one setting. No public benchmark found measures
  Blender furniture code directly.

### Safety

Model-written code is run **only on boxd machines**, never on the laptop: `BLENDER_RUNNER=local`
must refuse `run_object.py`. Object machines need no internet (files arrive through the SDK), so
block it with `boxd.machines.setEgressAllow(id, ["none"])` after start. Every `exec` has a
timeout of 5 minutes.

## Part 4: room and house workers (small edits)

- `room-worker.ts`: nothing structural. Raise `OBJECT_CONCURRENCY` from 8 to 30 (each object has
  its own machine now). The identity check (`sameModels`), the turn check (`pickTurn`) and the
  box fallback stay. The room build and renders go through `blenderJob`, so they move to boxd
  with Part 1.
- `briefs.ts`: fitted kitchens and wardrobes (`BUILT_TO_MEASURE`) now get an object worker too,
  with `fit: "exact"` and the wall length in the brief. An L-shaped kitchen is one brief with
  both runs. Pictures (`PICTURE`) stay as flat planes with the photo crop.
- `house-worker.ts`: remove the fal spend lines. `join_house.py` and `web_copy.py` move to boxd
  with Part 1.
- Rooms run at the same time; the machine pool's cap is the only limit.

## Remove

Delete these, then search the repo for `fal` and `anyscene` (any case) until nothing is left
outside the old plan documents:

```
src/lib/fal/                       the whole folder
src/lib/models3d/mesh.ts
src/lib/models3d/reference.ts      keep cropViews (moved to crops.ts)
blender/prep_prop.py
blender/render_compare.py
scripts/fal-models.mts
THIRD_PARTY_NOTICES.md
```

Also: `checkReference` and `pickModel` in `critic.ts` (replaced by the object critic),
`NO_NEW_JOBS` and `spendTotal` uses in `object-worker.ts`, `house-worker.ts` and
`scripts/build-models.mts`, the no-credit mode, `FAL_KEY` and `FAL_KEY_BACKUP` from the README and
env examples. Add `BOXD_API_KEY` and `@boxd-sh/sdk` where the README lists requirements, and drop
"Needs Blender" for `build:models`.

## Milestones

| # | Deliverable | Done when |
|---|---|---|
| 1 | boxd runner | The camera self-test passes with Blender on boxd |
| 2 | Helper library | `test_gh_parts.py` runs clean on the snapshot |
| 3 | One object | `npm run build:models -- --tour listing-8218 --room main/r2 --item sofa-1` returns a sofa scoring 7 or more, within 5 runs |
| 4 | One room | `--room main/r2`: every item a model or an explained box; photo beside render for each gated photo |
| 5 | Removal | No fal or AnyScene code left; `npm run build:models` works with only `GEMINI_API_KEY` and `BOXD_API_KEY` |
| 6 | Whole house | listing-8218, all rooms at once; `house.glb` on the model page |

Milestones 1 to 3 are the proof. If the sofa at milestone 3 does not look like the sofa in the
photos, stop and improve the library and the prompts before going wider.

## Expected time and cost per house

Not yet measured end to end; built from the measurements above.

- One object: about 4 to 7 minutes (up to 5 runs of roughly 30 s of Gemini and 60 s of Blender).
- One room, one house: about the same as the slowest object plus a 2 to 3 minute room build,
  because everything runs side by side: roughly 10 to 15 minutes for a house.
- boxd: 30 machines for 15 minutes is 7.5 machine-hours at the very most, under €5; typically €1 to €2.
- Gemini: about 12 calls per object.

## Risks

- **Whether Gemini writes good enough furniture is untested.** This PC has no `GEMINI_API_KEY`
  in `.env.local` yet, so no object has been built this way. Milestone 3 is that test.
- **Code that fails to run.** Expect a share of first drafts to raise. The traceback goes back to
  the model; the helper library keeps most code off the raw API.
- **Soft and organic objects** will look simplified. `cushion`, `pillow` and `foliage` exist for this.
- **Positions are still only as good as the camera poses.** This plan does not change that.
- **Orphaned machines cost money.** The pool's `finally`, the SIGINT handler and
  `autoDestroyTimeout` cover it; `scripts/boxd-snapshot.mts --clean` should delete any machine
  whose name starts with the pool's prefix.
