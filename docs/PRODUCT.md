# gameHome: Product & Technical Spec

> Working name. Turn a floor plan plus photos and videos of a home into a 3D tour that buyers, renters, guests and AI agents can walk through.

---

## 1. Problem

People decide on a home from photos. Photos hide the layout: how big the bedroom really is, where the kitchen is relative to the living room, whether the balcony gets light. Owners lose time on viewings that go nowhere, and renters and buyers lose time visiting places that were never a fit.

3D tours exist, but they need dedicated cameras or scanning hardware and an operator. Small owners don't bother, and large portfolios find them expensive to roll out across hundreds of units.

## 2. Solution

An owner uploads three things:

1. **The floor plan**: a scan, photo, PDF or architect's drawing.
2. **Photos**: whatever they have, phone-quality is fine.
3. **Videos**: an optional walkthrough of each room on a phone.

gameHome produces:

- **A structured floor plan**: rooms, walls, doors and windows with real dimensions and areas, stored as data rather than as a picture.
- **A 3D model of the home** that people can view as a dollhouse or walk through room by room.
- **A shareable tour link and embed code** for their own site, listing portals and short-stay platforms.
- **Machine-readable listing data** exposed over MCP, so AI agents can search and compare homes.

## 3. Users

| Segment | Need | What they get |
|---|---|---|
| **Small owners** (1–5 units) | Rent or sell faster, fewer wasted viewings | Self-serve upload and a tour in minutes, no hardware |
| **Large owners / property managers** | Tours for hundreds of units, consistent quality | Bulk upload, team accounts, API, white-label embeds |
| **Real estate agents / brokers** | Better listings, remote viewings | Branded tours, lead capture, viewing scheduling |
| **Short-stay hosts** (Airbnb, Booking) | Guests understand the space before booking | Tour link in the listing description, embed on their direct-booking site |
| **End users** (renters, buyers, guests) | Understand a home quickly | Walkable tour, accurate room sizes, side-by-side comparison |
| **AI agents** (Claude, etc.) | Find a home that fits structured criteria | MCP server with search, floor plan data and tour links |

## 4. Core user flows

### 4.1 Owner: create a tour
1. Sign up and create a **Property** (address, type, size).
2. Upload the **floor plan**. The system detects walls, rooms, doors and windows, and shows the result for review.
3. **Confirm the scale.** It is read from the dimensions printed on the plan, or the owner marks one known length, e.g. "this wall is 4.2 m".
4. Upload **photos and videos**. They are auto-assigned to rooms; the owner can fix assignments with drag and drop.
5. Processing runs in the background, and the owner is notified when the tour is ready.
6. Review, edit room names and hotspots, then **publish**.
7. Create a **Listing**: rent, sale or short-stay, with price, availability and amenities. Share the link or embed it.

### 4.2 End user: explore a home
- Open the tour link, which defaults to dollhouse view.
- Click a room to fly into it, or switch to walk mode.
- See room names and areas in m², and measure distances.
- See photo hotspots pinned where each photo was taken.
- Contact the owner or request a viewing.

### 4.3 Agent: find a home over MCP
> "Claude, find me a place to rent in central Athens, 50–90 m², budget up to €900/month, at least one bedroom over 12 m², balcony."

1. The agent calls `search_listings` with structured filters.
2. For the top results it calls `get_floor_plan` to check per-room constraints that portals can't filter on.
3. It returns a shortlist with reasons, the tour link for each, and optionally books viewings with `request_viewing`.

---

## 5. The 3D pipeline

The hard part is reconstruction. We deliver in **tiers**: each one is useful on its own, and each builds on the one before.

### Tier 1: Plan Tour (MVP)
- **Input:** floor plan only, plus optional photos.
- **Process:**
  1. **Floor plan parsing.** A vision model (Claude) and a wall-segmentation model turn the image into vector geometry: walls as line segments with thickness, openings (doors and windows), and room polygons with labels.
  2. **Scale detection.** Read dimension annotations with OCR and the vision model, falling back to the owner's reference length.
  3. **Extrude** walls to a default ceiling height (2.7 m, editable) and generate floors and openings.
  4. **Place photos** as hotspots in their assigned rooms.
- **Output:** a 3D dollhouse with accurate geometry and areas, in a few seconds.

