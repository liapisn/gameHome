import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { FloorPlan } from "@/lib/floorplan";
import { getPlan } from "@/lib/plans";
import type { ResolvedTour, Tour } from "@/lib/tour/types";

const TOURS_DIR = path.join(process.cwd(), "src/data/tours");
const isDev = process.env.NODE_ENV !== "production";

/**
 * Tours built from third-party fixtures stay dev-only, like their plans: their media is
 * never served in production (see the media route), and the tours themselves aren't listed.
 */
export function listTourIds(): string[] {
  if (!isDev || !fs.existsSync(TOURS_DIR)) return [];
  return fs
    .readdirSync(TOURS_DIR)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".placements.json"))
    .map((f) => f.replace(/\.json$/, ""));
}

export function getTour(id: string): Tour | null {
  if (!listTourIds().includes(id)) return null;
  return JSON.parse(fs.readFileSync(path.join(TOURS_DIR, `${id}.json`), "utf8")) as Tour;
}

/** Tour with plans inlined, or a single-level tour without photos for a bare plan id. */
export function resolveTour(id: string): ResolvedTour | null {
  const tour = getTour(id);
  if (tour) {
    const levels = tour.levels.map((l) => ({ ...l, plan: getPlan(l.planId) }));
    if (levels.some((l) => !l.plan)) return null;
    return {
      ...tour,
      levels: levels as ResolvedTour["levels"],
      mediaUrl: isDev ? `/api/tour-media/${tour.id}` : null,
    };
  }
  const plan = getPlan(id);
  return plan ? planAsTour(plan) : null;
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
