import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { buildDollhouseScene } from "@/lib/dollhouse-geometry";
import type { FloorPlan } from "@/lib/floorplan";
import { photoCamera, rotationYToYaw } from "@/lib/tour/space";
import type { TourLevel, TourPhoto } from "@/lib/tour/types";

const vertexShader = /* glsl */ `
  uniform mat4 uProjView;
  varying vec4 vProj;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vProj = uProjView * world;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;
  varying vec4 vProj;
  void main() {
    if (vProj.w <= 0.0) discard;
    vec2 uv = vProj.xy / vProj.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
    // Soften the frame edge so the photo blends into the model around it.
    float edge = smoothstep(0.0, 0.04, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
    gl_FragColor = vec4(texture2D(uMap, uv).rgb, uOpacity * edge);
    #include <colorspace_fragment>
  }
`;

/**
 * Projects a photo onto its level's shell (floors, walls, ceilings) from the solved camera pose.
 * From the pose itself the room reads as the photo; the projection fades out as you walk away,
 * since the shell has no furniture and parallax would smear it.
 */
export function ProjectedPhoto({
  level,
  plan,
  photo,
  url,
}: {
  level: TourLevel;
  plan: FloorPlan;
  photo: TourPhoto;
  url: string;
}) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    let disposed = false;
    let loaded: THREE.Texture | null = null;
    new THREE.TextureLoader().load(url, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      loaded = t;
      if (disposed) t.dispose();
      else setTexture(t);
    });
    return () => {
      disposed = true;
      loaded?.dispose();
      setTexture(null);
    };
  }, [url]);

  const meshes = useMemo(() => {
    const scene = buildDollhouseScene(plan, { ceilings: true });
    const shell = scene.children.filter(
      (m): m is THREE.Mesh => m instanceof THREE.Mesh && !m.name.startsWith("glass__"),
    );
    // The viewer draws floors 1 mm above the slab tops; lift the projected floors above them.
    shell.filter((m) => m.name.startsWith("floor__")).forEach((m) => m.geometry.translate(0, 0.004, 0));
    return shell;
  }, [plan]);
  useEffect(() => () => meshes.forEach((m) => m.geometry.dispose()), [meshes]);

  const projector = useMemo(
    () => (photo.pose ? photoCamera(level, photo.pose, photo.height / photo.width) : null),
    [level, photo],
  );

  const material = useMemo(() => {
    if (!projector) return null;
    return new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: null },
        uOpacity: { value: 0 },
        uProjView: { value: projector.projectionMatrix.clone().multiply(projector.matrixWorldInverse) },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
  }, [projector]);
  // three.js objects are mutated per frame; go through a ref so React treats them as external.
  const matRef = useRef<THREE.ShaderMaterial | null>(null);
  useEffect(() => {
    matRef.current = material;
    return () => material?.dispose();
  }, [material]);

  useEffect(() => {
    if (matRef.current) matRef.current.uniforms.uMap.value = texture;
  }, [material, texture]);

  const facing = useRef(new THREE.Vector3());
  useFrame(({ camera }, dt) => {
    const mat = matRef.current;
    if (!mat || !projector) return;
    // Full strength at the pose, fading out over ~1.5 m or ~60° of turning away.
    const dist = camera.position.distanceTo(projector.position);
    const f = camera.getWorldDirection(facing.current);
    const yaw = rotationYToYaw(Math.atan2(-f.x, -f.z));
    const turn = Math.abs(((yaw - (photo.pose?.yaw ?? 0) + 540) % 360) - 180);
    const target = texture ? Math.max(0, 1 - Math.max(0, dist - 0.15) / 1.5) * Math.max(0, 1 - turn / 60) : 0;
    const u = mat.uniforms.uOpacity;
    u.value += (target - u.value) * Math.min(1, dt * 6);
  });

  if (!material) return null;
  return (
    <group position={[level.offset[0], level.elevation, level.offset[1]]}>
      {meshes.map((m) => (
        <mesh key={m.name} geometry={m.geometry} material={material} renderOrder={10} raycast={() => null} />
      ))}
    </group>
  );
}

