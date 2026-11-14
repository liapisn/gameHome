"use client";

import { Suspense, useMemo } from "react";
import * as THREE from "three";
import { Canvas } from "@react-three/fiber";
import { Bounds, Center, ContactShadows, Environment, OrbitControls, useGLTF } from "@react-three/drei";

/** The whole home as one model (house.glb: the shell plus every room's generated furniture). */
function House({ url }: { url: string }) {
  const { scene } = useGLTF(url, true);
  const model = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        // The shell's walls are single-sided; show them from both sides when orbiting.
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.side = THREE.DoubleSide;
      }
    });
    return c;
  }, [scene]);
  return <primitive object={model} />;
}

export function HouseModelViewer({ url }: { url: string }) {
  return (
    <div className="h-[70vh] min-h-[420px] w-full overflow-hidden rounded-2xl border border-black/10 bg-[#f4f2ee]">
      <Canvas shadows camera={{ position: [10, 12, 14], fov: 40, near: 0.05, far: 500 }}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[8, 14, 6]} intensity={1.4} castShadow shadow-mapSize={[2048, 2048]} />
        <Suspense fallback={null}>
          <Environment preset="apartment" />
          <Bounds fit clip observe margin={1.15}>
            <Center>
              <House url={url} />
            </Center>
          </Bounds>
          <ContactShadows position={[0, -0.01, 0]} opacity={0.35} scale={40} blur={2.4} far={10} />
        </Suspense>
        <OrbitControls makeDefault enableDamping maxPolarAngle={Math.PI / 2.05} />
      </Canvas>
    </div>
  );
}
