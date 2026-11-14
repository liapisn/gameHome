/**
 * Heading, field of view and horizon from horizontal vanishing points ("Manhattan world").
 *
 * Walls in our plans run along the plan's x and y axes. In a level, vertical-corrected photo,
 * horizontal edges along each axis (floor/ceiling lines, worktops, door heads, skirting, shelves)
 * converge to a vanishing point on the horizon row. The two axis directions are 90° apart, which
 * pins the heading (modulo 90°) and the horizontal field of view. The horizon row is fitted too:
 * listing photos are often shifted or cropped after vertical correction, so it isn't always the
 * middle of the frame.
 *
 * Each hypothesis is scored by how well every edge pixel's direction points at one of its two
 * vanishing points (angle error in the image, robust kernel). This stays well-conditioned when a
 * vanishing point is near infinity, unlike voting on horizon crossings.
 */

export interface ManhattanFit {
  /** Heading modulo 90°, in plan convention (0 = +x, 90 = +y): the true yaw is this + k·90°. */
  yawMod90: number;
  hfov: number;
  /** False when the camera faces a wall squarely: one VP sits at infinity and fov is unobservable. */
  hfovReliable: boolean;
  /** Horizon row, 0 = top, 1 = bottom (0.5 for an unshifted level photo). */
  horizon: number;
  /** Fraction of edge weight explained by the two vanishing points. */
  support: number;
}

const DEG = Math.PI / 180;

interface Edge {
  x: number;
  y: number;
  /** Unit edge direction (perpendicular to the gradient). */
  dx: number;
  dy: number;
  w: number;
}

/** Strong, non-vertical edge pixels with their directions, in pixel coordinates. */
export function edgeSamples(gray: Uint8Array, width: number, height: number, max = 20000): Edge[] {
  const at = (x: number, y: number) => gray[y * width + x];
  const all: Edge[] = [];
  const tanVert = Math.tan(20 * DEG);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      // Scharr: better orientation accuracy than Sobel.
      const gx =
        3 * (at(x + 1, y - 1) - at(x - 1, y - 1)) + 10 * (at(x + 1, y) - at(x - 1, y)) + 3 * (at(x + 1, y + 1) - at(x - 1, y + 1));
      const gy =
        3 * (at(x - 1, y + 1) - at(x - 1, y - 1)) + 10 * (at(x, y + 1) - at(x, y - 1)) + 3 * (at(x + 1, y + 1) - at(x + 1, y - 1));
      const m = Math.hypot(gx, gy);
      if (m < 150) continue;
      const dx = -gy / m;
      const dy = gx / m;
      if (Math.abs(dx) < tanVert * Math.abs(dy)) continue; // near-vertical edges belong to the vertical VP
      all.push({ x, y, dx, dy, w: m });
    }
  }
  // Keep the strongest, then thin evenly so dense textures don't dominate.
  all.sort((a, b) => b.w - a.w);
  const kept = all.slice(0, max * 3);
  const step = Math.max(1, Math.floor(kept.length / max));
  return kept.filter((_, i) => i % step === 0).map((e) => ({ ...e, w: Math.min(e.w, 1500) }));
}

/** Score of a hypothesis: robust agreement of edge directions with the two VPs. */
function score(edges: Edge[], width: number, height: number, yaw: number, hfov: number, horizon: number) {
  const cx = (width - 1) / 2;
  const yh = horizon * (height - 1);
  const t = Math.tan((hfov / 2) * DEG);
  // VP x positions for plan axes 0° and 90° (relative bearings −yaw and 90° − yaw, mod 180).
  const vps = [-yaw, 90 - yaw].map((rel) => {
    const r = ((((rel + 90) % 180) + 180) % 180) - 90;
    const k = Math.tan(r * DEG) / t; // 2u − 1
    return Math.abs(k) > 1e4 ? null : cx + k * cx;
  });
  const sigma2 = 2 * (1.5 * DEG) ** 2;
  let s = 0;
  let total = 0;
  for (const e of edges) {
    let best = 0;
    for (const xv of vps) {
      let ex: number;
      let ey: number;
      if (xv === null) {
        ex = 1;
        ey = 0;
      } else {
        ex = xv - e.x;
        ey = yh - e.y;
        const n = Math.hypot(ex, ey);
        if (n < 1) continue;
        ex /= n;
        ey /= n;
      }
      // Angle between undirected lines.
      const sin = Math.abs(ex * e.dy - ey * e.dx);
      const a = Math.asin(Math.min(1, sin));
      const k = Math.exp(-(a * a) / sigma2);
      if (k > best) best = k;
    }
    s += e.w * best;
    total += e.w;
  }
  return s / total;
}

export function fitManhattan(gray: Uint8Array, width: number, height: number): ManhattanFit | null {
  const edges = edgeSamples(gray, width, height);
  if (edges.length < 200) return null;
  const coarse = edges.filter((_, i) => i % 4 === 0);

  // Coarse grid, then local refinement on all samples.
  let best = { s: -1, yaw: 0, hfov: 90, horizon: 0.5 };
  for (let yaw = 0; yaw < 90; yaw += 2) {
    for (let hfov = 55; hfov <= 120; hfov += 5) {
      for (let horizon = 0.38; horizon <= 0.621; horizon += 0.03) {
        const s = score(coarse, width, height, yaw, hfov, horizon);
        if (s > best.s) best = { s, yaw, hfov, horizon };
      }
    }
  }
  for (const [dYaw, dFov, dH] of [
    [1, 2.5, 0.015],
    [0.5, 1, 0.006],
    [0.2, 0.4, 0.0025],
  ]) {
    const c = { ...best };
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        for (let k = -2; k <= 2; k++) {
          const yaw = (((c.yaw + i * dYaw) % 90) + 90) % 90;
          const hfov = Math.min(125, Math.max(50, c.hfov + j * dFov));
          const horizon = c.horizon + k * dH;
          const s = score(edges, width, height, yaw, hfov, horizon);
          if (s > best.s) best = { s, yaw, hfov, horizon };
        }
      }
    }
  }
  const nearAxis = Math.min(best.yaw % 90, 90 - (best.yaw % 90));
  return {
    yawMod90: best.yaw,
    hfov: best.hfov,
    // Facing a wall squarely leaves fov unobservable; a fit pinned far outside the range of
    // real-estate lenses (~65–115°) is the same failure showing up differently.
    hfovReliable: nearAxis > 8 && best.hfov >= 65 && best.hfov <= 115,
    horizon: best.horizon,
    support: best.s,
  };
}

/** Pick the yaw branch (yawMod90 + k·90°) closest to a rough heading. */
export function resolveYaw(fit: ManhattanFit, roughYaw: number): number {
  let best = fit.yawMod90;
  let bestErr = Infinity;
  for (let k = 0; k < 4; k++) {
    const y = fit.yawMod90 + 90 * k;
    const err = Math.abs(((y - roughYaw + 540) % 360) - 180);
    if (err < bestErr) [best, bestErr] = [y, err];
  }
  return best;
}
