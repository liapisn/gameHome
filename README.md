# gameHome

Turn a floor plan, photos and videos of a house or apartment into a walkable 3D tour, to rent, sell or list it. Tours are backed by structured floor plan data and exposed over MCP, so AI agents can search and compare homes.

The product and technical spec is in [docs/PRODUCT.md](docs/PRODUCT.md).

## Stack

- Next.js (App Router) + TypeScript + Tailwind CSS, deployed on Vercel
- React Three Fiber / drei for the 3D viewer

## Develop

```bash
npm install
npm run dev
```

- `/`: landing page
- `/tour/demo`: 3D dollhouse demo built from the sample plan in `src/lib/floorplan.ts`
- `/tour/<tour-id>`: a photo tour from `src/data/tours/` (dev-only for fixture listings)
- `/tour/<plan-id>`: any plan in `src/data/plans/`. Parsed fixture plans are dev-only and never published.

## Model credentials

Vision calls go through `src/lib/ai/structured.ts`: Gemini when `GEMINI_API_KEY` is set (`GEMINI_MODEL` overrides `gemini-4-carbon`; the object workers use `GEMINI_MODEL_OBJECT`, default `gemini-4-hydrogen`), otherwise Claude via `ANTHROPIC_API_KEY` or Vercel AI Gateway (`AI_GATEWAY_API_KEY`, or `VERCEL_OIDC_TOKEN` from `vercel env pull`). Put keys in `.env.local`.

## Blender runs on boxd

Every Blender run (room builds, renders, model jobs) happens on a [boxd](https://boxd.sh) machine, never on this computer (`src/lib/boxd/runner.ts`). Needs `BOXD_API_KEY` in `.env.local`. Machines start from the `gh-blender-5-3` snapshot (Blender 5.3.0, 8 vCPU / 32 GB); `BOXD_MACHINES` caps how many run at once (default 30). `BLENDER_RUNNER=local` uses a local Blender 5.x (`BLENDER_PATH`) for the fixed scripts only.

```bash
npm run boxd:snapshot -- --replace   # rebuild the snapshot from scratch (new version, same name)
npm run boxd:snapshot -- --clean     # delete pool machines a crashed run left behind
```

## Admin: generating tours from uploads

Owners upload floor plans and photos in `/app`, then press **Generate** on the property's Generate tab. That queues a job and starts a durable workflow on Vercel (`src/workflows/build-tour.ts`): plans → photo placement in parallel batches → poses → stored tour → rooms furnished from their photos in parallel (`scenes.json`). Nothing has to run locally. Needs `SUPABASE_SERVICE_ROLE_KEY` and the model key on the deployment; `TOUR_FURNISH=0` skips furnishing.

To build on your own machine instead, set `TOUR_BUILDER=worker` on the deployment (jobs are then only queued) and run the worker:

```bash
vercel env pull          # Supabase keys (incl. service role) + model key into .env.local
npm run worker -- --furnish   # claims queued jobs; --once to process one and exit
```

Progress shows live on the Generate tab. The result opens in the Tour tab, which is a private preview behind login. Tours are versioned in the `tours` bucket. To load a local listing folder into a workspace as if it had been uploaded: `npx tsx --env-file=.env.local scripts/import-listing.mts <dir> --org "<workspace>" --title "<title>"`.

## Tour engine: floor plans + photos → walkable tour

```bash
npm run build:tour -- fixtures/listing-15970 --id listing-15970 --title "Marousi house"
# open http://localhost:3000/tour/listing-15970
```

1. **Plans.** Each level in the listing's `manifest.json` that has a floor plan is parsed (below), unless `src/data/plans/<id>-<level>.json` already exists. Levels are stacked and aligned on their stair wells.
2. **Photo placement.** For each photo, the model sees every level's drawing, its rooms, and a table of named landmarks (room corners and door/window jambs, e.g. "top-right corner of Kitchen"). It returns the level and room, the landmarks it can see with their image positions, a rough camera guess and the floor/wall colors. Places on no plan, like a garden or a second unit, are kept as unplaced photos.
3. **Pose solving** (`src/lib/tour/estimate-pose.ts`), using the image itself rather than the model's numbers:
   - **Vanishing points** (`vanishing.ts`): horizontal edges along the plan's two wall directions converge on the horizon. Fitting both gives the heading (modulo 90°, with the model's guess picking the branch), the exact field of view and the horizon row. Shifted or cropped photos often have the horizon off-centre.
   - **Edge alignment** (`edge-align.ts`): with orientation fixed, a grid search over position, lens height and ceiling height projects the room's outline (ceiling junctions, floor junctions, corners) into the photo and scores how well image edges run along it. Ceiling junctions carry the most weight because furniture rarely hides them. A fit is accepted when it clearly beats every pose more than 1 m away.
   - Fallbacks: the model's landmark picks solved with the vanishing-point orientation, then vanishing-point orientation at the model's position, then the model's guess. Fallback poses are flagged as approximate in the viewer.
   - Measured ceiling heights (median per level) replace the plan's default.
   - `npx tsx scripts/debug-edges.mts <tour-id> <out-dir>` draws each stored pose's room outline over its photo. Use it to check poses by eye.
