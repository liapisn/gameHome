# Admin app: plan

The owner-facing side of gameHome. Owners create a property, upload floor plans and photos, and press **Generate**. The engine (built separately) turns those uploads into a 3D tour, and the owner previews and publishes it.

Branch: `worktree-admin` (git worktree at `.claude/worktrees/admin`). It stays separate from the engine work happening in the main checkout.

---

## 1. Scope

**In the MVP**
- Sign in (email magic link or password)
- Organizations: an owner's account plus teammates, ready for property managers from day one
- Properties: create, edit, list, delete
- Floors: one or more per property, each with an optional floor plan image
- Photos: drag-and-drop multi-upload, progress, reorder, delete, optional floor/room hint
- **Generate**: queue a job, see live progress and errors, re-run
- Preview the generated tour inside the admin
- Publish or unpublish, with a public share link

**Later**
- Listings (rent, sale, short-stay; price; availability). The MCP server reads these.
- Video uploads (blocked by Supabase's 50 MB free-tier file limit, see §6)
- Team invites UI, roles beyond owner/editor
- Moving the worker onto hosted infrastructure (Vercel Workflow or a GPU host)

---

## 2. Architecture

```
Browser (admin UI, Next.js /app)
   │  1. auth + CRUD ──────────────▶ Supabase Postgres (RLS by organization)
   │  2. resize photos in browser,
   │     upload directly ───────────▶ Supabase Storage (private bucket)
   │  3. "Generate" ─▶ insert job ──▶ jobs table
   │  4. live status ◀── Realtime ── jobs table
   ▼
Worker (Node script: `npm run worker`, any machine)
   claims a queued job → downloads the property's floors and photos into a temp folder
   → calls the engine → uploads tour JSON to Storage → marks the job succeeded or failed
```

Why each piece:
- **Direct-to-Storage uploads.** Vercel functions cap request bodies at 4.5 MB. The browser gets a signed upload URL from Supabase and sends the file straight there.
- **Resizing in the browser.** Photos are cut to ~2560 px WebP, about 0.3–0.5 MB instead of ~1 MB+. That's enough for the engine and keeps us inside the 1 GB free storage tier.
- **A separate worker, not a Vercel function.** A tour build makes dozens of model calls and image operations and runs for minutes. A plain worker polling the `jobs` table is the simplest thing that works, runs locally today, and can move to Vercel Workflow or a GPU host later without UI changes.
- **Realtime on `jobs`** gives live progress without polling code.

### Engine contract (for the engine agent)

The worker hands the engine the same folder shape `fixtures/listing-*/` already uses, so the engine needs no Supabase knowledge:

```
<tmp>/<property-id>/
  manifest.json      { levels: [{ id, name, floorplan }], photos: [{ file, hint? }] }
  floorplans/<level-id>.webp
  photos/<n>.webp
```

**Ask for the engine:** expose `buildTour(folder, { id, title, onProgress }) → Tour` as a library function next to the `build:tour` CLI. `onProgress({ step, done, total })` feeds the progress bar. The worker uploads the resulting `Tour` and its plan JSON.

---

## 3. Data model (Supabase Postgres)

All tables have RLS: a user sees rows only for organizations they belong to.

| Table | Key columns |
|---|---|
| `organizations` | id, name, created_at |
| `memberships` | org_id, user_id, role (`owner` \| `editor`) |
| `properties` | id, org_id, title, kind (`apartment` \| `house` \| …), address, city, area, lat, lng, total_area_m2, bedrooms, bathrooms, description, status (`draft` \| `processing` \| `ready` \| `published`), created_by, timestamps |
| `levels` | id, property_id, name, sort, ceiling_height, floorplan_path |
| `media` | id, property_id, level_id?, kind (`photo` \| `floorplan`), storage_path, width, height, bytes, hint?, sort, created_at |
| `jobs` | id, property_id, type (`build_tour`), status (`queued` \| `running` \| `succeeded` \| `failed`), progress jsonb, error, attempts, worker_id, started_at, finished_at |
| `tours` | id, property_id, version, tour_path, plan_paths jsonb, is_current, created_at |

- A new signup gets a personal organization automatically, via a database trigger.
- The worker claims a job atomically (`update … where status = 'queued' … for update skip locked`), so two workers never take the same job.
- Migrations live in `supabase/migrations/` and are applied with the Supabase CLI.

**Storage:** a private bucket `property-media` with paths `org/<org>/property/<id>/{floorplans,photos}/…`, read through signed URLs. Tours go in a private bucket `tours`. A published tour is served through our own route, which checks `status = 'published'`.

---

## 4. Screens

| Route | What it does |
|---|---|
| `/login` | Magic link or password |
| `/app` | Property list: cards with thumbnail, status badge, last job |
| `/app/properties/new` | Basics: title, type, address, size, bedrooms and bathrooms, number of floors |
| `/app/properties/[id]` | Tabs ↓ |
| · Details | Edit basics |
| · Floor plans | One upload slot per floor; add or rename floors |
| · Photos | Drop zone, upload progress, grid with reorder and delete, optional floor/room hint per photo |
| · Generate | Checklist (≥1 floor plan, ≥N photos), Generate button, live progress, error log, history of runs |
| · Tour | Embedded 3D viewer of the current version, Publish toggle, share link |

Auth is enforced in `proxy.ts` (Next 16's replacement for middleware) and again in server code; RLS is the final guard.

---

## 5. Build phases

| Phase | Deliverable | Done when |
|---|---|---|
| **0. Setup** | Supabase project, env vars, `@supabase/ssr` clients, migrations folder | `npm run dev` connects; tables exist |
| **1. Auth + properties** | Login, personal org trigger, property CRUD, `/app` list | Sign up → create property → see it listed; another user can't see it |
| **2. Uploads** | Floors, floor plan and photo upload with in-browser resize, reorder, delete | Upload all 50 images of listing-15970 through the UI and see them in Storage |
| **3. Generate** | `jobs` + worker + Realtime progress; tours table; preview tab | Press Generate → worker runs the engine → preview shows the tour. Uses a stub engine until the engine's `buildTour` lands. |
| **4. Publish** | Public `/tour/[id]` reads published tours from Supabase | Share link opens without login; unpublishing returns 404 |

**Status (2026-11-14):** Phases 0 and 1 are done. The full schema (all tables, RLS, buckets, the job-claim function, Realtime on `jobs`) is applied to Supabase in Frankfurt. Login, the property list, create (with floors), edit and delete are tested end to end, including a check that a second user can't see the first user's property.

Phases 1–2 don't depend on the engine. Phase 3 starts with a stub `buildTour` that returns the demo tour, so the whole flow works end to end before the real engine is wired in.

---

## 6. Supabase free tier: limits that matter

| Limit | Effect on us |
|---|---|
| 1 GB storage | ~2,000+ resized photos. Fine for development; upgrade before real customers. |
| 50 MB per file | Fine for photos and floor plans. Rules out phone walkthrough videos (often 100 MB+), so video waits for a paid plan or another store. |
| 500 MB database | Plenty; geometry and tours are stored as files, not rows |
| Project pauses after 1 week without activity | Free projects need occasional use or a manual restore |

---

## 7. Decisions (2026-11-14)

1. **Supabase account:** provisioned through the Vercel Marketplace; env vars sync to the `gamehome` Vercel project.
2. **Sign-in:** magic link only.
3. **Worker:** runs on the developer's machine (`npm run worker`) for now; jobs wait in the queue until it's running.
