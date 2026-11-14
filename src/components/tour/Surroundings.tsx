import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { Sky } from "@react-three/drei";

const BUILDING_COLORS = ["#efe6d6", "#e8d9c0", "#f3eee6", "#dcd3c4", "#e9dccb", "#d9c7ae"];
const noRaycast = () => null;

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Facade texture: a grid of windows, shared by every neighbouring building. */
function useFacade() {
  return useMemo(() => {
    if (typeof document === "undefined") return null;
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = "#7d8790";
    ctx.fillRect(40, 28, 48, 60);
    ctx.fillStyle = "#c9c2b6";
    ctx.fillRect(34, 92, 60, 6);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }, []);
}

/**
 * What the windows look out on in walk mode: sky, ground, street trees and neighbouring
 * buildings, kept a street's width away from the house.
 */
export function Surroundings({ bounds }: { bounds: THREE.Box3 }) {
  const facade = useFacade();
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.z) / 2;

  const { trees, buildings } = useMemo(() => {
    const r = rng(4242);
    const trees = Array.from({ length: 18 }, (_, i) => {
      const a = (i / 18) * Math.PI * 2 + r() * 0.2;
      const d = radius + 5 + r() * 3;
      return { x: center.x + Math.cos(a) * d, z: center.z + Math.sin(a) * d, h: 3.5 + r() * 3, s: 1.2 + r() * 0.9 };
    });
    const buildings = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2 + r() * 0.15;
      const d = radius + 14 + r() * 8;
      const w = 8 + r() * 8;
      const floors = 3 + Math.floor(r() * 5);
      return {
        x: center.x + Math.cos(a) * d,
        z: center.z + Math.sin(a) * d,
        rot: -a + Math.PI / 2,
        w,
        dep: 8 + r() * 6,
        h: floors * 3,
        floors,
        color: BUILDING_COLORS[Math.floor(r() * BUILDING_COLORS.length)],
      };
    });
    return { trees, buildings };
  }, [center.x, center.z, radius]);

  // One clone per building (clones share the image) so each can repeat its own window grid.
  const facades = useMemo(
    () =>
      buildings.map((b) => {
        if (!facade) return null;
        const t = facade.clone();
        t.repeat.set(Math.max(1, Math.round(b.w / 3)), b.floors);
        return t;
      }),
    [facade, buildings],
  );
  useEffect(() => () => facades.forEach((t) => t?.dispose()), [facades]);

  const ground = bounds.min.y - 0.15;

  return (
    <group>
      <Sky distance={450} sunPosition={[80, 45, 40]} turbidity={5} rayleigh={1.1} mieCoefficient={0.004} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center.x, ground, center.z]} receiveShadow raycast={noRaycast}>
        <circleGeometry args={[200, 48]} />
        <meshStandardMaterial color="#b8b2a3" roughness={1} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center.x, ground + 0.01, center.z]} raycast={noRaycast}>
        <ringGeometry args={[radius + 3, radius + 10, 64]} />
        <meshStandardMaterial color="#8fa06f" roughness={1} />
      </mesh>
      {trees.map((t, i) => (
        <group key={i} position={[t.x, ground, t.z]}>
          <mesh position={[0, t.h * 0.3, 0]} castShadow raycast={noRaycast}>
            <cylinderGeometry args={[0.1, 0.16, t.h * 0.6, 8]} />
            <meshStandardMaterial color="#6b5040" roughness={1} />
          </mesh>
          <mesh position={[0, t.h * 0.7, 0]} scale={[t.s, t.s * 1.2, t.s]} castShadow raycast={noRaycast}>
            <icosahedronGeometry args={[1, 1]} />
            <meshStandardMaterial color={i % 3 ? "#5f7f4f" : "#6f8f55"} roughness={1} flatShading />
          </mesh>
        </group>
      ))}
      {buildings.map((b, i) => (
        <group key={i} position={[b.x, ground, b.z]} rotation={[0, b.rot, 0]}>
          <mesh position={[0, b.h / 2, 0]} raycast={noRaycast}>
            <boxGeometry args={[b.w, b.h, b.dep]} />
            <meshStandardMaterial color={b.color} roughness={0.95} map={facades[i] ?? undefined} />
          </mesh>
          <mesh position={[0, b.h + 0.15, 0]} raycast={noRaycast}>
            <boxGeometry args={[b.w + 0.3, 0.3, b.dep + 0.3]} />
            <meshStandardMaterial color="#cfc6b8" roughness={1} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
