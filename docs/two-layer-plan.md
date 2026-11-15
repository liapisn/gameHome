# Two-layer furniture build, faster measuring calls

Follows [boxd-models-plan.md](boxd-models-plan.md), which is built on `main`: Gemini writes Blender
code per object (`src/lib/models3d/code-worker.ts`), it runs on boxd (`src/lib/boxd/runner.ts`,
`blender/run_object.py`, `blender/gh_parts.py`), and a room worker places the results
(`room-worker.ts`). This plan changes two things:

1. **The measuring calls** (photo placement, detect, gate, check) move to `gemini-4-hydrogen` at
   low thinking, get a prompt fix and a guard for items cut off by the frame, and stop timing out
   on Vercel. Parts 1–3.
2. **The furniture build drops from three layers to two.** Today every object has its own worker
   with its own design sheet, critic and revise loop. After this change one **room agent** per room
   does all the thinking for its room. The per-object agent goes away. Part 4.

Keep the testing small: type check, two self-test cases, one room built end to end, one house.
Expected implementation time: about 2 hours.

## Why (benchmark, 2026-11-15)

Floor-point picking on photos 02, 06, 07, 08, 10, 14 of listing-15970, 3 runs per model, points
lifted with the stored pose. Plausibility only, no ground truth.

| model (thinking) | median s | p90 s | floor points inside room | items > 4 m span | wobble |
|---|---|---|---|---|---|
| gemini-4-hydrogen (low) | 11.9 | 18 | 78% | 1 | 6 cm |
| gemini-4-argon (low) | 9.1 | 13.5 | 84% | 1 | 7 cm |
| gemini-4-carbon (low) | 8.1 | 49.9 | 78% | 0 | 5 cm |
| gemini-4-hydrogen (medium) | 24.6 | 36.5 | 76% | 0 | 10 cm |
| gemini-3.1-pro-preview | 6.8 | 44 | 71% | 12 | — |
| gemini-4-carbon (high), one probe | ~100 | — | — | — | — |

- The Gemini 4 models at low thinking are equally accurate at pointing. Medium thinking costs 2×
  the time for nothing. Carbon has a slow tail (p90 ~50 s) that can blow a Vercel step.
- Today `structured.ts` defaults to `gemini-4-carbon` at `"high"`, with a 12-minute call timeout
  and 4 retries. That is why the workflow steps time out.
- Every model fails the same way on items whose base is cut off by the photo frame (sofa, bed):
  points on the item's top or the image edge, giving spans of several metres.
- Writing Blender code and judging renders were **not** benchmarked. That is why the room agent
  starts on Carbon and the model is a setting (see "Models" below).

## Models

| Calls | Model | Thinking | Where set |
|---|---|---|---|
| Place photo, detect, gate, check, look, same-models, turn check | `gemini-4-hydrogen` | low | default in `structured.ts` (`GEMINI_MODEL`) |
| Floor plan reading, room estimate | `gemini-4-hydrogen` | medium (as today) | their own `effort` |
| Room agent: design sheet, room critique | `gemini-4-carbon` | low | `GEMINI_MODEL_ROOM` |
| Item code (one call per item, in parallel) | `gemini-4-hydrogen` | low | `GEMINI_MODEL_OBJECT` (exists) |
| House review | `gemini-4-carbon` | low | `GEMINI_MODEL_ROOM` |

`gemini-4-argon` is an equally good choice for the measuring calls: switch with `GEMINI_MODEL` if
its price or rate limits are better. Nothing in code should name a model except the defaults in
`structured.ts`.

## Part 1: model defaults and timeouts (`src/lib/ai/structured.ts`)

1. `GEMINI_DEFAULT_MODEL = "gemini-4-hydrogen"`.
2. Default thinking: `req.effort ?? "low"` (today `"high"`). Same change in the Claude branch is
   not needed (no Anthropic key), but keep it consistent: `"low"` there too.
3. Add `export const geminiRoomModel = () => process.env.GEMINI_MODEL_ROOM ?? "gemini-4-carbon";`
   beside `geminiObjectModel`.
4. Add `"gemini-4-argon": 65536` to `MAX_OUTPUT` only if the models API says so; otherwise leave
   the 32768 fallback.
