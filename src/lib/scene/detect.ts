/**
 * Stage 1: one model call per gated photo → the objects in it, as pixels.
 * The model names things and points at image positions; lift.ts turns those into metres.
 */
import { z } from "zod";
import { OPEN_PLAN, ROOM_TYPES, type Room, type RoomType } from "@/lib/floorplan";
import { generateStructured } from "@/lib/ai/structured";
import { normaliseLabel } from "./lift";
import { Detection, SCENE_KINDS } from "./types";

export const DetectAnswer = z.object({
  cameraRoom: z
    .enum([...ROOM_TYPES, "entry", "other"])
    .describe("Your own judgement of the kind of room the CAMERA STANDS IN (not rooms seen through openings)"),
  items: z.array(Detection),
});

/**
 * Does the model's room kind contradict the room the photo was placed in? Lenient: open-plan
 * kinds, entries (which plans file as hallways, kitchens or living rooms) and 'other' never do.
 */
export function roomKindConflict(placed: RoomType, seen: z.infer<typeof DetectAnswer>["cameraRoom"]): boolean {
  if (seen === placed || seen === "other" || seen === "entry") return false;
  return !OPEN_PLAN.some((g) => g.includes(placed) && g.includes(seen));
}

export const KIND_GUIDE = `Kinds (use the closest; 'generic' for anything else, with a precise label):
- kitchen: one straight run of base cabinets with worktop (an L-shaped kitchen is TWO kitchen items, one per wall). Tall built-in units next to it (oven tower, pantry) are 'generic' builtIn.
- fridge: fridge or fridge-freezer, freestanding or integrated tall unit
- diningTable, coffeeTable, desk, console (narrow hall/sofa table), sideboard (low cabinet/buffet), tvUnit
- sofa, armchair, bench, bed, nightstand, wardrobe (tall closet), bookshelf (with books), shelves (open shelving or display units)
- bathtub, shower, toilet, vanity (basin cabinet)
- rug, plant, floorLamp, pendant (hanging ceiling light), art (framed picture or mirror on a wall)
- generic: e.g. display cabinet, tall glass cabinet, wall cabinets (mount 'wall'), fireplace, radiator, washing machine, stool, chair.
Do not list individual dining chairs that belong to a table, small objects on surfaces, curtains, or ceiling fans.`;

const SYSTEM = `You annotate furniture and fixtures in real-estate photos so they can be rebuilt in 3D.

Coordinates: points are [y, x] and boxes are [ymin, xmin, ymax, xmax], all normalised to 0–1000
(top-left is [0, 0]). Be precise: the 3D positions are computed from your pixels with the known
camera, so a point 10 units off moves an object by many centimetres.

For every object that stands on or hangs in the room:
- box: tight around the visible part.
- floorPoints (floor items): where the object physically touches the floor — the bottom corners of
  its footprint that you can actually see (feet of a table or sofa, bottom corners of a cabinet's
  plinth or kickboard). Give 2–4 when visible, ordered left to right. Never guess hidden corners;
  never give points on the object's top or on the wall. For a rug, its visible corners.
  If the object's floor line is cut off by the edge of the photo (a sofa or bed whose base runs out
  of the frame), give only the floor points you can really see on the floor, or none. Never put a
  point on the image edge, on the object's top or on a cushion.
- topPoints: for one or two of the floorPoints, the point straight above it on the object's top
  edge (worktop edge, table top, sofa back, fridge top).
- faceCorners (wall/ceiling items): the visible corners of the front face.
- againstWall: true if its back touches a wall.
- color: dominant colour of the main surface as you see it in the photo (#rrggbb).
Include built-in fixtures (fitted kitchen runs, built-in wardrobes, bathroom fixtures, fireplaces).
Each physical object once. Skip objects less than ~20% visible.`;

export async function detectPhoto(opts: { photoJpeg: Buffer; room: Room; levelName: string }) {
  const res = await generateStructured({
    schema: DetectAnswer,
    system: `${SYSTEM}\n\n${KIND_GUIDE}`,
    parts: [
      {
        type: "text",
        text: `An automatic step placed this photo in the "${opts.room.name}" (${opts.room.type}) on ${opts.levelName}; that may be wrong, so judge cameraRoom from the photo alone. Allowed object kinds: ${SCENE_KINDS.join(", ")}.`,
      },
      { type: "image", data: opts.photoJpeg.toString("base64"), mediaType: "image/jpeg" },
    ],
  });
  return { items: res.data.items, cameraRoom: res.data.cameraRoom, model: res.model, usage: res.usage };
}

type Px = [number, number];
type Answer = Pick<z.infer<typeof DetectAnswer>, "cameraRoom" | "items">;