### Tier 2: Panorama Tour
- **Input:** 360° photos, or a slow video spin per room stitched into a panorama.
- **Process:** stitch the panoramas, then anchor each one to a position on the floor plan.
- **Output:** a walk-through tour that jumps between panorama points, with a dollhouse overview.

### Tier 3: Photoreal Tour
- **Input:** a walkthrough video per room, or dense photos.
- **Process:**
  1. Extract frames, then estimate camera poses with structure-from-motion (COLMAP or GLOMAP, or a learned alternative such as MASt3R or VGGT).
  2. Train a **3D Gaussian Splatting** reconstruction for each room or for the whole home.
  3. **Register** the reconstruction to the Tier 1 floor plan geometry for scale, orientation and room boundaries.
  4. Compress to a streamable format (`.spz` or SOG).
- **Output:** a photoreal, freely walkable model that is still tied to the structured floor plan.

### Privacy step (all tiers)
- Automatically blur faces, family photos, documents and screens in uploaded media before anything is published.
- Never publish the exact address until the owner chooses to; show an approximate area by default.

---

## 6. Architecture

```
┌──────────────┐   direct upload    ┌────────────────────┐
│  Next.js app │ ─────────────────▶ │ Vercel Blob        │
│  (Vercel)    │                    │ (private: media,   │
│              │                    │  plans, models)    │
│  - Owner UI  │                    └─────────┬──────────┘
│  - Viewer    │                              │
│  - API       │   start job                  ▼
│  - /api/mcp  │ ────────────▶ ┌──────────────────────────┐
└──────┬───────┘               │ Vercel Workflow (durable)│
       │                       │  parse plan → extrude →  │
       │                       │  dispatch GPU → register │
       ▼                       └──────────┬───────────────┘
┌──────────────┐                          │ webhook / poll
│ Postgres     │                          ▼
│ + PostGIS    │               ┌──────────────────────────┐
│ (Marketplace)│ ◀──────────── │ GPU workers (external:   │
└──────────────┘   results     │ Modal / RunPod / etc.)   │
                               │ SfM, Gaussian Splatting  │
                               └──────────────────────────┘
```

### Stack
| Concern | Choice | Notes |
|---|---|---|
| App | **Next.js (App Router)** on Vercel | One app for marketing, dashboard, viewer, API and MCP |
| 3D viewer | **React Three Fiber + drei**, **Spark** for Gaussian splats | Runs in the browser, no plugins, works on mobile |
| Uploads | **Vercel Blob**, private, client direct upload | Bypasses the 4.5 MB function body limit; videos can be large |
| Database | **Postgres via Vercel Marketplace** (e.g. Neon) with **PostGIS** | Geo search ("central Athens"), JSONB for floor plan geometry |
| ORM | Drizzle | |
| Auth | Via Vercel Marketplace (Clerk or similar) | Orgs and teams for property managers |
| Orchestration | **Vercel Workflow** | Durable multi-step jobs that wait on GPU callbacks |
| AI / vision | **Claude via Vercel AI Gateway** | Floor plan understanding, room labeling, photo-to-room assignment, listing copy |
| GPU compute | External GPU provider | Vercel has no GPUs; SfM and splat training run there |
| MCP | `mcp-handler` route at `/api/mcp` | Streamable HTTP; public read tools, authenticated write tools |
| Maps | MapLibre + OSM tiles | |

---

## 7. Data model (first draft)

```
Organization ─┬─ Member (user, role)
              └─ Property
                   ├─ address, geo (PostGIS point), type, total_area_m2, floor, year_built
                   ├─ FloorPlan
                   │    ├─ source_asset_id
                   │    ├─ scale (m per px), ceiling_height_m
                   │    └─ geometry (JSONB): walls[], openings[], rooms[]
                   │         room = { id, name, type, polygon[], area_m2, has_window }
                   ├─ Asset (photo | video | panorama | plan) → blob url, room_id?, pose?
                   ├─ Tour
                   │    ├─ tier (plan | panorama | photoreal), status
                   │    ├─ model_url (glb / spz), scenes[], hotspots[]
                   │    └─ published, embed_settings
                   ├─ Listing
                   │    ├─ kind (rent | sale | short_stay)
                   │    ├─ price, currency, period, deposit, available_from
                   │    ├─ bedrooms, bathrooms, amenities[], energy_class
                   │    └─ status (draft | live | archived)
                   └─ ProcessingJob (step, status, logs, gpu_job_id)

ViewingRequest (listing_id, contact, slots[], source: web | mcp)
```

