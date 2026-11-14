import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { DEG, yawToRotationY } from "@/lib/tour/space";

export interface WalkTarget {
  position: [number, number, number];
  /** Plan-space yaw in degrees; null keeps the current heading. */
  yaw: number | null;
  pitch?: number;
  /** Vertical FOV in degrees; null keeps the current one. */
  fov?: number | null;
  /** Changes whenever a new move is requested, even to the same spot. */
  key: number;
}

const DEFAULT_FOV = 70;
const DURATION = 0.9;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * First-person camera: glides to targets, drag to look around, wheel to zoom,
 * arrow keys / WASD to walk. Floor clicks are handled by the scene, which sets a new target.
 */
export function WalkRig({ target, bounds }: { target: WalkTarget; bounds?: THREE.Box3 }) {
  // Read three.js objects through get() inside effects/frames: they are mutated, not rendered.
  const get = useThree((s) => s.get);
  const cam = () => get().camera as THREE.PerspectiveCamera;

  const look = useRef({ yaw: 0, pitch: 0 }); // camera rotation (radians, three convention)
  const anim = useRef<{
    t: number;
    from: THREE.Vector3;
    to: THREE.Vector3;
    yaw0: number;
    yaw1: number;
    pitch0: number;
    pitch1: number;
    fov0: number;
    fov1: number;
  } | null>(null);
  const keys = useRef(new Set<string>());

  // Start every walk from wherever the camera currently is.
  useEffect(() => {
    const camera = cam();
    camera.rotation.order = "YXZ";
    look.current = { yaw: camera.rotation.y, pitch: camera.rotation.x };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cam() reads the live store
  }, [get]);

  useEffect(() => {
    const camera = cam();
    const yaw1Raw = target.yaw == null ? look.current.yaw : yawToRotationY(target.yaw);
    // Turn the short way round.
    const yaw0 = look.current.yaw;
    const delta = Math.atan2(Math.sin(yaw1Raw - yaw0), Math.cos(yaw1Raw - yaw0));
    anim.current = {
      t: 0,
      from: camera.position.clone(),
      to: new THREE.Vector3(...target.position),
      yaw0,
      yaw1: yaw0 + delta,
      pitch0: look.current.pitch,
      pitch1: (target.pitch ?? 0) * DEG,
      fov0: camera.fov,
      fov1: target.fov ?? (target.yaw == null ? camera.fov : DEFAULT_FOV),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cam() reads the live store
  }, [target, get]);

  // Drag to look (grab-the-world: drag right turns left), wheel to zoom.
  useEffect(() => {
    const camera = cam();
    const el = get().gl.domElement;
    let drag: { x: number; y: number; id: number } | null = null;
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
    };
    const move = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return;
      const k = (camera.fov * DEG) / el.clientHeight;
      look.current.yaw += (e.clientX - drag.x) * k;
      look.current.pitch = THREE.MathUtils.clamp(look.current.pitch + (e.clientY - drag.y) * k, -1.2, 1.2);
      drag = { ...drag, x: e.clientX, y: e.clientY };
      if (anim.current) {
        // Hand rotation back to the user mid-glide; keep the position move.
        anim.current.yaw0 = anim.current.yaw1 = look.current.yaw;
        anim.current.pitch0 = anim.current.pitch1 = look.current.pitch;
      }
    };
    const up = () => {
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      camera.fov = THREE.MathUtils.clamp(camera.fov + e.deltaY * 0.05, 30, 100);
      camera.updateProjectionMatrix();
      if (anim.current) anim.current.fov0 = anim.current.fov1 = camera.fov;
    };
    const keydown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea")) return;
      keys.current.add(e.key.toLowerCase());
    };
    const keyup = (e: KeyboardEvent) => keys.current.delete(e.key.toLowerCase());
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    el.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cam() reads the live store
  }, [get]);

  const step = useRef(new THREE.Vector3());
  useFrame((state, dt) => {
    const camera = state.camera as THREE.PerspectiveCamera;
    const a = anim.current;
    if (a) {
      a.t = Math.min(1, a.t + dt / DURATION);
      const k = ease(a.t);
      camera.position.lerpVectors(a.from, a.to, k);
      look.current.yaw = a.yaw0 + (a.yaw1 - a.yaw0) * k;
      look.current.pitch = a.pitch0 + (a.pitch1 - a.pitch0) * k;
      camera.fov = a.fov0 + (a.fov1 - a.fov0) * k;
      camera.updateProjectionMatrix();
      if (a.t >= 1) anim.current = null;
    }

    // Keyboard walking: forward/back along the heading, strafe sideways, Q/E or ←/→ to turn.
    const k = keys.current;
    if (k.size) {
      const speed = 1.6 * dt;
      const fwd = (k.has("w") || k.has("arrowup") ? 1 : 0) - (k.has("s") || k.has("arrowdown") ? 1 : 0);
      const side = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0);
      const turn = (k.has("arrowleft") || k.has("q") ? 1 : 0) - (k.has("arrowright") || k.has("e") ? 1 : 0);
      look.current.yaw += turn * 1.4 * dt;
      const y = look.current.yaw;
      step.current.set(-Math.sin(y) * fwd + Math.cos(y) * side, 0, -Math.cos(y) * fwd - Math.sin(y) * side);
      if (fwd || side) {
        anim.current = null;
        camera.position.addScaledVector(step.current, speed);
        if (bounds) camera.position.clamp(bounds.min, bounds.max);
      }
    }

    camera.rotation.set(look.current.pitch, look.current.yaw, 0, "YXZ");
  });

  return null;
}
