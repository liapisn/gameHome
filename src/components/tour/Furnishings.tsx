import { memo, useMemo } from "react";
import * as THREE from "three";
import type { Furnishing } from "@/lib/tour/furnish";
import { artTexture, rugTexture } from "./textures";

/*
 * Low-poly furniture built from three.js primitives. Each item is drawn in its local frame:
 * origin at the footprint center on the floor, width along x, back at -z, front facing +z.
 */

const materials = new Map<string, THREE.MeshStandardMaterial>();
function mat(color: string, roughness = 0.8, metalness = 0, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  const key = `${color}|${roughness}|${metalness}|${JSON.stringify(extra)}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
    materials.set(key, m);
  }
  return m;
}

function seeded(seed: number) {
  let s = Math.max(1, Math.floor(seed) % 2147483647);
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const box = new THREE.BoxGeometry(1, 1, 1);
const cyl = new THREE.CylinderGeometry(1, 1, 1, 24);
const sphere = new THREE.IcosahedronGeometry(1, 1);
const noRaycast = () => null;

type V3 = [number, number, number];

/** Box by size, positioned by its center. */
function B({ p, s, m, shadow = true }: { p: V3; s: V3; m: THREE.Material; shadow?: boolean }) {
  return <mesh geometry={box} material={m} position={p} scale={s} castShadow={shadow} receiveShadow raycast={noRaycast} />;
}
/** Vertical cylinder by radius (top, bottom via scale) and height, positioned by its center. */
function C({ p, r, h, m, rTop }: { p: V3; r: number; h: number; m: THREE.Material; rTop?: number }) {
  if (rTop != null) {
    return (
      <mesh position={p} material={m} castShadow receiveShadow raycast={noRaycast}>
        <cylinderGeometry args={[rTop, r, h, 24]} />
      </mesh>
    );
  }
  return <mesh geometry={cyl} material={m} position={p} scale={[r, h, r]} castShadow receiveShadow raycast={noRaycast} />;
}
function Ball({ p, r, m }: { p: V3; r: number | V3; m: THREE.Material }) {
  return <mesh geometry={sphere} material={m} position={p} scale={r} castShadow raycast={noRaycast} />;
}

const FABRICS = ["#8a9a8c", "#c9b8a3", "#5f6f7f", "#b7795c", "#d8d0c4", "#6f5f72"];
const WOODS = ["#a07a55", "#c49a6c", "#7a5a40", "#d6b48c"];
const pickOf = <T,>(arr: T[], seed: number, k = 0) => arr[Math.floor(seed / (k + 1)) % arr.length];
/** Main colour of an item: measured from a photo when known, else seeded from the palette. */
const tone = (f: Furnishing, palette: string[]) => f.color ?? pickOf(palette, f.seed);

const C_DARK = () => mat("#2b2b2e", 0.6);
const C_METAL = () => mat("#c9ccd0", 0.3, 0.6);
const C_BLACK_METAL = () => mat("#2a2a2a", 0.45, 0.6);
const C_CERAMIC = () => mat("#fbfbfa", 0.15);

function Legs({ w, d, h, r = 0.02, inset = 0.06, m }: { w: number; d: number; h: number; r?: number; inset?: number; m: THREE.Material }) {
  const xs = [-w / 2 + inset, w / 2 - inset];
  const zs = [-d / 2 + inset, d / 2 - inset];
  return (
    <>
      {xs.flatMap((x) => zs.map((z) => <C key={`${x}${z}`} p={[x, h / 2, z]} r={r} h={h} m={m} />))}
    </>
  );
}

function Sofa({ f, armchair = false }: { f: Furnishing; armchair?: boolean }) {
  const { w, d } = f;
  const fabric = mat(tone(f, FABRICS), 0.95);
  const cushion = mat(new THREE.Color(tone(f, FABRICS)).offsetHSL(0, 0, 0.06).getStyle(), 0.95);
  const arm = 0.16;
  const seats = armchair ? 1 : w > 2 ? 3 : 2;
  const sw = (w - 2 * arm) / seats;
  return (
    <>
      <B p={[0, 0.22, 0.02]} s={[w, 0.3, d - 0.04]} m={fabric} />
      <B p={[0, 0.55, -d / 2 + 0.11]} s={[w, 0.6, 0.22]} m={fabric} />
      <B p={[-w / 2 + arm / 2, 0.4, 0]} s={[arm, 0.42, d]} m={fabric} />
      <B p={[w / 2 - arm / 2, 0.4, 0]} s={[arm, 0.42, d]} m={fabric} />
      {Array.from({ length: seats }, (_, i) => (
        <B key={i} p={[-w / 2 + arm + sw * (i + 0.5), 0.43, 0.06]} s={[sw - 0.03, 0.13, d - 0.32]} m={cushion} />
      ))}
      {!armchair && (
        <>
          <B p={[-w / 2 + arm + 0.25, 0.62, -d / 2 + 0.3]} s={[0.4, 0.36, 0.12]} m={mat(pickOf(FABRICS, f.seed, 3), 0.95)} />
          <B p={[w / 2 - arm - 0.25, 0.62, -d / 2 + 0.3]} s={[0.4, 0.36, 0.12]} m={mat("#e7dccb", 0.95)} />
        </>
      )}
      <Legs w={w - 0.1} d={d - 0.1} h={0.07} r={0.02} m={C_DARK()} />
    </>
  );
}

function CoffeeTable({ f }: { f: Furnishing }) {
  const wood = mat(tone(f, WOODS), 0.6);
  return (
    <>
      <B p={[0, f.h - 0.025, 0]} s={[f.w, 0.05, f.d]} m={wood} />
      <B p={[0, 0.12, 0]} s={[f.w - 0.1, 0.02, f.d - 0.1]} m={wood} />
      <Legs w={f.w} d={f.d} h={f.h - 0.05} r={0.02} m={wood} />
      <C p={[f.w * 0.2, f.h + 0.05, 0]} r={0.06} h={0.1} m={mat("#c8643b", 0.4)} />
      <B p={[-f.w * 0.15, f.h + 0.02, 0.02]} s={[0.28, 0.04, 0.2]} m={mat("#2f4858", 0.7)} />
    </>
  );
}

function Rug({ f }: { f: Furnishing }) {
  const m = useMemo(() => new THREE.MeshStandardMaterial({ map: rugTexture(f.seed), roughness: 1 }), [f.seed]);
  return <B p={[0, 0.006, 0]} s={[f.w, 0.01, f.d]} m={m} shadow={false} />;
}

function TvUnit({ f }: { f: Furnishing }) {
  const wood = mat(tone(f, WOODS), 0.6);
  return (
    <>
      <B p={[0, 0.27, 0]} s={[f.w, 0.4, f.d]} m={wood} />
      <B p={[0, 0.03, 0]} s={[f.w - 0.06, 0.06, f.d - 0.06]} m={C_DARK()} />
      <B p={[0, 0.82, -0.05]} s={[1.25, 0.72, 0.04]} m={mat("#111214", 0.25, 0.3)} />
      <B p={[0, 0.82, -0.027]} s={[1.2, 0.67, 0.005]} m={mat("#1d2733", 0.1, 0.2, { emissive: "#0b1420", emissiveIntensity: 0.6 })} />
      <B p={[0, 0.5, -0.05]} s={[0.25, 0.06, 0.15]} m={C_DARK()} />
      <C p={[f.w / 2 - 0.2, 0.62, 0]} r={0.07} h={0.3} m={mat("#e9e4da", 0.3)} />
    </>
  );
}

function Kitchen({ f }: { f: Furnishing }) {
  const { w, d } = f;
  const front = mat(tone(f, ["#f1eee8", "#5e6e64", "#2f3b4a", "#d9cbb5"]), 0.55);
  const top = mat("#e6e2dc", 0.25);
  const units = Math.max(1, Math.round(w / 0.6));
  const uw = w / units;
  const sinkAt = Math.min(units - 1, 1);
  const hobAt = Math.max(0, units - 2);
  return (
    <>
      <B p={[0, 0.05, 0.03]} s={[w, 0.1, d - 0.06]} m={C_DARK()} />
      <B p={[0, 0.48, -0.01]} s={[w, 0.76, d - 0.02]} m={front} />
      {Array.from({ length: units }, (_, i) => (
        <group key={i} position={[-w / 2 + uw * (i + 0.5), 0, d / 2]}>
          <B p={[0, 0.48, 0]} s={[uw - 0.01, 0.74, 0.01]} m={front} shadow={false} />
          <B p={[0, 0.8, 0.012]} s={[uw * 0.5, 0.015, 0.015]} m={C_METAL()} shadow={false} />
        </group>
      ))}
      <B p={[0, 0.885, 0]} s={[w + 0.02, 0.04, d + 0.02]} m={top} />
      {/* Sink and tap */}
      <B p={[-w / 2 + uw * (sinkAt + 0.5), 0.9, 0.04]} s={[0.46, 0.012, 0.36]} m={C_METAL()} shadow={false} />
      <C p={[-w / 2 + uw * (sinkAt + 0.5), 1.05, -d / 2 + 0.1]} r={0.015} h={0.3} m={C_METAL()} />
      <B p={[-w / 2 + uw * (sinkAt + 0.5), 1.19, -d / 2 + 0.17]} s={[0.03, 0.03, 0.16]} m={C_METAL()} />
      {/* Hob */}
      {hobAt !== sinkAt && (
        <>
          <B p={[-w / 2 + uw * (hobAt + 0.5), 0.908, 0.02]} s={[0.56, 0.008, 0.5]} m={mat("#141414", 0.2)} shadow={false} />
          {[-1, 1].flatMap((sx) =>
            [-1, 1].map((sz) => (
              <C key={`${sx}${sz}`} p={[-w / 2 + uw * (hobAt + 0.5) + sx * 0.13, 0.913, 0.02 + sz * 0.12]} r={0.08} h={0.003} m={mat("#2c2c2c", 0.4)} />
            )),
          )}
        </>
      )}
      {/* Backsplash */}
      <B p={[0, 1.2, -d / 2 + 0.01]} s={[w, 0.6, 0.02]} m={mat("#e9e6e0", 0.3)} shadow={false} />
      {f.uppers && (
        <>
          <B p={[0, 1.85, -d / 2 + 0.18]} s={[w, 0.7, 0.35]} m={front} />
          {Array.from({ length: units }, (_, i) => (
            <B key={i} p={[-w / 2 + uw * (i + 0.5), 1.55, -d / 2 + 0.36]} s={[uw * 0.5, 0.015, 0.015]} m={C_METAL()} shadow={false} />
          ))}
        </>
      )}
      {/* A few things on the counter */}
      <C p={[w / 2 - 0.25, 0.97, -0.1]} r={0.07} h={0.13} m={mat("#c8643b", 0.4)} />
      <B p={[w / 2 - 0.5, 0.96, -0.15]} s={[0.35, 0.12, 0.2]} m={mat(pickOf(WOODS, f.seed, 2), 0.6)} />
    </>
  );
}

function Fridge({ f }: { f: Furnishing }) {
  return (
    <>
      <B p={[0, f.h / 2, 0]} s={[f.w, f.h, f.d]} m={C_METAL()} />
      <B p={[0, 1.18, f.d / 2 + 0.002]} s={[f.w - 0.02, 0.005, 0.005]} m={C_DARK()} shadow={false} />
      <B p={[f.w / 2 - 0.08, 1.45, f.d / 2 + 0.02]} s={[0.02, 0.35, 0.03]} m={C_DARK()} />
      <B p={[f.w / 2 - 0.08, 0.95, f.d / 2 + 0.02]} s={[0.02, 0.25, 0.03]} m={C_DARK()} />
    </>
  );
}

function Chair({ p, rot, wood, seat }: { p: V3; rot: number; wood: THREE.Material; seat: THREE.Material }) {
  return (
    <group position={p} rotation={[0, rot, 0]}>
      <B p={[0, 0.45, 0]} s={[0.44, 0.04, 0.44]} m={seat} />
      <B p={[0, 0.72, -0.2]} s={[0.42, 0.34, 0.03]} m={wood} />
      <Legs w={0.44} d={0.44} h={0.43} r={0.015} inset={0.03} m={wood} />
    </group>
  );
}

function DiningTable({ f }: { f: Furnishing }) {
  const wood = mat(tone(f, WOODS), 0.55);
  const seat = mat(pickOf(FABRICS, f.seed, 1), 0.9);
  const n = f.chairs ?? 4;
  const perSide = Math.min(3, Math.max(1, Math.floor(n / 2)));
  const ends = n > 2 * perSide;
  const chairs: { p: V3; rot: number }[] = [];
  for (let i = 0; i < perSide; i++) {
    const x = -f.w / 2 + (f.w / perSide) * (i + 0.5);
    chairs.push({ p: [x, 0, f.d / 2 + 0.2], rot: Math.PI }, { p: [x, 0, -f.d / 2 - 0.2], rot: 0 });
  }
  if (ends) chairs.push({ p: [f.w / 2 + 0.25, 0, 0], rot: -Math.PI / 2 }, { p: [-f.w / 2 - 0.25, 0, 0], rot: Math.PI / 2 });
  return (
    <>
      <B p={[0, f.h - 0.02, 0]} s={[f.w, 0.04, f.d]} m={wood} />
      <Legs w={f.w} d={f.d} h={f.h - 0.04} r={0.03} inset={0.08} m={wood} />
      {chairs.map((c, i) => (
        <Chair key={i} p={c.p} rot={c.rot} wood={wood} seat={seat} />
      ))}
      <C p={[0, f.h + 0.08, 0]} r={0.06} rTop={0.04} h={0.16} m={mat("#e9e4da", 0.2)} />
      <Ball p={[0, f.h + 0.2, 0]} r={[0.1, 0.08, 0.1]} m={mat("#6b8f5e", 0.9)} />
    </>
  );
}

function Pendant({ f }: { f: Furnishing }) {
  const ceiling = f.ceiling ?? 2.7;
  const shadeY = 2.0;
  return (
    <>
      <C p={[0, (ceiling + shadeY) / 2, 0]} r={0.005} h={ceiling - shadeY} m={C_DARK()} />
      <C p={[0, shadeY, 0]} r={0.22} rTop={0.06} h={0.2} m={mat("#1f3a4d", 0.5, 0.2)} />
      <mesh position={[0, shadeY - 0.1, 0]} raycast={noRaycast}>
        <sphereGeometry args={[0.05, 12, 8]} />
        <meshStandardMaterial color="#fff6e0" emissive="#ffe6b0" emissiveIntensity={2} />
      </mesh>
    </>
  );
}

function Sideboard({ f }: { f: Furnishing }) {
  const wood = mat(tone(f, WOODS), 0.55);
  return (
    <>
      <B p={[0, f.h / 2 + 0.08, 0]} s={[f.w, f.h - 0.16, f.d]} m={wood} />
      <Legs w={f.w} d={f.d} h={0.16} r={0.02} m={C_DARK()} />
      {[-1, 0, 1].map((i) => (
        <B key={i} p={[(i * f.w) / 3, f.h / 2 + 0.08, f.d / 2 + 0.003]} s={[f.w / 3 - 0.02, f.h - 0.2, 0.005]} m={mat(new THREE.Color(tone(f, WOODS)).offsetHSL(0, 0, -0.05).getStyle(), 0.5)} shadow={false} />
      ))}
      <C p={[-f.w * 0.3, f.h + 0.15, 0]} r={0.08} rTop={0.05} h={0.3} m={mat("#c8643b", 0.3)} />
      <B p={[f.w * 0.2, f.h + 0.03, 0]} s={[0.3, 0.06, 0.22]} m={mat("#2f4858", 0.7)} />
    </>
  );
}

function Bed({ f }: { f: Furnishing }) {
  const { w, d } = f;
  const wood = mat(tone(f, WOODS), 0.6);
  const linen = mat("#f5f2ec", 0.95);
  const throwM = mat(pickOf(FABRICS, f.seed, 1), 0.95);
  const pillows = w > 1.2 ? [-w / 4, w / 4] : [0];
  return (
    <>
      <B p={[0, 0.17, 0]} s={[w, 0.24, d]} m={wood} />
      <B p={[0, 0.39, 0.02]} s={[w - 0.06, 0.2, d - 0.1]} m={linen} />
      <B p={[0, 0.5, 0.25]} s={[w - 0.02, 0.05, d * 0.7]} m={mat("#e9e3d8", 0.95)} />
      <B p={[0, 0.53, d / 2 - 0.35]} s={[w + 0.02, 0.02, 0.5]} m={throwM} />
      <B p={[0, 0.6, -d / 2 + 0.04]} s={[w + 0.06, 0.95, 0.08]} m={mat(pickOf(FABRICS, f.seed, 2), 0.95)} />
      {pillows.map((x) => (
        <B key={x} p={[x, 0.56, -d / 2 + 0.28]} s={[Math.min(0.65, w / pillows.length - 0.08), 0.13, 0.36]} m={linen} />
      ))}
      <Legs w={w} d={d} h={0.06} r={0.025} m={wood} />
    </>
  );
}

function Nightstand({ f }: { f: Furnishing }) {
  const wood = mat(tone(f, WOODS), 0.6);
  return (
    <>
      <B p={[0, 0.3, 0]} s={[f.w, 0.4, f.d]} m={wood} />
      <Legs w={f.w} d={f.d} h={0.1} r={0.015} m={wood} />
      <B p={[0, 0.38, f.d / 2 + 0.003]} s={[0.12, 0.02, 0.01]} m={C_METAL()} shadow={false} />
      <C p={[0, 0.6, 0]} r={0.06} rTop={0.04} h={0.1} m={mat("#d8cfc0", 0.4)} />
      <C p={[0, 0.74, 0]} r={0.14} rTop={0.1} h={0.18} m={mat("#f3ead9", 0.9, 0, { emissive: "#ffdca0", emissiveIntensity: 0.35 })} />
    </>
  );
}

function Wardrobe({ f }: { f: Furnishing }) {
  const body = mat(tone(f, ["#efebe4", "#d9cbb5", "#a07a55"]), 0.6);
  const doors = Math.max(2, Math.round(f.w / 0.5));
  const dw = f.w / doors;
  return (
    <>
      <B p={[0, f.h / 2, 0]} s={[f.w, f.h, f.d]} m={body} />
      {Array.from({ length: doors }, (_, i) => (
        <group key={i}>
          <B p={[-f.w / 2 + dw * i, f.h / 2, f.d / 2 + 0.002]} s={[0.006, f.h - 0.06, 0.004]} m={mat("#8a8378", 0.8)} shadow={false} />
          <B p={[-f.w / 2 + dw * (i + (i % 2 ? 0.12 : 0.88)), 1.05, f.d / 2 + 0.02]} s={[0.015, 0.3, 0.02]} m={C_METAL()} shadow={false} />
        </group>
      ))}
    </>
  );
}

function Desk({ f }: { f: Furnishing }) {
  const wood = mat(tone(f, WOODS), 0.55);
  const chairSeat = mat(tone(f, FABRICS), 0.9);
  return (
    <>
      <B p={[0, f.h - 0.02, 0]} s={[f.w, 0.04, f.d]} m={wood} />
      <Legs w={f.w} d={f.d} h={f.h - 0.04} r={0.018} m={C_BLACK_METAL()} />
      <B p={[-f.w * 0.15, f.h + 0.012, 0.05]} s={[0.34, 0.015, 0.24]} m={mat("#c4c6c9", 0.3, 0.6)} />
      <C p={[f.w * 0.3, f.h + 0.02, -f.d * 0.2]} r={0.08} h={0.04} m={C_DARK()} />
      <C p={[f.w * 0.3, f.h + 0.22, -f.d * 0.2]} r={0.01} h={0.4} m={C_DARK()} />
      <C p={[f.w * 0.3, f.h + 0.42, -f.d * 0.05]} r={0.09} rTop={0.03} h={0.1} m={mat("#c8643b", 0.4)} />
      <Chair p={[0, 0, f.d / 2 + 0.15]} rot={Math.PI} wood={C_BLACK_METAL()} seat={chairSeat} />
    </>
  );
}

const BOOK_COLORS = ["#c8643b", "#2f4858", "#e3b04b", "#86a69d", "#8c5e58", "#e9e4da", "#3c4f63"];
function Bookshelf({ f, books = true }: { f: Furnishing; books?: boolean }) {
  const wood = mat(tone(f, WOODS), 0.6);
  const shelves = Math.max(3, Math.round(f.h / 0.38));
  const items = useMemo(() => {
    if (!books) return [];
    const r = seeded(f.seed);
    const out: { x: number; y: number; w: number; h: number; c: string }[] = [];
    for (let i = 0; i < shelves; i++) {
      const y = (f.h / shelves) * i + 0.03;
      let x = -f.w / 2 + 0.05;
      while (x < f.w / 2 - 0.15) {
        if (r() < 0.15) {
          x += 0.15;
          continue;
        }
        const bw = 0.025 + r() * 0.03;
        out.push({ x: x + bw / 2, y, w: bw, h: 0.18 + r() * 0.1, c: BOOK_COLORS[Math.floor(r() * BOOK_COLORS.length)] });
        x += bw + 0.003;
      }
    }
    return out;
  }, [f.seed, f.w, f.h, shelves, books]);
  return (
    <>
      <B p={[-f.w / 2 + 0.01, f.h / 2, 0]} s={[0.02, f.h, f.d]} m={wood} />
      <B p={[f.w / 2 - 0.01, f.h / 2, 0]} s={[0.02, f.h, f.d]} m={wood} />
      <B p={[0, f.h / 2, -f.d / 2 + 0.005]} s={[f.w, f.h, 0.01]} m={wood} />
      {Array.from({ length: shelves + 1 }, (_, i) => (
        <B key={i} p={[0, Math.min(f.h - 0.01, (f.h / shelves) * i + 0.01), 0]} s={[f.w, 0.02, f.d]} m={wood} />
      ))}
      {items.map((b, i) => (
        <B key={i} p={[b.x, b.y + b.h / 2, 0.02]} s={[b.w, b.h, f.d * 0.75]} m={mat(b.c, 0.8)} shadow={false} />
      ))}
      {!books &&
        Array.from({ length: shelves }, (_, i) => (
          <B key={i} p={[0, (f.h / shelves) * i + 0.15, 0]} s={[f.w * 0.6, 0.26, f.d * 0.8]} m={mat(i % 2 ? "#cfb995" : "#d8d2c8", 0.9)} />
        ))}
    </>
  );
}

function Bathtub({ f }: { f: Furnishing }) {
  return (
    <>
      <B p={[0, f.h / 2, 0]} s={[f.w, f.h, f.d]} m={C_CERAMIC()} />
      <B p={[0, f.h - 0.05, 0]} s={[f.w - 0.14, 0.1, f.d - 0.14]} m={mat("#cfe3ea", 0.05, 0, { transparent: true, opacity: 0.85 })} />
      <C p={[-f.w / 2 + 0.12, f.h + 0.12, -f.d / 2 + 0.05]} r={0.015} h={0.25} m={C_METAL()} />
    </>
  );
}

function Shower({ f }: { f: Furnishing }) {
  const glass = mat("#cfe3ea", 0.05, 0, { transparent: true, opacity: 0.25, depthWrite: false });
  return (
    <>
      <B p={[0, 0.03, 0]} s={[f.w, 0.06, f.d]} m={C_CERAMIC()} />
      <B p={[0, 1.0, f.d / 2 - 0.01]} s={[f.w, 1.9, 0.01]} m={glass} shadow={false} />
      <C p={[0, 1.15, -f.d / 2 + 0.03]} r={0.012} h={2.0} m={C_METAL()} />
      <C p={[0, 2.0, -f.d / 2 + 0.15]} r={0.1} h={0.02} m={C_METAL()} />
    </>
  );
}

function Toilet({ f }: { f: Furnishing }) {
  return (
    <>
      <C p={[0, 0.2, 0.08]} r={0.15} rTop={0.19} h={0.4} m={C_CERAMIC()} />
      <C p={[0, 0.41, 0.08]} r={0.2} h={0.03} m={C_CERAMIC()} />
      <B p={[0, 0.6, -f.d / 2 + 0.1]} s={[0.38, 0.36, 0.18]} m={C_CERAMIC()} />
      <B p={[0, 0.79, -f.d / 2 + 0.1]} s={[0.4, 0.02, 0.2]} m={C_CERAMIC()} />
    </>
  );
}

function Vanity({ f }: { f: Furnishing }) {
  const wood = mat(tone(f, WOODS), 0.55);
  return (
    <>
      <B p={[0, 0.55, 0]} s={[f.w, 0.5, f.d]} m={wood} />
      <B p={[0, 0.82, 0]} s={[f.w + 0.02, 0.04, f.d + 0.02]} m={C_CERAMIC()} />
      <C p={[0, 0.88, 0.04]} r={0.18} rTop={0.2} h={0.08} m={C_CERAMIC()} />
      <C p={[0, 0.98, -f.d / 2 + 0.06]} r={0.012} h={0.2} m={C_METAL()} />
      <B p={[0, 1.55, -f.d / 2 + 0.015]} s={[f.w * 0.8, 0.8, 0.02]} m={mat("#c9d3d8", 0.05, 0.9)} />
      <B p={[0, 1.55, -f.d / 2 + 0.01]} s={[f.w * 0.8 + 0.04, 0.84, 0.015]} m={C_DARK()} shadow={false} />
    </>
  );
}

function Console({ f }: { f: Furnishing }) {
  const wood = mat(tone(f, WOODS), 0.55);
  return (
    <>
      <B p={[0, f.h - 0.02, 0]} s={[f.w, 0.04, f.d]} m={wood} />
      <B p={[0, 0.15, 0]} s={[f.w - 0.06, 0.02, f.d - 0.04]} m={wood} />
      <Legs w={f.w} d={f.d} h={f.h - 0.04} r={0.015} inset={0.03} m={C_BLACK_METAL()} />
      <C p={[f.w * 0.3, f.h + 0.12, 0]} r={0.05} rTop={0.03} h={0.24} m={mat("#86a69d", 0.3)} />
      <B p={[-f.w * 0.25, f.h + 0.02, 0]} s={[0.2, 0.03, 0.14]} m={mat("#c8643b", 0.6)} />
    </>
  );
}

function Bench({ f }: { f: Furnishing }) {
  const wood = mat(tone(f, WOODS), 0.55);
  return (
    <>
      <B p={[0, f.h - 0.03, 0]} s={[f.w, 0.06, f.d]} m={wood} />
      <B p={[0, f.h + 0.03, 0]} s={[f.w - 0.05, 0.06, f.d - 0.05]} m={mat(tone(f, FABRICS), 0.95)} />
      <Legs w={f.w} d={f.d} h={f.h - 0.06} r={0.02} m={wood} />
      {/* Coat hooks above */}
      <B p={[0, 1.7, -f.d / 2 + 0.01]} s={[f.w * 0.8, 0.08, 0.02]} m={wood} />
      {[-0.3, 0, 0.3].map((x) => (
        <C key={x} p={[x * f.w, 1.64, -f.d / 2 + 0.06]} r={0.012} h={0.08} m={C_BLACK_METAL()} />
      ))}
      <B p={[-0.3 * f.w, 1.35, -f.d / 2 + 0.08]} s={[0.4, 0.55, 0.08]} m={mat("#7a5a40", 0.9)} />
    </>
  );
}

const POTS = ["#c8643b", "#efe9e1", "#2f4858", "#b5835a"];
function Plant({ f }: { f: Furnishing }) {
  const pot = mat(tone(f, POTS), 0.7);
  const leaf = mat(pickOf(["#5f7f4f", "#6b8f5e", "#4f6f45"], f.seed, 1), 0.9);
  const r = f.w * 0.4;
  const potH = Math.min(0.4, f.h * 0.3);
  const crown = f.h - potH;
  return (
    <>
      <C p={[0, potH / 2, 0]} r={r * 0.8} rTop={r} h={potH} m={pot} />
      <C p={[0, potH + crown * 0.3, 0]} r={0.015} h={crown * 0.6} m={mat("#6b5040", 0.9)} />
      <Ball p={[0, potH + crown * 0.55, 0]} r={[r * 1.3, crown * 0.35, r * 1.3]} m={leaf} />
      <Ball p={[r * 0.5, potH + crown * 0.8, r * 0.2]} r={[r, crown * 0.25, r]} m={leaf} />
      <Ball p={[-r * 0.4, potH + crown * 0.75, -r * 0.3]} r={[r * 0.9, crown * 0.25, r * 0.9]} m={leaf} />
    </>
  );
}

function FloorLamp() {
  return (
    <>
      <C p={[0, 0.015, 0]} r={0.15} h={0.03} m={C_BLACK_METAL()} />
      <C p={[0, 0.8, 0]} r={0.012} h={1.55} m={C_BLACK_METAL()} />
      <C p={[0, 1.55, 0]} r={0.22} rTop={0.16} h={0.28} m={mat("#f3ead9", 0.9, 0, { emissive: "#ffdca0", emissiveIntensity: 0.5 })} />
    </>
  );
}

function Art({ f }: { f: Furnishing }) {
  const m = useMemo(() => new THREE.MeshStandardMaterial({ map: artTexture(f.seed), roughness: 0.85 }), [f.seed]);
  const y = f.elevation ?? 1.5;
  const frame = mat(pickOf(["#1f1f1f", "#d6b48c", "#f4f2ee"], f.seed, 2), 0.6);
  return (
    <>
      <B p={[0, y, 0]} s={[f.w, f.h, 0.03]} m={frame} />
      <mesh position={[0, y, 0.0155]} material={m} raycast={noRaycast}>
        <planeGeometry args={[f.w - 0.06, f.h - 0.06]} />
      </mesh>
    </>
  );
}

function BistroSet() {
  const metal = mat("#2f4858", 0.5, 0.5);
  return (
    <>
      <C p={[0, 0.72, 0]} r={0.33} h={0.03} m={metal} />
      <C p={[0, 0.36, 0]} r={0.02} h={0.72} m={metal} />
      <C p={[0, 0.01, 0]} r={0.18} h={0.02} m={metal} />
      <Chair p={[-0.52, 0, 0]} rot={Math.PI / 2} wood={metal} seat={metal} />
      <Chair p={[0.52, 0, 0]} rot={-Math.PI / 2} wood={metal} seat={metal} />
      <C p={[0.05, 0.79, 0.05]} r={0.04} h={0.1} m={mat("#e3b04b", 0.5)} />
    </>
  );
}

function Railing({ f }: { f: Furnishing }) {
  const metal = mat("#3a3a3a", 0.5, 0.6);
  const posts = Math.max(2, Math.round(f.w / 1.2) + 1);
  return (
    <>
      <B p={[0, f.h, 0]} s={[f.w, 0.04, 0.06]} m={metal} />
      <B p={[0, f.h / 2 + 0.05, 0]} s={[f.w, f.h - 0.1, 0.01]} m={mat("#cfe3ea", 0.05, 0, { transparent: true, opacity: 0.3, depthWrite: false })} shadow={false} />
      {Array.from({ length: posts }, (_, i) => (
        <B key={i} p={[-f.w / 2 + (f.w / (posts - 1)) * i, f.h / 2, 0]} s={[0.04, f.h, 0.04]} m={metal} />
      ))}
    </>
  );
}

/** Anything without its own model: a softened box in its colour (wall-hung when it has an elevation). */
function Generic({ f }: { f: Furnishing }) {
  const m = mat(f.color ?? "#d9d4cc", 0.7);
  const y = f.elevation ?? f.h / 2;
  return (
    <>
      <B p={[0, y, 0]} s={[f.w, f.h, f.d]} m={m} />
      <B p={[0, y, f.d / 2 + 0.002]} s={[f.w - 0.04, f.h - 0.04, 0.004]} m={mat(new THREE.Color(f.color ?? "#d9d4cc").offsetHSL(0, 0, -0.06).getStyle(), 0.6)} shadow={false} />
    </>
  );
}

function Item({ f }: { f: Furnishing }) {
  switch (f.kind) {
    case "sofa":
      return <Sofa f={f} />;
    case "armchair":
      return <Sofa f={f} armchair />;
    case "coffeeTable":
      return <CoffeeTable f={f} />;
    case "rug":
      return <Rug f={f} />;
    case "tvUnit":
      return <TvUnit f={f} />;
    case "kitchen":
      return <Kitchen f={f} />;
    case "fridge":
      return <Fridge f={f} />;
    case "diningTable":
      return <DiningTable f={f} />;
    case "pendant":
      return <Pendant f={f} />;
    case "sideboard":
      return <Sideboard f={f} />;
    case "bed":
      return <Bed f={f} />;
    case "nightstand":
      return <Nightstand f={f} />;
    case "wardrobe":
      return <Wardrobe f={f} />;
    case "desk":
      return <Desk f={f} />;
    case "bookshelf":
      return <Bookshelf f={f} />;
    case "shelves":
      return <Bookshelf f={f} books={false} />;
    case "bathtub":
      return <Bathtub f={f} />;
    case "shower":
      return <Shower f={f} />;
    case "toilet":
      return <Toilet f={f} />;
    case "vanity":
      return <Vanity f={f} />;
    case "console":
      return <Console f={f} />;
    case "bench":
      return <Bench f={f} />;
    case "plant":
      return <Plant f={f} />;
    case "floorLamp":
      return <FloorLamp />;
    case "art":
      return <Art f={f} />;
    case "bistroSet":
      return <BistroSet />;
    case "railing":
      return <Railing f={f} />;
    case "generic":
      return <Generic f={f} />;
  }
}

/** Staged furniture for one level (positions are plan space; the parent group places the level). */
export const Furnishings = memo(function Furnishings({ items, balconyDrop = 0 }: { items: Furnishing[]; balconyDrop?: number }) {
  return (
    <group>
      {items.map((f) => (
        <group
          key={f.id}
          position={[f.x, f.onBalcony ? -balconyDrop : 0, f.y]}
          rotation={[0, f.rot, 0]}
        >
          <Item f={f} />
        </group>
      ))}
    </group>
  );
});