The **floor plan geometry is the core asset**. Agents can reason over it ("bedroom ≥ 12 m² with a window"), and listing portals can't offer that today.

---

## 8. MCP server

Endpoint: `https://<domain>/api/mcp`

### Read tools (public, rate-limited)
| Tool | Input | Returns |
|---|---|---|
| `search_listings` | `location` (text or lat/lng + radius), `kind`, `area_m2 {min,max}`, `price {min,max}`, `bedrooms`, `amenities[]`, `available_from`, `sort` | Ranked listings: id, title, price, area, neighborhood, thumbnail, `tour_url` |
| `get_listing` | `listing_id` | Full listing details and amenities |
| `get_floor_plan` | `listing_id` | Rooms with type, area and windows, adjacency graph, total area, plan image URL |
| `compare_listings` | `listing_ids[]` | Side-by-side table of price/m², room sizes and amenities |
| `get_tour_link` | `listing_id`, `room?` | Deep link into the 3D tour, optionally opened in a specific room |
| `get_neighborhood` | `listing_id` | Nearby transit, schools and shops (POIs) |

### Write tools (OAuth, on behalf of the user)
| Tool | Purpose |
|---|---|
| `request_viewing` | Send a viewing request with preferred time slots |
| `save_listing` | Add to the user's shortlist |
| `contact_owner` | Message the owner through the platform without exposing contact details |

### Owner-side tools (later)
`create_property`, `upload_assets`, `get_tour_status`, `update_listing`, so owners can manage their portfolio from their own agent.

---

## 9. Distribution & integrations
- **Shareable tour links** with Open Graph previews for WhatsApp, Messenger and email.
- **Embeds** (`<iframe>`) for owner and agency websites.
- **Airbnb and Booking** don't allow iframes in listings. Hosts paste the tour link into the description, and hosts with direct-booking sites embed it there.
- **Greek market portals** (Spitogatos, xe.gr, etc.): listing export and syndication is to be investigated.
- **Public API** for large owners to bulk-create properties and pull tour links into their own systems.

---

## 10. Roadmap

### Phase 0: Foundation (now)
- [x] Repo, Next.js app, Vercel deployment
- [x] Product spec (this document)
- [x] Demo 3D dollhouse viewer from hard-coded floor plan geometry

### Phase 1: Plan Tour MVP
- [ ] Auth and organizations
- [ ] Property CRUD and Blob uploads
- [ ] Floor plan parsing (Claude vision → geometry JSON) with a correction editor
- [ ] Extruded 3D dollhouse viewer with room labels and areas
- [ ] Photo upload and assignment to rooms as hotspots
- [ ] Public tour page and share link

### Phase 2: Listings & discovery
- [ ] Listings (rent, sale, short-stay) and public search with map
- [ ] **MCP server v1**: read tools
- [ ] Viewing requests

### Phase 3: Immersive tours
- [ ] Panorama tours (Tier 2)
- [ ] Walk mode in the viewer
- [ ] GPU pipeline with Gaussian Splatting (Tier 3)
- [ ] Privacy blurring

### Phase 4: Scale
- [ ] Bulk upload and API for large owners
- [ ] Teams, roles and white-label embeds
- [ ] MCP write tools and owner-side tools
- [ ] Analytics: tour views, time per room, leads

---

## 11. Business model (to validate)
- **Free:** one property, Plan Tour, gameHome branding.
- **Pro (small owners and agents):** per-property or monthly; panorama and photoreal tiers, no branding.
- **Business (large owners):** per-unit volume pricing, API, white-label, SLA.
- **Discovery side:** free for end users and agents. Possible later revenue from featured listings or qualified leads.

## 12. Open questions
- How accurate does automatic floor plan parsing need to be before owners trust it? What correction UX do we need?
- Which GPU provider do we use, and what does a Tier 3 tour cost to produce?
- Do we hold listings ourselves (a marketplace), or only provide tours that others' listings link to? This decides how valuable the MCP search is.
- Do we launch in Greece/Athens first? That affects language (EL/EN), portals and payments.
- What are the GDPR rules for media taken inside private homes, especially with tenants living there?