5. Timeout: `CALL_TIMEOUT_MS` default from 12 minutes to **90 s**, retries from 4 attempts to
   **3**. The model build sets `GEMINI_CALL_TIMEOUT_MS=360000` itself (Part 4, step 8), since a
   room agent call with many images can take minutes and runs with no time limit.
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
2. **Span too long:** after the filter, if the longest distance between two kept points is over
   **4 m** (over **6 m** for `kind === "kitchen"`, the only legitimate long run), return
   `{ candidate: null, …, reason: "floor points span too far" }`.
3. The check loop needs no change: its corrections go back through `liftDetection`, so a
   correction that fails the guard is rejected like any other bad lift and the round is not kept.
4. Name both thresholds as constants beside `NEAR_CONTACT` (`MAX_SPAN = 4`, `MAX_SPAN_KITCHEN = 6`,
   `FLOOR_TOLERANCE = 0.15`).

**Test:** two cases in `scripts/selftest-lift.mts`: a sofa whose two floor points lift 5 m apart is
dropped; a kitchen whose points span 5 m is kept.

## Part 4: two-layer furniture build

### Shape

```
House agent  (house-worker.ts, unchanged apart from the review model)
  └─ Room agent, one per room, all rooms in parallel   (new: room-agent.ts, called by room-worker.ts)
       1. room design sheet           Carbon, 1 call, sees every room photo and every item
       2. item code                   Hydrogen, 1 call per item, all in parallel, returns code only
       3. build + render each item    boxd, run_object.py, all in parallel (unchanged)
       4. room critique               Carbon, 1 call, every item's renders beside its photo crop
       5. rewrite only failed items   Hydrogen, parallel, with the critic's fixes  → back to 3
     then placement, orientation, final build, room.glb   (room-worker.ts, unchanged)
```

The item code calls are not agents: they make no decisions, never see renders except when asked to
fix, and never loop on their own. The room agent decides what each item looks like, judges every
render and says what to fix. **Positions and sizes stay as measured** (the room agent never moves
furniture); a size the photos contradict is still reported as `sizeConflict`.

### 1. Room design sheet (`room-agent.ts`)

One Carbon call (`model: geminiRoomModel()`), cached as `rooms/<key>/agent/design.json`.

Input:
- Every gated photo of the room (at most 6, 1024 px).
- For each brief (from `briefs.ts`, unchanged: grouping copies, chairs, built-to-measure runs): its
  `assetId`, label, kind, measured size, colour/material hints, wall/fit notes, and its first crop.

Output schema:

```ts
const RoomDesign = z.object({
  style: z.string().describe("The room's style in two sentences: era, finishes, how lived-in"),
  palette: z.array(z.object({ name: z.string(), color: z.string() })).describe("Recurring colours, hex"),
  materials: z.array(z.string()).describe("Recurring materials, e.g. 'light oak veneer', 'matte black steel'"),
  items: z.array(z.object({
    assetId: z.string(),
    summary: z.string(),
    front: z.string(),
    matches: z.array(z.string()).describe("assetIds this item must match in style or finish (chairs ↔ table)"),
    parts: DesignSheet.shape.parts,          // reuse the existing part schema from code-worker.ts
    assumptions: z.array(z.string()),
  })),
});
```

An item missing from the answer gets a design sheet from the existing per-object `designSheet`
call (Hydrogen) as a fallback, so one omission never leaves an item unbuilt.

Large rooms: if there are more than 12 briefs, split the items into chunks of 12 and make one call
per chunk with the same photos and the `style/palette/materials` from the first chunk passed in, so
the sheet stays consistent and output stays within limits.

### 2. Item code (reuse `writeCode` in `code-worker.ts`)

- `writeCode(brief, sheet, crops, prev?)` stays. Add a `room` argument: the room's
  `style/palette/materials` and the design sheets of the items in `matches`, as one text part
  placed before the item's own design sheet ("Match these: …").
- Model: `geminiObjectModel()` (Hydrogen), effort **low** (today `"high"`).
- All items in parallel through the existing `pool` (`OBJECT_CONCURRENCY`, default 30).
- Cache unchanged: `objects/<assetId>/r<n>/code.py`.

### 3. Build + render (unchanged)

Move the "build and render on boxd" block of `runCodeObjectWorker` (the `result.json` part with
its one retry on a fresh machine) into an exported function:

```ts
export async function buildItem(brief: ObjectBrief, dir: string): Promise<RunResult | { infraError: string }>
```

Same job as today (`run_object.py`, `res: 640`, `samples: 24`, plants free in `w, d`). A run whose
code fails (`ok: false`) is fed straight back to step 2 with the error as feedback, as today; it
does not wait for the critique.

