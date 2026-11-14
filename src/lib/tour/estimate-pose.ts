/**
 * Photo pose, combining image geometry with the vision model's placement. Strategies, most
 * precise first:
 *   1. "edges"      vanishing points fix heading + fov + horizon; position, lens height and
 *                   ceiling height are searched by aligning the room outline with image edges.
 *   2. "resection"  the model's own landmark picks, solved with VP heading/fov held fixed
 *                   (or free, without VPs).
 *   3. "vanishing"  VP heading/fov/horizon with the model's position.
 *   4. "model-estimate"  the model's guess as-is.
 */
import type { FloorPlan } from "@/lib/floorplan";
import { edgeAlign, gradientField, resizeGray } from "./edge-align";
import type { PlanFeature } from "./features";
import type { Placement } from "./place-photo";
import { solvePose } from "./solve-pose";
import type { PhotoPose, PoseFit } from "./types";
import { fitManhattan, type ManhattanFit, resolveYaw } from "./vanishing";

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface PoseOutcome {
  pose: PhotoPose;
  fit: PoseFit;
  manhattan: ManhattanFit | null;
  /** Whether the pose is precise enough to project the photo without an "approximate" flag. */
  precise: boolean;
}

const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const MIN_SUPPORT = 0.08;
const EDGE_MIN_SCORE = 50;
const EDGE_MIN_MARGIN = 1.08;

export function estimatePose(
  image: GrayImage,
  placement: Placement,
  plan: FloorPlan,
  features: Map<string, PlanFeature>,
): PoseOutcome | null {
  const est = placement.estimate;
  if (!est) return null;
  const room = plan.rooms.find((r) => r.id === placement.roomId);
  const aspect = image.height / image.width;
  const initial = { x: est.x, y: est.y, yaw: est.yawDeg, hfov: est.hfovDeg, height: est.cameraHeight };

  const mf = fitManhattan(image.data, image.width, image.height);
  const vp = mf && mf.support >= MIN_SUPPORT ? mf : null;
  const horizon = vp?.horizon ?? 0.5;
  const round = (p: { x: number; y: number; yaw: number; hfov: number; height: number }): PhotoPose => ({
    x: +p.x.toFixed(2),
    y: +p.y.toFixed(2),
    yaw: +(((p.yaw % 360) + 360) % 360).toFixed(1),
    pitch: 0,
    hfov: +p.hfov.toFixed(1),
    height: +p.height.toFixed(2),
    horizon: +horizon.toFixed(3),
  });

  // 1. Vanishing points + edge alignment of the room outline.
  if (vp && room) {
    // Try the 90° branches near the model's heading; the model is rarely more than ~45° off.
    let yaws = [0, 90, 180, 270].map((k) => vp.yawMod90 + k).filter((y) => angleDiff(y, initial.yaw) <= 60);
    if (!yaws.length) yaws = [resolveYaw(vp, initial.yaw)];
    const small = resizeGray(image.data, image.width, image.height, 480);
    const fit = edgeAlign(
      gradientField(small.data, small.width, small.height, 3),
      gradientField(small.data, small.width, small.height, 1.2),
      room,
      yaws,
      // Facing a wall squarely, the VPs can't measure fov: start from the model's estimate.
      vp.hfovReliable ? vp.hfov : initial.hfov,
      vp.horizon,
    );
    // Accept a clear winner: enough outline evidence, and distinctly better than any pose > 1 m away.
    if (fit && fit.score >= EDGE_MIN_SCORE && (fit.runnerUp === null || fit.score >= EDGE_MIN_MARGIN * fit.runnerUp)) {
      return {
        pose: round(fit),
        fit: {
          method: "edges",
          landmarks: 0,
          rmsDeg: null,
          score: +fit.score.toFixed(0),
          margin: fit.runnerUp === null ? null : +(fit.score / Math.max(1, fit.runnerUp)).toFixed(2),
          ceiling: +fit.ceiling.toFixed(2),
        },
        manhattan: mf,
        precise: true,
      };
    }
  }

  // 2. The model's landmark picks, with orientation pinned by vanishing points when available.
  const landmarks = placement.landmarks
    .filter((lm) => features.has(lm.featureId) && lm.u >= 0 && lm.u <= 1)
    .map((lm) => ({
      point: features.get(lm.featureId)!.point,
      u: lm.u,
      v: lm.v != null && lm.v > horizon && lm.v <= 1 ? lm.v : null,
    }));
  const spread = landmarks.length ? Math.max(...landmarks.map((l) => l.u)) - Math.min(...landmarks.map((l) => l.u)) : 0;
  const prior = vp ? { ...initial, yaw: resolveYaw(vp, initial.yaw), hfov: vp.hfovReliable ? vp.hfov : initial.hfov } : initial;
  if (landmarks.length >= 3 && spread >= 0.2) {
    const s = solvePose(landmarks, prior, {
      polygon: room?.polygon,
      aspect,
      horizon,
      prior: vp ? { pos: 1.5, yaw: 1, hfov: vp.hfovReliable ? 2 : 12, height: 0.15 } : { pos: 1.5, yaw: 25, hfov: 12, height: 0.15 },
      hfovRange: [55, 120],
    });
    // Reject fits that only "work" by leaving the room's plausible envelope.
    const moved = Math.hypot(s.x - initial.x, s.y - initial.y);
    if (s.rmsDeg <= (vp ? 1.5 : 2.5) && moved <= 2.5 && s.height >= 0.9 && s.height <= 1.8) {
      return {
        pose: round(s),
        fit: { method: "resection", landmarks: landmarks.length, rmsDeg: +s.rmsDeg.toFixed(2) },
        manhattan: mf,
        precise: !!vp,
      };
    }
  }

  // 3./4. Orientation from vanishing points if we have them, position from the model.
  return {
    pose: round(prior),
    fit: { method: vp ? "vanishing" : "model-estimate", landmarks: landmarks.length, rmsDeg: null },
    manhattan: mf,
    precise: false,
  };
}
