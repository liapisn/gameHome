/**
 * Plan space ↔ three.js world space for a stacked, multi-level tour.
 * Plan (x, y) on a level maps to world (x + offset.x, elevation + h, y + offset.y).
 */
import * as THREE from "three";
import type { Point } from "@/lib/floorplan";
import type { PhotoPose, TourLevel } from "./types";

export const DEG = Math.PI / 180;
export const EYE_HEIGHT = 1.6;

export function toWorld(level: Pick<TourLevel, "elevation" | "offset">, [x, y]: Point, h = 0): THREE.Vector3 {
  return new THREE.Vector3(x + level.offset[0], level.elevation + h, y + level.offset[1]);
}

export function toPlan(level: Pick<TourLevel, "elevation" | "offset">, v: THREE.Vector3): Point {
  return [v.x - level.offset[0], v.z - level.offset[1]];
}

/**
 * Plan yaw (0 = +x, 90 = +y) → camera rotation about world Y. A three camera looks down −Z,
 * so rotation.y = θ faces (−sin θ, −cos θ); solving for (cos ψ, sin ψ) gives θ = −(ψ + 90°).
 */
export const yawToRotationY = (yawDeg: number) => -(yawDeg * DEG + Math.PI / 2);
export const rotationYToYaw = (rotY: number) => (-rotY - Math.PI / 2) / DEG;

/** Vertical FOV (degrees) of a photo with horizontal FOV hfov and aspect = height / width. */
export const vfovOf = (hfovDeg: number, aspect: number) =>
  (2 * Math.atan(Math.tan((hfovDeg * DEG) / 2) * aspect)) / DEG;

/** A camera matching the photo, for projecting it back onto the geometry. */
export function photoCamera(level: TourLevel, pose: PhotoPose, aspect: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(vfovOf(pose.hfov, aspect), 1 / aspect, 0.05, 100);
  cam.position.copy(toWorld(level, [pose.x, pose.y], pose.height));
  cam.rotation.order = "YXZ";
  cam.rotation.set(pose.pitch * DEG, yawToRotationY(pose.yaw), 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}
