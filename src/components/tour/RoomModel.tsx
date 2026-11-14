"use client";

import { Suspense, useMemo } from "react";
import { useGLTF } from "@react-three/drei";

/**
 * A room's generated furniture (lib/models3d): one .glb in plan coordinates, so inside the level's
 * group it needs no transform. Draco-compressed; drei fetches the decoder on first use.
 */
function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url, true);
  const copy = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    return c;
  }, [scene]);
  return <primitive object={copy} />;
}

export function RoomModel({ url }: { url: string }) {
  return (
    <Suspense fallback={null}>
      <Model url={url} />
    </Suspense>
  );
}
