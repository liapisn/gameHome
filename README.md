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
- `/tour/<plan-id>`: any plan in `src/data/plans/`. Parsed fixture plans are dev-only and never published.

## Floor plan parser

Turns a floor plan image into 3D-ready geometry. Claude reads the drawing and returns room outlines in meters, scaled from the printed dimensions, plus door and window positions. Code then derives the walls from shared room edges and snaps each opening onto its wall.

```bash
npm run parse:plan -- fixtures/listing-15970/floorplans/02.jpg \
  --id listing-15970-upper --title "Marousi house · upper floor"
# open http://localhost:3000/tour/listing-15970-upper
```

- Credentials: `ANTHROPIC_API_KEY`, otherwise Vercel AI Gateway (`AI_GATEWAY_API_KEY`, or `VERCEL_OIDC_TOKEN` from `vercel env pull`).
- Output: `src/data/plans/<id>.json`, plus `<id>.raw.json` holding the model's raw answer. Rebuild from the raw answer without another API call using `--from-raw`.
- The script prints each room's printed vs built dimensions, so you can spot bad parses.
- `npx tsx scripts/selftest-build.mts` checks the geometry builder offline.

## Structure

```
docs/PRODUCT.md              product & technical spec
fixtures/                    test listings (images + labelled manifest); not served
scripts/                     parser CLI, builder self-test
src/lib/floorplan.ts         floor plan schema, geometry helpers, demo plan
src/lib/floorplan-parser/    Claude parsing (parse.ts), output schema, geometry builder
src/data/plans/              generated plans
src/components/tour/         3D viewer (dollhouse renderer, tour UI)
src/app/                     routes
```
