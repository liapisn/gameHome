import type { FloorPlan, Point } from "@/lib/floorplan";

/**
 * Where a photo was taken from, in its level's plan space.
 * Plan space: meters, x → right, y → down (as drawn). yaw is measured from +x towards +y,
 * so on the drawing 0° faces right and 90° faces down. pitch > 0 looks up.
 */
export interface PhotoPose {
  x: number;
  y: number;
  yaw: number;
  pitch: number;
  /** Horizontal field of view of the (rectilinear) photo. */
  hfov: number;
  /** Lens height above the floor. */
  height: number;
}

export interface PoseFit {
  /** How the pose was obtained. */
  method: "resection" | "model-estimate";
  landmarks: number;
  /** RMS angular error of the landmarks under the final pose, degrees. */
  rmsDeg: number | null;
}

export interface TourPhoto {
  id: string;
  /** Path relative to the listing folder, e.g. "photos/01.jpg". */
  src: string;
  width: number;
  height: number;
  caption: string;
  levelId: string | null;
  roomId: string | null;
  /** Free-text location when the photo is not inside a mapped room (garden, second unit…). */
  location: string;
  confidence: "high" | "medium" | "low";
  pose: PhotoPose | null;
  fit: PoseFit | null;
}

export interface RoomLook {
  floor: string;
  walls: string;
}

export interface TourLevel {
  id: string;
  name: string;
  planId: string;
  /** Height of this level's floor above the lowest level. */
  elevation: number;
  /** Translation applied to this plan so levels line up (plan space, meters). */
  offset: Point;
}

export interface Tour {
  id: string;
  title: string;
  /** Folder (relative to the repo) that photo `src` paths are resolved against. */
  mediaRoot: string;
  levels: TourLevel[];
  photos: TourPhoto[];
  /** Observed finishes per room, keyed `${levelId}/${roomId}`. */
  looks: Record<string, RoomLook>;
  builtAt: string;
  model: string;
}

/** A tour with its plans inlined: what the viewer receives. */
export interface ResolvedTour extends Omit<Tour, "levels"> {
  levels: (TourLevel & { plan: FloorPlan })[];
  /** URL prefix photos are served from, or null when media can't be served (e.g. production). */
  mediaUrl: string | null;
}

export const roomKey = (levelId: string, roomId: string) => `${levelId}/${roomId}`;