4. **Viewer.** Dollhouse view per level, plus walk mode: drag to look, click the floor to move, WASD to walk. Photo hotspots fly you to each solved camera, where the real photo is projected onto the 3D room through an off-axis frustum that matches the photo's horizon. A backdrop sphere catches the photo wherever the model has no surface, such as doorways or plan gaps. From the photo's spot the room looks exactly like the photo, and the projection fades as you walk away.

- Placements are cached in `src/data/tours/<id>.placements.json`. Use `--from-cache` to place only new photos, or `--only 01,07` to redo specific ones.
- The manifest's per-photo labels are never sent to the model. They're only used to score the run, which prints level and room-type accuracy at the end.
- `npx tsx scripts/selftest-pose.mts` checks the landmark solver offline against synthetic cameras.
- Re-solving poses needs no model calls: `npm run build:tour -- … --from-cache` (set `POSE_LOG=1` for per-photo detail).
- Fixture photos are third-party. Resized copies live in `fixtures/<listing>/.derived/` (gitignored), and `/api/tour-media` serves them in dev only.

## Floor plan parser

Turns a floor plan image into 3D-ready geometry. A vision model reads the drawing and returns room outlines in meters, scaled from the printed dimensions, plus door and window positions. Code then derives the walls from shared room edges and snaps each opening onto its wall.

```bash
npm run parse:plan -- fixtures/listing-15970/floorplans/02.jpg \
  --id listing-15970-upper --title "Marousi house · upper floor"
# open http://localhost:3000/tour/listing-15970-upper
```

- Output: `src/data/plans/<id>.json`, plus `<id>.raw.json` holding the model's raw answer. Rebuild from the raw answer without another API call using `--from-raw`.
- The script prints each room's printed vs built dimensions, so you can spot bad parses.
- `npx tsx scripts/selftest-build.mts` checks the geometry builder offline.

## 3D export & Unreal renders (local)

```bash
npm run export:glb          # demo plan → exports/<plan-id>/<plan-id>.glb + .plan.json
npm run render:unreal       # export → Unreal 5 (Lumen) → exports/<plan-id>/walkthrough.mp4
BUILD_ONLY=1 npm run render:unreal   # build the level + sequence, keep the editor open
```

The `.glb` is world-space, in meters, with named meshes and materials (`floor__<type>__<room>`, `wall__…`, `glass__…`, `ceiling__…`; contract in `src/lib/dollhouse-geometry.ts`). `unreal/build_listing.py` imports it into the content-only project in `unreal/GameHomeRender/`. It assigns surface materials, lights the scene (sun, sky and one lamp per room), places one camera per room, builds a walkthrough sequence and renders it with Movie Render Queue. It needs UE 5.x from the Epic Games Launcher (`UE_ROOT` overrides the location) and `ffmpeg` for the MP4.

## Structure

```
docs/PRODUCT.md              product & technical spec
fixtures/                    test listings (images + labelled manifest); not served
scripts/                     parser + tour CLIs, self-tests, glb export, Unreal runner
src/lib/floorplan.ts         floor plan schema, geometry helpers, demo plan
src/lib/ai/                  provider-neutral structured vision calls (Gemini / Claude)
src/lib/floorplan-parser/    plan parsing (parse.ts), output schema, geometry builder
src/lib/tour/                tour types, landmark table, photo placement, pose solver, plan↔world space
src/data/plans/              generated plans
src/data/tours/              generated tours + cached photo placements
src/components/tour/         3D viewer (dollhouse, walk rig, photo projection, tour UI)
unreal/                      optional Unreal render project + script
src/app/                     routes
```
