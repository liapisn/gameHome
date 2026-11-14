/**
 * Procedural canvas textures for staging: floors, rugs and generated wall art.
 * Browser-only (needs a canvas). Textures are cached per key and shared across meshes.
 */
import * as THREE from "three";

const cache = new Map<string, THREE.CanvasTexture>();

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function make(key: string, size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, repeat = true) {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  draw(canvas.getContext("2d")!, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  cache.set(key, tex);
  return tex;
}

export type FloorFinish = "wood" | "tile" | "terracotta" | "concrete";

/**
 * Light, near-white patterns meant to be tinted by the material color.
 * One texture tile spans `FLOOR_TILE_METERS`; floor UVs are plan meters.
 */
export const FLOOR_TILE_METERS = 2;

export function floorTexture(finish: FloorFinish) {
  const tex = make(`floor-${finish}`, 1024, (ctx, s) => {
    const r = rng(finish.length * 977);
    const px = s / FLOOR_TILE_METERS; // pixels per meter
    if (finish === "wood") {
      ctx.fillStyle = "#e8e2da";
      ctx.fillRect(0, 0, s, s);
      const plankW = 0.18 * px;
      for (let x = 0, col = 0; x < s; x += plankW, col++) {
        let y = -r() * 1.2 * px;
        while (y < s) {
          const len = (0.9 + r() * 1.1) * px;
          const shade = 222 + Math.floor(r() * 30);
          ctx.fillStyle = `rgb(${shade},${shade - 6},${shade - 14})`;
          ctx.fillRect(x, y, plankW, len);
          // Grain.
          ctx.strokeStyle = `rgba(120,90,60,${0.05 + r() * 0.06})`;
          ctx.lineWidth = 1;
          for (let g = 0; g < 6; g++) {
            const gx = x + r() * plankW;
            ctx.beginPath();
            ctx.moveTo(gx, y);
            ctx.bezierCurveTo(gx + (r() - 0.5) * 8, y + len * 0.33, gx + (r() - 0.5) * 8, y + len * 0.66, gx + (r() - 0.5) * 6, y + len);
            ctx.stroke();
          }
          ctx.fillStyle = "rgba(80,60,40,0.35)";
          ctx.fillRect(x, y, plankW, 1.5);
          y += len;
        }
        ctx.fillStyle = "rgba(80,60,40,0.3)";
        ctx.fillRect(x, 0, 1.5, s);
      }
    } else if (finish === "tile" || finish === "terracotta") {
      const tile = (finish === "tile" ? 0.5 : 0.33) * px;
      for (let x = 0; x < s; x += tile) {
        for (let y = 0; y < s; y += tile) {
          const shade = 236 + Math.floor(r() * 16);
          ctx.fillStyle = `rgb(${shade},${shade},${shade - 4})`;
          ctx.fillRect(x, y, tile, tile);
        }
      }
      ctx.strokeStyle = finish === "tile" ? "rgba(90,90,90,0.35)" : "rgba(90,60,40,0.4)";
      ctx.lineWidth = finish === "tile" ? 2 : 3;
      for (let i = 0; i <= s; i += tile) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, s);
        ctx.moveTo(0, i);
        ctx.lineTo(s, i);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = "#e9e9e6";
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 4000; i++) {
        ctx.fillStyle = `rgba(${r() > 0.5 ? "255,255,255" : "80,80,80"},${r() * 0.08})`;
        ctx.fillRect(r() * s, r() * s, 2 + r() * 6, 2 + r() * 6);
      }
    }
  });
  tex.repeat.set(1 / FLOOR_TILE_METERS, 1 / FLOOR_TILE_METERS);
  return tex;
}

const RUG_PALETTES = [
  ["#c8643b", "#efe4d2", "#2f4858", "#d9a441"],
  ["#5b7065", "#ece6da", "#b5835a", "#2e2a26"],
  ["#8c5e58", "#f1e9df", "#c9b79c", "#3c4f63"],
  ["#3d5a6c", "#efe7da", "#d98e5f", "#a6b49a"],
];

