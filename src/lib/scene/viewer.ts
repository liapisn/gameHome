/**
 * Scenes → what the viewer draws: per-room furniture keyed by roomKey, with only the fields the
 * renderer reads (detections, sources and confidence stay out of the page payload).
 */
import type { Furnishing } from "@/lib/tour/furnish";
import { roomKey } from "@/lib/tour/types";
import type { RoomScene } from "./types";

export function sceneFurniture(scenes: Iterable<RoomScene>): Record<string, Furnishing[]> | undefined {
  const out: Record<string, Furnishing[]> = {};
  for (const scene of scenes) {
    out[roomKey(scene.levelId, scene.roomId)] = scene.items.map(
      ({ id, kind, x, y, rot, w, d, h, elevation, seed, uppers, chairs, ceiling, color, label }) =>
        ({ id, kind, x, y, rot, w, d, h, elevation, seed, uppers, chairs, ceiling, color, label }) as Furnishing,
    );
  }
  return Object.keys(out).length ? out : undefined;
}