### 4. Room critique (`room-agent.ts`)

One Carbon call per round, cached as `rooms/<key>/agent/round-<n>.json`.

Input: the room style; then per item that built: label, measured size, its best photo crop (768
px), its `front` and `clay` renders (512 px). At most 2 renders per item to keep the call small.

Output: one entry per `assetId` with the existing `Critique` fields (`score`, `missing`, `facing`,
`sizeWrong`, `realSize`, `fixes`, `summary`) plus
`consistency: z.string().describe("What doesn't match the rest of the room; empty if fine")`,
whose text is appended to that item's feedback.

The prompt is the existing per-object critic prompt, plus: "Judge them together: pieces in
`matches` must share finish and style." Pass rule unchanged: `score >= 7`, nothing missing,
`facing`.

### 5. Rounds

- `ROOM_ROUNDS` (env, default **3**): round 1 builds every item; later rounds rewrite and rebuild
  only items that failed the critique or failed to build, using `writeCode(..., prev)` with
  `feedbackFrom(critique)`.
- Each item keeps its best-scoring run, exactly as `runCodeObjectWorker` picks today. The
  size-conflict rules stay as they are (two `sizeWrong` flags, or one plus a "Size off" error, stop
  that item and report the conflict).
- An infrastructure failure (`infraError`) stops that item for this build without caching, as
  today.
- Output: `Map<assetId, ObjectResult>`, same shape as now, written to
  `objects/<assetId>/result.json`.

### 6. Wiring (`room-worker.ts`)

Replace step 2 (the `pool(..., runObjectWorker)` block, lines ~135–141) with:

```ts
const results = await runRoomAgent({ briefs: [...briefs.values()], photos: photos.map((p) => path.resolve(tour.mediaRoot, p.src)), dir, log });
```

Everything after it (placements, pictures, orientation, final build, report) stays.

### 7. Remove

- `designSheet` stays only as the fallback in step 1; the per-object `critique` and the
  `runCodeObjectWorker` loop are deleted (their pieces live in `room-agent.ts` and `buildItem`).
- `src/lib/models3d/object-worker.ts`: move `fitFor` to `briefs.ts`, delete the file, update the
  import in `room-worker.ts`.
- `OBJECT_MAX_RUNS` env (replaced by `ROOM_ROUNDS`).
- Update the header comments of `room-worker.ts`, `code-worker.ts` and `critic.ts` to point here.

### 8. Where it runs

The furniture build runs only from the CLI / worker (`npm run build:models`), never inside the
Vercel workflow: one room takes minutes. `scripts/build-models.mts` sets
`process.env.GEMINI_CALL_TIMEOUT_MS ??= "360000"` before anything else. The Vercel workflow
(`src/workflows/build-tour.ts`) is unchanged and keeps `rounds: 1` in `furnishRoom`; with Part 1 its
calls are ~12 s each, so 4 parallel calls per step fit. If a step still times out, split the step
rather than raise timeouts; `TOUR_BUILDER=worker` with `npm run worker` is the fallback.

## Testing (keep it to this)

1. `npx tsc --noEmit` and `npm run lint`.
2. `npx tsx scripts/selftest-lift.mts` with the two new cases.
3. One room end to end:
   `npm run build:models -- --tour listing-8218 --room main/r2`
   Look at the `compare-*.jpg` images and `room.json`. Done when it finishes, most items are
   models (not boxes), and the sofa, coffee table and TV unit look like the photos.
4. One whole house: `npm run build:models -- --tour listing-8218` (4 furnished rooms). Done when
   `house.glb` is written and the house review runs.

Optional, only if the furniture looks weak: rerun step 3 with `GEMINI_MODEL_OBJECT=gemini-4-carbon`
(delete `objects/*/r*` for that room first) and compare by eye. If Carbon is clearly better, make it
the default for item code.

## Risks

- **Carbon's slow tail** makes a room agent call take a minute or more. Fine off Vercel; the
  timeout in Part 4 step 8 covers it.
- **The room critique misses items** when there are many: the answer must list every `assetId`; an
  item without a verdict counts as passed with no score (keeps its run, logged).
- **The 0.15 m tolerance drops good items** near doorways or on plan errors. If a room loses
  furniture it had before, raise `FLOOR_TOLERANCE` to 0.25; don't remove the guard.
- **Hydrogen at low thinking writes weaker code.** The optional Carbon rerun above is the check;
  `GEMINI_MODEL_OBJECT` switches it without code changes.
