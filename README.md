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

## Structure

```
docs/PRODUCT.md              product & technical spec
src/lib/floorplan.ts         floor plan schema, geometry helpers, demo plan
src/components/tour/         3D viewer (dollhouse renderer, tour UI)
src/app/                     routes
```