/** Parallel detect calls per photo; their answers are voted (voteDetections). 1 = a single call. */
export const detectVotes = () => Math.max(1, Number(process.env.DETECT_VOTES ?? 3) || 1);

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function iou(a: number[], b: number[]) {
  const iy = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ix = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const area = (r: number[]) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const u = area(a) + area(b) - inter;
  return u > 0 ? inter / u : 0;
}

/** Points of the base item, each the median of its partners (within `reach`) in the matched runs; no partner = dropped. */
function votePoints(base: Px[], others: Px[][], reach = 60): { points: Px[]; index: number[] } {
  const points: Px[] = [];
  const index: number[] = [];
  base.forEach((p, k) => {
    const partners = others
      .map((pts) => pts.map((q) => ({ q, d: Math.hypot(q[0] - p[0], q[1] - p[1]) })).filter((x) => x.d <= reach).sort((a, b) => a.d - b.d)[0]?.q)
      .filter((q): q is Px => !!q);
    if (!partners.length) return;
    const all = [p, ...partners];
    points.push([median(all.map((q) => q[0])), median(all.map((q) => q[1]))]);
    index.push(k);
  });
  return { points, index };
}

/**
 * Several detect answers for one photo → one. Items are matched across runs by kind (and a shared
 * label word for `generic`) with box IoU ≥ 0.4; an item seen in fewer than `minVotes` runs is dropped
 * (built-in fixtures need one). Boxes and points are medians, so one run's stray point is
 * outvoted. Other fields come from the run with the most items.
 */
export function voteDetections(runs: Answer[], minVotes = 2): Answer {
  if (runs.length <= 1) return runs[0] ?? { cameraRoom: "other", items: [] };
  const baseIdx = runs.reduce((best, r, i) => (r.items.length > runs[best].items.length ? i : best), 0);
  const base = runs[baseIdx];
  // Runs name one generic object differently ("cream ottoman", "cube ottoman"): a shared word is enough, the box overlap does the rest.
  const words = (l: string) => new Set(normaliseLabel(l).split(" ").filter((w) => w.length > 2));
  const shareWord = (a: string, b: string) => {
    const wb = words(b);
    return [...words(a)].some((w) => wb.has(w));
  };
  const same = (a: Detection, b: Detection) => a.kind === b.kind && (a.kind !== "generic" || shareWord(a.label, b.label));
  // Each other run: greedy best-IoU matching to the base items, each item used once.
  const matches: (Detection | undefined)[][] = base.items.map(() => []);
  runs.forEach((run, ri) => {
    if (ri === baseIdx) return;
    const pairs: { b: number; o: number; s: number }[] = [];
    base.items.forEach((bi, b) =>
      run.items.forEach((oi, o) => {
        if (!same(bi, oi)) return;
        const s = iou(bi.box, oi.box);
        if (s >= 0.4) pairs.push({ b, o, s });
      }),
    );
    pairs.sort((x, y) => y.s - x.s);
    const usedB = new Set<number>();
    const usedO = new Set<number>();
    for (const p of pairs) {
      if (usedB.has(p.b) || usedO.has(p.o)) continue;
      usedB.add(p.b);
      usedO.add(p.o);
      matches[p.b].push(run.items[p.o]);
    }
  });
  const items: Detection[] = [];
  base.items.forEach((bi, b) => {
    const m = matches[b].filter((x): x is Detection => !!x);
    if (m.length + 1 < minVotes && !bi.builtIn) return;
    if (!m.length) {
      items.push(bi);
      return;
    }
    const all = [bi, ...m];
    const box = [0, 1, 2, 3].map((k) => median(all.map((x) => x.box[k]))) as Detection["box"];
    const floor = votePoints(bi.floorPoints as Px[], m.map((x) => x.floorPoints as Px[]));
    const keepBaseFloor = !floor.points.length && bi.floorPoints.length > 0 && bi.mount === "floor";
    const floorPoints = keepBaseFloor ? bi.floorPoints : floor.points;
    const floorIndex = keepBaseFloor ? bi.floorPoints.map((_, k) => k) : floor.index;
    // topPoints refer to floor points by index: keep those whose floor point survived, renumbered.
    const tops = bi.topPoints
      .filter((t) => floorIndex.includes(t.floorIndex))
      .map((t) => {
        const partners = m.flatMap((x) => x.topPoints.map((u) => u.point as Px));
        const v = votePoints([t.point as Px], [partners]);
        return { floorIndex: floorIndex.indexOf(t.floorIndex), point: (v.points[0] ?? t.point) as Px };
      });
    const face = votePoints(bi.faceCorners as Px[], m.map((x) => x.faceCorners as Px[]));
    items.push({ ...bi, box, floorPoints, topPoints: tops, faceCorners: face.points.length ? face.points : bi.faceCorners });
  });
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.cameraRoom, (counts.get(r.cameraRoom) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const cameraRoom = runs.find((r) => counts.get(r.cameraRoom) === top)!.cameraRoom;
  return { cameraRoom, items };
}
