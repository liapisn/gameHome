/**
 * A furnished room's items → object briefs: which items get a generated model, which share one
 * (copies of one product, the chairs of a dining table), and which are built to measure instead.
 */
import fs from "node:fs";
import path from "node:path";
import { KIND_SIZE } from "@/lib/scene/lift";
import type { ItemView, PhotoDetection, RoomScene, SceneItem, SceneKind } from "@/lib/scene/types";
import type { Tour } from "@/lib/tour/types";
import type { ObjectBrief, ObjectView } from "./types";
import { slug } from "./util";

/**
 * Built to measure: fitted kitchens and wardrobes must meet their walls exactly. They get an object
 * worker like everything else, with `fit: "exact"` and the wall run's length in the brief, so the
 * code builds the run to size (an L-shaped kitchen is one brief with both runs).
 */
export const BUILT_TO_MEASURE = new Set<string>(["kitchen", "wardrobe"]);
export const builtToMeasure = (i: { kind: string }) => BUILT_TO_MEASURE.has(i.kind);
/** Flat on a wall: a framed plane textured with the photo crop, no 3D generation. */
export const PICTURE = new Set<string>(["art"]);

/** Where an item is in each photo: stored on the item, or read back from the scene build's detections. */
export function itemViews(item: SceneItem, detections: PhotoDetection[] | null): ItemView[] {
  if (item.views?.length) return item.views;
  if (!detections) return [];
  return item.detections.flatMap((id) => {
    const d = detections.find((x) => x.id === id);
    return d ? [{ photoId: d.photoId, detectionId: d.id, box: d.box }] : [];
  });
}

export function loadDetections(tourId: string, levelId: string, roomId: string): PhotoDetection[] | null {
  const f = path.resolve("exports", tourId, `${levelId}-${roomId}`, "detections.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as PhotoDetection[]) : null;
}

export function objectViews(tour: Tour, views: ItemView[]): ObjectView[] {
  return views.flatMap((v) => {
    const p = tour.photos.find((x) => x.id === v.photoId);
    return p ? [{ photoId: v.photoId, photoFile: path.resolve(tour.mediaRoot, p.src), box: v.box }] : [];
  });
}

/** Item size in the brief's terms (w along the front, d front to back, h height; wall-hung: the item's own height). */
export const itemSize = (i: SceneItem) => ({ w: i.w, d: i.d, h: i.h });

export function briefForItem(tour: Tour, item: SceneItem, views: ItemView[], workRoot: string, assetId = slug(item.id)): ObjectBrief {
  const label = item.label && item.label !== item.kind ? item.label : String(item.kind);
  return {
    assetId,
    label: item.kind === "diningTable" ? `${label} (the table only, without chairs)` : label,
    kind: item.kind as SceneKind,
    views: objectViews(tour, views),
    size: itemSize(item),
    color: item.color,
    material: item.material,
    workDir: path.join(workRoot, assetId),
    ...(builtToMeasure(item)
      ? {
          fit: "exact" as const,
          wall: { length: item.w, notes: `Fitted ${item.kind} along one wall, ${item.w.toFixed(2)} m long, ${item.h.toFixed(2)} m tall, ${item.d.toFixed(2)} m deep: no visible back or outer sides where it meets walls.` },
        }
      : {}),
  };
}

/** The chair model for a dining table's chairs: drawn from the table's photos, one chair only. */
export function chairBrief(tour: Tour, table: SceneItem, views: ItemView[], workRoot: string): ObjectBrief {
  const [w, d, h] = [0.45, 0.5, 0.9];
  const assetId = `${slug(table.id)}-chair`;
  return {
    assetId,
    label: "dining chair",
    kind: "generic",
    views: objectViews(tour, views),
    size: { w, d, h },
    note: "one of the chairs at the dining table in these photos, a single chair on its own",
    workDir: path.join(workRoot, assetId),
  };
}

/**
 * Where a dining table's chairs stand, in the table's own frame as the viewer draws them
 * (src/components/tour/Furnishings.tsx): pairs along both long sides, plus the ends if there are
 * chairs left. Returns plan positions and the chair's rotation (facing the table).
 */
export function chairPlacements(t: SceneItem): { x: number; y: number; rot: number }[] {
  const n = t.chairs ?? 4;
  const perSide = Math.min(3, Math.max(1, Math.floor(n / 2)));
  const local: { x: number; z: number; rot: number }[] = [];
  for (let i = 0; i < perSide; i++) {
    const x = (i - (perSide - 1) / 2) * (t.w / perSide);
    local.push({ x, z: t.d / 2 + 0.2, rot: Math.PI }, { x, z: -t.d / 2 - 0.2, rot: 0 });
  }
  if (n - perSide * 2 >= 2) local.push({ x: t.w / 2 + 0.25, z: 0, rot: -Math.PI / 2 }, { x: -t.w / 2 - 0.25, z: 0, rot: Math.PI / 2 });
  // Table frame: local x along w, local z (front) along d; plan rotation by t.rot (three.js about Y).
  const c = Math.cos(t.rot);
  const s = Math.sin(t.rot);
  return local.map((p) => ({ x: t.x + p.x * c + p.z * s, y: t.y - p.x * s + p.z * c, rot: t.rot + p.rot }));
}

/** Typical size for an item that comes from rules (no photo): its kind's typical size. */
export const typicalSize = (kind: string) => {
  const [w, d, h] = KIND_SIZE[kind as SceneKind] ?? KIND_SIZE.generic;
  return { w, d, h };
};

export type { RoomScene };
