import type { FloorPlan } from "@/lib/floorplan";
import type { ResolvedTour, Tour } from "./types";

/** Inline each level's plan, applying the ceiling height measured from photos. Null if a plan is missing. */
export function resolveLevels(tour: Tour, plans: FloorPlan[]): ResolvedTour["levels"] | null {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const levels = tour.levels.map((l) => {
    const plan = byId.get(l.planId);
    return plan ? { ...l, plan: l.ceilingHeight ? { ...plan, ceilingHeight: l.ceilingHeight } : plan } : null;
  });
  return levels.every(Boolean) ? (levels as ResolvedTour["levels"]) : null;
}
