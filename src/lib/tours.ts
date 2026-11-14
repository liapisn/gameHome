import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { FloorPlan } from "@/lib/floorplan";
import { INTERNAL_FIXTURE_TOURS } from "@/lib/internal-fixtures";
import { getPlan } from "@/lib/plans";
import { resolveLevels } from "@/lib/tour/resolve";
import type { RoomScene } from "@/lib/scene/types";
import { sceneFurniture } from "@/lib/scene/viewer";
import type { Furnishing } from "@/lib/tour/furnish";
import type { ResolvedTour, Tour } from "@/lib/tour/types";

const TOURS_DIR = path.join(process.cwd(), "src/data/tours");
const SCENES_DIR = path.join(process.cwd(), "src/data/scenes");
const isDev = process.env.NODE_ENV !== "production";

/**
 * Tours built from third-party fixtures stay dev-only, like their plans: their media is
 * never served in production (see the media route), and the tours themselves aren't listed.
 * A protected preview can opt specific ones in (lib/internal-fixtures).
 */
export function listTourIds(): string[] {
  if (!fs.existsSync(TOURS_DIR)) return [];
  return fs
    .readdirSync(TOURS_DIR)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".placements.json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter((id) => isDev || INTERNAL_FIXTURE_TOURS.has(id));
}

/** Whether a tour's photos may be served by the media route. */
export const canServeMedia = (tourId: string) => isDev || INTERNAL_FIXTURE_TOURS.has(tourId);

export function getTour(id: string): Tour | null {
  if (!listTourIds().includes(id)) return null;
  return JSON.parse(fs.readFileSync(path.join(TOURS_DIR, `${id}.json`), "utf8")) as Tour;
}

/** Tour with plans inlined, or a single-level tour without photos for a bare plan id. */
export function resolveTour(id: string): ResolvedTour | null {
  const tour = getTour(id);
  if (tour) {
    const levels = resolveLevels(tour, tour.levels.flatMap((l) => getPlan(l.planId) ?? []));
    if (!levels) return null;
    return {
      ...tour,
      levels,
      mediaUrl: canServeMedia(tour.id) ? `/api/tour-media/${tour.id}` : null,
      scenes: getScenes(tour.id),
    };
  }
  const plan = getPlan(id);
  return plan ? planAsTour(plan) : null;
}

/** Rooms furnished from photos (npm run build:scene), keyed by roomKey. Only the viewer's fields are kept. */
export function getScenes(tourId: string): Record<string, Furnishing[]> | undefined {
  const dir = path.join(SCENES_DIR, tourId);
  if (!fs.existsSync(dir)) return undefined;
  return sceneFurniture(
    fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RoomScene),
  );
}

function planAsTour(plan: FloorPlan): ResolvedTour {
  return {
    id: plan.id,
    title: plan.title,
    mediaRoot: "",
    levels: [{ id: "main", name: "Floor plan", planId: plan.id, elevation: 0, offset: [0, 0], plan }],
    photos: [],
    looks: {},
    builtAt: plan.source?.parsedAt ?? "",
    model: plan.source?.model ?? "",
    mediaUrl: null,
  };
}

/** Absolute path of a derived media file for a tour, or null if it doesn't resolve safely. */
export function tourMediaPath(tourId: string, segments: string[]): string | null {
  const tour = getTour(tourId);
  if (!tour) return null;
  const [kind, ...rest] = segments;
  if (kind !== "view" && kind !== "thumb") return null;
  const root = path.resolve(process.cwd(), tour.mediaRoot, ".derived", kind);
  const file = path.resolve(root, ...rest);
  if (!file.startsWith(root + path.sep) || !tour.photos.some((p) => p.src === rest.join("/"))) return null;
  return fs.existsSync(file) ? file : null;
}

/** The original photo behind a derived path, for deployments without the (gitignored) .derived copies. */
export function tourOriginalPath(tourId: string, segments: string[]): string | null {
  const tour = getTour(tourId);
  if (!tour) return null;
  const [kind, ...rest] = segments;
  if (kind !== "view" && kind !== "thumb") return null;
  const src = rest.join("/");
  if (!tour.photos.some((p) => p.src === src)) return null;
  // Only the files next.config.ts traces explicitly are deployed; keep this from tracing the whole project.
  const file = path.resolve(/*turbopackIgnore: true*/ process.cwd(), tour.mediaRoot, src);
  return fs.existsSync(file) ? file : null;
}
