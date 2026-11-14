"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import * as THREE from "three";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { CameraControls } from "@react-three/drei";
import { type Room, interiorArea, planBounds, polygonArea, polygonCentroid } from "@/lib/floorplan";
import { EYE_HEIGHT, framingPitch, toWorld, vfovOf } from "@/lib/tour/space";
import { type ResolvedTour, type TourPhoto, roomKey } from "@/lib/tour/types";
import { Dollhouse, type DollhouseLook } from "./Dollhouse";
import { ProjectedPhoto } from "./ProjectedPhoto";
import { type WalkTarget, WalkRig } from "./WalkRig";

type Mode = "dollhouse" | "walk";
type Level = ResolvedTour["levels"][number];
type View = [number, number, number, number, number, number];
interface RoomRef {
  levelId: string;
  roomId: string;
}

const ACCENT = "#c8643b";

export function TourViewer({ tour }: { tour: ResolvedTour }) {
  const controls = useRef<CameraControls | null>(null);
  const labelRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const [mode, setMode] = useState<Mode>("dollhouse");
  const [levelFilter, setLevelFilter] = useState<string | null>(null); // null = all levels
  const [activeRoom, setActiveRoom] = useState<RoomRef | null>(null);
  const [activePhotoId, setActivePhotoId] = useState<string | null>(null);
  const [walkTarget, setWalkTarget] = useState<WalkTarget | null>(null);
  const [walkLevelId, setWalkLevelId] = useState<string>(tour.levels[0].id);
  const [lightbox, setLightbox] = useState<TourPhoto | null>(null);

  const levelById = useMemo(() => new Map(tour.levels.map((l) => [l.id, l])), [tour.levels]);
  const posed = useMemo(() => tour.photos.filter((p) => p.pose && p.levelId && p.roomId), [tour.photos]);
  const unposed = useMemo(() => tour.photos.filter((p) => !(p.pose && p.levelId && p.roomId)), [tour.photos]);
  const activePhoto = posed.find((p) => p.id === activePhotoId) ?? null;

  // In the dollhouse, a selected level hides the levels above it (cutaway). Walking shows one level.
  const visibleLevels = useMemo(() => {
    if (mode === "walk") return tour.levels.filter((l) => l.id === walkLevelId);
    if (!levelFilter) return tour.levels;
    const top = levelById.get(levelFilter)!.elevation;
    return tour.levels.filter((l) => l.elevation <= top);
  }, [mode, walkLevelId, levelFilter, tour.levels, levelById]);

  const bounds = useMemo(() => {
    const box = new THREE.Box3();
    for (const l of tour.levels) {
      const b = planBounds(l.plan);
      box.expandByPoint(toWorld(l, [b.minX, b.minY]));
      box.expandByPoint(toWorld(l, [b.maxX, b.maxY], l.plan.ceilingHeight));
    }
    return box;
  }, [tour.levels]);
  const center = useMemo(() => bounds.getCenter(new THREE.Vector3()), [bounds]);
  const size = useMemo(() => bounds.getSize(new THREE.Vector3()), [bounds]);
  const overviewView: View = useMemo(() => {
    const r = Math.max(size.x, size.z);
    return [center.x + r * 0.35, bounds.max.y + r * 1.05, center.z + r * 0.85, center.x, bounds.min.y, center.z];
  }, [center, size, bounds]);

  // Floors take the color seen in each room's photos. Walls stay neutral: they're shared between
  // rooms, so one photo's paint color would mislabel every room it borders.
  const looks = useMemo(() => {
    const out: Record<string, DollhouseLook> = {};
    for (const l of tour.levels) {
      const floors: Record<string, string> = {};
      for (const r of l.plan.rooms) {
        const look = tour.looks[roomKey(l.id, r.id)];
        if (look) floors[r.id] = look.floor;
      }
      out[l.id] = { floors };
    }
    return out;
  }, [tour.levels, tour.looks]);

  const roomPhotos = useCallback(
    (ref: RoomRef) => posed.filter((p) => p.levelId === ref.levelId && p.roomId === ref.roomId),
    [posed],
  );

  // ------------------------------------------------------------------ navigation

  const moveKey = useRef(0);
  const goToPhoto = useCallback(
    (photo: TourPhoto) => {
      if (!photo.pose || !photo.levelId) return;
      const level = levelById.get(photo.levelId)!;
      const eye = toWorld(level, [photo.pose.x, photo.pose.y], photo.pose.height);
      setMode("walk");
      setWalkLevelId(level.id);
      setActivePhotoId(photo.id);
      setActiveRoom(photo.roomId ? { levelId: level.id, roomId: photo.roomId } : null);
      setWalkTarget({
        position: eye.toArray() as [number, number, number],
        yaw: photo.pose.yaw,
        pitch: photo.pose.pitch + framingPitch(photo.pose, photo.height / photo.width),
        fov: vfovOf(photo.pose.hfov, photo.height / photo.width),
        key: ++moveKey.current,
      });
    },
    [levelById],
  );

  const walkIntoRoom = useCallback(
    (ref: RoomRef) => {
      const photos = roomPhotos(ref);
      const best = photos.find((p) => p.confidence === "high") ?? photos[0];
      if (best) return goToPhoto(best);
      const level = levelById.get(ref.levelId)!;
      const room = level.plan.rooms.find((r) => r.id === ref.roomId)!;
      const xs = room.polygon.map((p) => p[0]);
      const ys = room.polygon.map((p) => p[1]);
      const wide = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
      setMode("walk");
      setWalkLevelId(level.id);
      setActivePhotoId(null);
      setActiveRoom(ref);
      setWalkTarget({
        position: toWorld(level, polygonCentroid(room.polygon), EYE_HEIGHT).toArray() as [number, number, number],
        yaw: wide ? 0 : 90,
        key: ++moveKey.current,
      });
    },
    [roomPhotos, goToPhoto, levelById],
  );

  const flyToRoom = useCallback(
    (ref: RoomRef) => {
      const level = levelById.get(ref.levelId)!;
      const room = level.plan.rooms.find((r) => r.id === ref.roomId);
      if (!room) return;
      setActiveRoom(ref);
      setLevelFilter(ref.levelId);
      const c = toWorld(level, polygonCentroid(room.polygon));
      controls.current?.setLookAt(c.x + 1, c.y + 9, c.z + 3.5, c.x, c.y, c.z, true);
    },
    [levelById],
  );

  const showDollhouse = useCallback(() => {
    setMode("dollhouse");
    setActivePhotoId(null);
  }, []);

  const overview = useCallback(() => {
    setActiveRoom(null);
    setLevelFilter(null);
    setActivePhotoId(null);
    if (mode !== "dollhouse") setMode("dollhouse");
    else controls.current?.setLookAt(...overviewView, true);
  }, [mode, overviewView]);

  const onFloorClick = useCallback(
    (level: Level, room: Room, e: ThreeEvent<MouseEvent>) => {
      if (e.delta > 6) return; // a drag, not a click
      const ref = { levelId: level.id, roomId: room.id };
      if (mode === "dollhouse") return flyToRoom(ref);
      // Walk mode: glide to the clicked spot, keep heading.
      setActivePhotoId(null);
      setActiveRoom(ref);
      setWalkTarget({
        position: [e.point.x, level.elevation + EYE_HEIGHT, e.point.z],
        yaw: null,
        key: ++moveKey.current,
      });
    },
    [mode, flyToRoom],
  );

  const stepPhoto = useCallback(
    (dir: 1 | -1) => {
      if (!posed.length) return;
      const i = activePhoto ? posed.indexOf(activePhoto) : -1;
      goToPhoto(posed[(i + dir + posed.length) % posed.length]);
    },
    [posed, activePhoto, goToPhoto],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (lightbox) setLightbox(null);
        else if (mode === "walk") showDollhouse();
      }
      if (mode === "walk" && (e.key === "]" || e.key === "[")) stepPhoto(e.key === "]" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, mode, showDollhouse, stepPhoto]);

  // ------------------------------------------------------------------ labels

  // Only the top visible level is labelled: lower ones are covered by it.
  const labelRooms = useMemo(
    () =>
      mode === "dollhouse"
        ? visibleLevels.slice(-1).flatMap((l) =>
            l.plan.rooms.map((r) => ({ level: l, room: r, anchor: toWorld(l, polygonCentroid(r.polygon), 0.05) })),
          )
        : [],
    [mode, visibleLevels],
  );

  const totalArea = tour.levels.reduce((s, l) => s + interiorArea(l.plan), 0);
  const bedrooms = tour.levels.reduce((s, l) => s + l.plan.rooms.filter((r) => r.type === "bedroom").length, 0);
  const isParsed = tour.levels.some((l) => l.plan.source?.kind === "parsed");
  const thumb = (p: TourPhoto) => (tour.mediaUrl ? `${tour.mediaUrl}/thumb/${p.src}` : null);

  return (
    <div className="relative flex h-dvh w-full flex-col bg-[#f3efe8] md:flex-row">
      <aside className="order-2 flex max-h-[42dvh] flex-col gap-4 overflow-y-auto border-t border-black/10 bg-[#fbf9f5] p-5 md:order-1 md:max-h-none md:w-80 md:border-t-0 md:border-r">
        <Link href="/" className="text-sm font-semibold tracking-tight text-neutral-900">
          gameHome
        </Link>
        <div>
          <p className="text-xs uppercase tracking-[0.14em] text-neutral-500">
            {tour.photos.length ? "Photo tour" : isParsed ? "Parsed from floor plan" : "Demo tour"}
          </p>
          <h1 className="mt-1 text-lg font-semibold leading-snug text-neutral-900">{tour.title}</h1>
          <p className="mt-1 text-sm text-neutral-600">
            {totalArea.toFixed(0)} m² interior · {bedrooms} bedrooms
            {tour.levels.length > 1 ? ` · ${tour.levels.length} levels` : ""}
            {posed.length ? ` · ${posed.length} placed photos` : ""}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-black/5 p-1 text-sm font-medium">
          {(["dollhouse", "walk"] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                if (m === "dollhouse") showDollhouse();
                else if (activeRoom) walkIntoRoom(activeRoom);
                else if (posed[0]) goToPhoto(posed.find((p) => p.confidence === "high") ?? posed[0]);
                else walkIntoRoom({ levelId: tour.levels[0].id, roomId: tour.levels[0].plan.rooms[0].id });
              }}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                mode === m ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-600 hover:text-neutral-900"
              }`}
            >
              {m === "dollhouse" ? "Dollhouse" : "Walk through"}
            </button>
          ))}
        </div>

        {tour.levels.length > 1 && mode === "dollhouse" && (
          <div className="flex flex-wrap gap-1 text-xs font-medium">
            {[null, ...tour.levels.map((l) => l.id)].map((id) => (
              <button
                key={id ?? "all"}
                onClick={() => setLevelFilter(id)}
                className={`rounded-full border px-2.5 py-1 ${
                  levelFilter === id ? "border-neutral-900 bg-neutral-900 text-white" : "border-black/15 text-neutral-700 hover:bg-black/5"
                }`}
              >
                {id ? levelById.get(id)!.name : "All levels"}
              </button>
            ))}
          </div>
        )}

        {(mode === "walk" ? tour.levels.filter((l) => l.id === walkLevelId) : visibleLevels).map((level) => (
          <section key={level.id} className="flex flex-col gap-1">
            {tour.levels.length > 1 && (
              <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">{level.name}</h2>
            )}
            <ul className="flex flex-col gap-1">
              {level.plan.rooms.map((room) => {
                const ref = { levelId: level.id, roomId: room.id };
                const active = activeRoom?.levelId === level.id && activeRoom.roomId === room.id;
                const photos = roomPhotos(ref);
                return (
                  <li key={room.id}>
                    <button
                      onClick={() => (mode === "walk" ? walkIntoRoom(ref) : flyToRoom(ref))}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        active ? "bg-[#c8643b] text-white" : "text-neutral-800 hover:bg-black/5"
                      }`}
                    >
                      <span>
                        {room.name}
                        {photos.length > 0 && (
                          <span className={`ml-1.5 text-xs ${active ? "text-white/80" : "text-neutral-400"}`}>
                            ◉ {photos.length}
                          </span>
                        )}
                      </span>
                      <span className={active ? "text-white/80" : "text-neutral-500"}>
                        {polygonArea(room.polygon).toFixed(1)} m²
                      </span>
                    </button>
                    {active && photos.length > 0 && (
                      <div className="mt-1 grid grid-cols-3 gap-1 px-1">
                        {photos.map((p) => (
                          <PhotoThumb key={p.id} photo={p} src={thumb(p)} active={p.id === activePhotoId} onClick={() => goToPhoto(p)} />
                        ))}
                      </div>
                    )}
                    {active && mode === "dollhouse" && (
                      <button
                        onClick={() => walkIntoRoom(ref)}
                        className="mt-1 ml-1 text-xs font-medium text-[#c8643b] hover:underline"
                      >
                        Walk into {room.name.toLowerCase()} →
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        <button
          onClick={overview}
          className="rounded-lg border border-black/15 px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-black/5"
        >
          Dollhouse overview
        </button>

        {unposed.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
              Not on the floor plans ({unposed.length})
            </h2>
            <div className="grid grid-cols-3 gap-1 px-1">
              {unposed.map((p) => (
                <PhotoThumb key={p.id} photo={p} src={thumb(p)} active={false} onClick={() => setLightbox(p)} />
              ))}
            </div>
          </section>
        )}

        <p className="mt-auto text-xs leading-relaxed text-neutral-500">
          {tour.photos.length
            ? `Rooms read from the floor plans and photos placed by ${tour.model || "a vision model"}. Camera positions are solved from landmarks in each photo.`
            : isParsed
              ? `Geometry read from the floor plan image by ${tour.model || "a vision model"}. Walls are derived from the room outlines.`
              : "Generated from structured floor plan geometry. In the product this comes from the uploaded plan, with photos and video layered on top."}
        </p>
      </aside>

      <div className="relative order-1 min-h-0 flex-1 overflow-hidden md:order-2">
        <Canvas
          shadows
          camera={{ position: overviewView.slice(0, 3) as [number, number, number], fov: 40, near: 0.05 }}
          onPointerMissed={() => mode === "dollhouse" && setActiveRoom(null)}
        >
          <color attach="background" args={["#f3efe8"]} />
          <hemisphereLight args={["#fffaf2", "#d8cfc4", mode === "walk" ? 1.2 : 0.9]} />
          <ambientLight intensity={mode === "walk" ? 0.6 : 0.35} />
          <directionalLight
            position={[center.x + 7, bounds.max.y + 14, center.z + 5]}
            intensity={1.5}
            castShadow={mode === "dollhouse"}
            shadow-mapSize={[2048, 2048]}
            shadow-camera-left={-16}
            shadow-camera-right={16}
            shadow-camera-top={16}
            shadow-camera-bottom={-16}
            shadow-bias={-0.0005}
          >
            <object3D attach="target" position={[center.x, bounds.min.y, center.z]} />
          </directionalLight>

          {mode === "dollhouse" && (
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center.x, bounds.min.y - 0.06, center.z]} receiveShadow>
              <planeGeometry args={[80, 80]} />
              <shadowMaterial opacity={0.12} />
            </mesh>
          )}

          {visibleLevels.map((level) => (
            <group key={level.id} position={[level.offset[0], level.elevation, level.offset[1]]}>
              <Dollhouse
                plan={level.plan}
                activeRoom={mode === "dollhouse" && activeRoom?.levelId === level.id ? activeRoom.roomId : null}
                onFloorClick={(room, e) => onFloorClick(level, room, e)}
                look={looks[level.id]}
                ceilings={mode === "walk"}
              />
            </group>
          ))}

          <Hotspots
            photos={posed.filter((p) => visibleLevels.some((l) => l.id === p.levelId) && p.id !== activePhotoId)}
            levels={levelById}
            onSelect={goToPhoto}
            compact={mode === "walk"}
          />

          {mode === "walk" && activePhoto && tour.mediaUrl && (
            <ProjectedPhoto
              key={activePhoto.id}
              level={levelById.get(activePhoto.levelId!)!}
              plan={levelById.get(activePhoto.levelId!)!.plan}
              photo={activePhoto}
              url={`${tour.mediaUrl}/view/${activePhoto.src}`}
            />
          )}

          {mode === "dollhouse" ? (
            <>
              <CameraControls ref={controls} makeDefault minDistance={3} maxDistance={45} maxPolarAngle={Math.PI / 2.15} />
              <InitialView view={overviewView} />
            </>
          ) : (
            walkTarget && <WalkRig target={walkTarget} bounds={bounds} />
          )}
          <LabelProjector anchors={labelRooms.map((r) => r.anchor)} labels={labelRefs} />
        </Canvas>

        <div className="pointer-events-none absolute inset-0">
          {labelRooms.map(({ level, room }, i) => {
            const active = activeRoom?.levelId === level.id && activeRoom.roomId === room.id;
            return (
              <button
                key={`${level.id}/${room.id}`}
                ref={(el) => {
                  labelRefs.current[i] = el;
                }}
                onClick={() => flyToRoom({ levelId: level.id, roomId: room.id })}
                style={{ visibility: "hidden" }}
                className={`pointer-events-auto absolute top-0 left-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-sm transition-colors will-change-transform ${
                  active ? "border-[#c8643b] bg-[#c8643b] text-white" : "border-black/10 bg-white/90 text-neutral-800 hover:bg-white"
                }`}
              >
                {room.name} · {polygonArea(room.polygon).toFixed(1)} m²
              </button>
            );
          })}
        </div>

        {mode === "walk" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-4">
            {activePhoto ? (
              <div className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-xl bg-white/95 px-4 py-3 text-sm shadow-lg">
                <button onClick={() => stepPhoto(-1)} className="rounded-md px-2 py-1 text-neutral-600 hover:bg-black/5" aria-label="Previous photo">
                  ←
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-neutral-900">{activePhoto.caption}</p>
                  <p className="text-xs text-neutral-500">
                    {posed.indexOf(activePhoto) + 1} / {posed.length} · {activePhoto.location}
                    {activePhoto.confidence === "low" && " · approximate position"}
                  </p>
                </div>
                <button
                  onClick={() => setLightbox(activePhoto)}
                  className="rounded-md border border-black/10 px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-black/5"
                >
                  Photo
                </button>
                <button onClick={() => stepPhoto(1)} className="rounded-md px-2 py-1 text-neutral-600 hover:bg-black/5" aria-label="Next photo">
                  →
                </button>
              </div>
            ) : (
              <p className="rounded-full bg-black/55 px-3 py-1.5 text-xs text-white">
                Drag to look · click the floor to move · WASD / arrows to walk · Esc for dollhouse
              </p>
            )}
          </div>
        )}

        {lightbox && (
          <button
            onClick={() => setLightbox(null)}
            className="absolute inset-0 z-10 flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-black/85 p-6"
          >
            {tour.mediaUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- dev-only fixture media, not optimisable
              <img src={`${tour.mediaUrl}/view/${lightbox.src}`} alt={lightbox.caption} className="max-h-[85%] max-w-full rounded-lg object-contain" />
            )}
            <span className="text-sm text-white/85">{lightbox.caption || lightbox.location}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function PhotoThumb({
  photo,
  src,
  active,
  onClick,
}: {
  photo: TourPhoto;
  src: string | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={photo.caption || photo.location}
      className={`aspect-[4/3] overflow-hidden rounded-md bg-black/10 ring-2 ${active ? "ring-[#c8643b]" : "ring-transparent hover:ring-black/20"}`}
    >
      {src && (
        // eslint-disable-next-line @next/next/no-img-element -- dev-only fixture media, not optimisable
        <img src={src} alt={photo.caption} loading="lazy" className="h-full w-full object-cover" />
      )}
    </button>
  );
}

/** Camera markers at each photo's solved position, pointing the way the photo looks. */
function Hotspots({
  photos,
  levels,
  onSelect,
  compact,
}: {
  photos: TourPhoto[];
  levels: Map<string, Level>;
  onSelect: (p: TourPhoto) => void;
  compact: boolean;
}) {
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    document.body.style.cursor = hover ? "pointer" : "";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hover]);

  return (
    <group>
      {photos.map((p) => {
        const level = levels.get(p.levelId!)!;
        const pos = toWorld(level, [p.pose!.x, p.pose!.y], 0.02);
        const lowConf = p.confidence === "low";
        const scale = (compact ? 0.8 : 1) * (hover === p.id ? 1.25 : 1);
        return (
          <group
            key={p.id}
            position={pos}
            rotation={[0, -(p.pose!.yaw * Math.PI) / 180, 0]}
            scale={scale}
            onClick={(e) => {
              e.stopPropagation();
              if (e.delta <= 6) onSelect(p);
            }}
            onPointerOver={(e) => {
              e.stopPropagation();
              setHover(p.id);
            }}
            onPointerOut={() => setHover((h) => (h === p.id ? null : h))}
          >
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[0.28, 32]} />
              <meshBasicMaterial color="#ffffff" transparent opacity={0.9} depthWrite={false} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
              <ringGeometry args={[0.2, 0.28, 32]} />
              <meshBasicMaterial color={lowConf ? "#9a8f84" : ACCENT} depthWrite={false} />
            </mesh>
            {/* Heading wedge: local +x is the photo's viewing direction. */}
            <mesh rotation={[-Math.PI / 2, 0, -Math.PI / 2]} position={[0.36, 0.003, 0]}>
              <coneGeometry args={[0.1, 0.18, 3]} />
              <meshBasicMaterial color={lowConf ? "#9a8f84" : ACCENT} depthWrite={false} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/** Points the default controls at the plan once they're registered in the R3F store. */
function InitialView({ view }: { view: View }) {
  const ctrl = useThree((s) => s.controls) as CameraControls | null;
  useEffect(() => {
    ctrl?.setLookAt(...view, true);
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