export function rugTexture(seed: number) {
  const variant = Math.floor(seed) % 4;
  return make(
    `rug-${variant}`,
    512,
    (ctx, s) => {
      const [a, bg, c, d] = RUG_PALETTES[variant];
      const r = rng(variant + 11);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = a;
      ctx.lineWidth = s * 0.035;
      ctx.strokeRect(s * 0.05, s * 0.05, s * 0.9, s * 0.9);
      ctx.lineWidth = s * 0.012;
      ctx.strokeStyle = c;
      ctx.strokeRect(s * 0.11, s * 0.11, s * 0.78, s * 0.78);
      if (variant % 2 === 0) {
        // Kilim-style diamonds.
        const n = 4;
        const step = (s * 0.7) / n;
        for (let i = 0; i < n; i++)
          for (let j = 0; j < n; j++) {
            const cx = s * 0.15 + step * (i + 0.5);
            const cy = s * 0.15 + step * (j + 0.5);
            ctx.fillStyle = (i + j) % 2 ? a : d;
            ctx.beginPath();
            ctx.moveTo(cx, cy - step * 0.4);
            ctx.lineTo(cx + step * 0.4, cy);
            ctx.lineTo(cx, cy + step * 0.4);
            ctx.lineTo(cx - step * 0.4, cy);
            ctx.closePath();
            ctx.fill();
          }
      } else {
        // Berber flecks with a few stripes.
        for (let i = 0; i < 2500; i++) {
          ctx.fillStyle = r() > 0.5 ? c : d;
          ctx.globalAlpha = 0.25;
          ctx.fillRect(s * 0.13 + r() * s * 0.74, s * 0.13 + r() * s * 0.74, 3, 3);
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = a;
        for (const y of [0.3, 0.5, 0.7]) ctx.fillRect(s * 0.13, s * y, s * 0.74, s * 0.02);
      }
    },
    false,
  );
}

const ART_PALETTES = [
  ["#f3ede2", "#c8643b", "#2f4858", "#e3b04b", "#86a69d"],
  ["#efe9e1", "#1f3a4d", "#d98e5f", "#a7c4c2", "#3c2f2f"],
  ["#f6f1e7", "#b23a48", "#f2a541", "#3a6ea5", "#2b2d42"],
  ["#ebe5d9", "#5b7065", "#c9a66b", "#8c5e58", "#1c1c1c"],
  ["#f1ece4", "#4a6fa5", "#e07a5f", "#81b29a", "#f2cc8f"],
];

/** A generated abstract painting: color fields, arcs and lines. */
export function artTexture(seed: number) {
  const key = Math.floor(seed) % 40;
  return make(
    `art-${key}`,
    512,
    (ctx, s) => {
      const r = rng(key * 7919 + 3);
      const pal = ART_PALETTES[key % ART_PALETTES.length];
      const pick = () => pal[1 + Math.floor(r() * (pal.length - 1))];
      ctx.fillStyle = pal[0];
      ctx.fillRect(0, 0, s, s);
      const style = key % 3;
      if (style === 0) {
        // Stacked color fields.
        let y = s * 0.08;
        while (y < s * 0.9) {
          const h = s * (0.15 + r() * 0.3);
          ctx.fillStyle = pick();
          ctx.globalAlpha = 0.85;
          ctx.fillRect(s * 0.1, y, s * 0.8, Math.min(h, s * 0.92 - y));
          y += h + s * 0.04;
        }
      } else if (style === 1) {
        // Cut-out shapes.
        for (let i = 0; i < 6; i++) {
          ctx.fillStyle = pick();
          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          if (r() > 0.5) ctx.arc(r() * s, r() * s, s * (0.08 + r() * 0.22), 0, Math.PI * 2);
          else {
            const x = r() * s;
            const y = r() * s;
            ctx.ellipse(x, y, s * (0.05 + r() * 0.2), s * (0.15 + r() * 0.25), r() * Math.PI, 0, Math.PI * 2);
          }
          ctx.fill();
        }
      } else {
        // Sun over horizon lines.
        ctx.fillStyle = pick();
        ctx.beginPath();
        ctx.arc(s * (0.3 + r() * 0.4), s * 0.4, s * 0.18, 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 5; i++) {
          ctx.fillStyle = pick();
          const y = s * (0.55 + i * 0.08);
          ctx.beginPath();
          ctx.moveTo(0, y);
          for (let x = 0; x <= s; x += s / 8) ctx.lineTo(x, y + Math.sin(x / s * Math.PI * 2 + i) * s * 0.03);
          ctx.lineTo(s, s);
          ctx.lineTo(0, s);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = pal[pal.length - 1];
      ctx.lineWidth = 3;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(r() * s, r() * s);
        ctx.quadraticCurveTo(r() * s, r() * s, r() * s, r() * s);
        ctx.stroke();
      }
    },
    false,
  );
}
