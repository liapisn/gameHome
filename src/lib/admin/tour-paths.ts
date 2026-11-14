/**
 * Tour storage layout (bucket `tours`), written by the worker and read by the Tour tab:
 *   org/<org>/property/<property>/v<version>/tour.json
 *   org/<org>/property/<property>/v<version>/plan-<plan-id>.json
 * Tour photos reference uploads as `photos/<media-id>.webp`; see photoMediaId().
 */
export const TOURS_BUCKET = "tours";

export function tourFolder(orgId: string, propertyId: string, version: number) {
  return `org/${orgId}/property/${propertyId}/v${version}/`;
}

/** The media row a tour photo came from (the worker names exported photos after their media id). */
export function photoMediaId(src: string): string | null {
  const m = /^photos\/([0-9a-f-]{36})\.\w+$/i.exec(src);
  return m ? m[1] : null;
}

/** Shape of `tours.plan_paths`. */
export type PlanPaths = { planId: string; path: string }[];
