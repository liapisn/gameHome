"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import {
  type FloorPlan,
  interiorArea,
  planBounds,
  polygonArea,
  polygonCentroid,
} from "@/lib/floorplan";
import { Dollhouse } from "./Dollhouse";

type View = [number, number, number, number, number, number];

export function TourViewer({ plan }: { plan: FloorPlan }) {
  const controls = useRef<CameraControls | null>(null);
  const labelRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeRoom, setActiveRoom] = useState<string | null>(null);

  const rooms = plan.rooms;
  const b = planBounds(plan);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minY + b.maxY) / 2;
  const overviewView: View = useMemo(() => [cx + 4, 17, cz + 10, cx, 0, cz], [cx, cz]);

  const anchors = useMemo(
    () =>
      rooms.map((r) => {
        const [x, z] = polygonCentroid(r.polygon);
        return new THREE.Vector3(x, 0.05, z);
      }),
    [rooms],
  );

  const overview = useCallback(() => {
    setActiveRoom(null);
    controls.current?.setLookAt(...overviewView, true);
  }, [overviewView]);

  const selectRoom = useCallback(
    (id: string) => {
      const room = rooms.find((r) => r.id === id);
      if (!room) return;
      setActiveRoom(id);
      const [rx, rz] = polygonCentroid(room.polygon);
      controls.current?.setLookAt(rx + 1, 9, rz + 3.5, rx, 0, rz, true);
    },
    [rooms],
  );

  return (
    <div className="relative flex h-dvh w-full flex-col bg-[#f3efe8] md:flex-row">
      <aside className="order-2 flex max-h-[42dvh] flex-col gap-4 overflow-y-auto border-t border-black/10 bg-[#fbf9f5] p-5 md:order-1 md:max-h-none md:w-80 md:border-t-0 md:border-r">
        <Link href="/" className="text-sm font-semibold tracking-tight text-neutral-900">
          gameHome
        </Link>
        <div>
          <p className="text-xs uppercase tracking-[0.14em] text-neutral-500">Demo tour</p>
          <h1 className="mt-1 text-lg font-semibold leading-snug text-neutral-900">{plan.title}</h1>
          <p className="mt-1 text-sm text-neutral-600">
            {interiorArea(plan).toFixed(0)} m² interior ·{" "}
            {rooms.filter((r) => r.type === "bedroom").length} bedrooms · ceiling{" "}
            {plan.ceilingHeight} m
          </p>
        </div>

        <ul className="flex flex-col gap-1">
          {rooms.map((room) => {
            const active = room.id === activeRoom;
            return (
              <li key={room.id}>
                <button
                  onClick={() => selectRoom(room.id)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    active ? "bg-[#c8643b] text-white" : "text-neutral-800 hover:bg-black/5"
                  }`}
                >
                  <span>{room.name}</span>
                  <span className={active ? "text-white/80" : "text-neutral-500"}>
                    {polygonArea(room.polygon).toFixed(1)} m²
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <button
          onClick={overview}
          className="rounded-lg border border-black/15 px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-black/5"
        >
          Dollhouse overview
        </button>

        <p className="mt-auto text-xs leading-relaxed text-neutral-500">
          Generated from structured floor plan geometry. In the product this comes from the
          uploaded plan, with photos and video layered on top.
        </p>
      </aside>

      <div className="relative order-1 min-h-0 flex-1 overflow-hidden md:order-2">
        <Canvas
          shadows
          camera={{ position: overviewView.slice(0, 3) as [number, number, number], fov: 40 }}
          onPointerMissed={() => setActiveRoom(null)}
        >
          <color attach="background" args={["#f3efe8"]} />
          <hemisphereLight args={["#fffaf2", "#d8cfc4", 0.9]} />
          <ambientLight intensity={0.35} />
          <directionalLight
            position={[cx + 7, 14, cz + 5]}
            intensity={1.5}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-camera-left={-12}
            shadow-camera-right={12}
            shadow-camera-top={12}
            shadow-camera-bottom={-12}
            shadow-bias={-0.0005}
          >
            <object3D attach="target" position={[cx, 0, cz]} />
          </directionalLight>

          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, -0.06, cz]} receiveShadow>
            <planeGeometry args={[60, 60]} />
            <shadowMaterial opacity={0.12} />
          </mesh>

          <Dollhouse plan={plan} activeRoom={activeRoom} onSelectRoom={selectRoom} />

          <CameraControls
            ref={controls}
            makeDefault
            minDistance={3}
            maxDistance={30}
            maxPolarAngle={Math.PI / 2.15}
          />
          <InitialView view={overviewView} />
          <LabelProjector anchors={anchors} labels={labelRefs} />
        </Canvas>

        <div className="pointer-events-none absolute inset-0">
          {rooms.map((room, i) => {
            const active = room.id === activeRoom;
            return (
              <button
                key={room.id}
                ref={(el) => {
                  labelRefs.current[i] = el;
                }}
                onClick={() => selectRoom(room.id)}
                style={{ visibility: "hidden" }}
                className={`pointer-events-auto absolute top-0 left-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-sm transition-colors will-change-transform ${
                  active
                    ? "border-[#c8643b] bg-[#c8643b] text-white"
                    : "border-black/10 bg-white/90 text-neutral-800 hover:bg-white"
                }`}
              >
                {room.name} · {polygonArea(room.polygon).toFixed(1)} m²
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Points the default controls at the plan once they're registered in the R3F store. */
function InitialView({ view }: { view: View }) {
  const ctrl = useThree((s) => s.controls) as CameraControls | null;
  useEffect(() => {
    ctrl?.setLookAt(...view, false);
  }, [ctrl, view]);
  return null;
}

/** Projects room anchors to screen space each frame and positions the HTML labels. */
function LabelProjector({
  anchors,
  labels,
}: {
  anchors: THREE.Vector3[];
  labels: React.RefObject<(HTMLButtonElement | null)[]>;
}) {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    anchors.forEach((anchor, i) => {
      const el = labels.current[i];
      if (!el) return;
      v.copy(anchor).project(camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      el.style.visibility = visible ? "visible" : "hidden";
      if (!visible) return;
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
    });
  });
  return null;
}
