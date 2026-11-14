import { useMemo } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { type FloorPlan, type Room, type RoomType, type Wall } from "@/lib/floorplan";
import {
  BALCONY_DROP,
  CEILING_COLOR,
  GLASS_COLOR,
  ROOM_COLORS,
  WALL_COLOR,
  wallBoxes,
  wallFrame,
} from "@/lib/dollhouse-geometry";
import { type FloorFinish, floorTexture } from "./textures";

/** Staged floors: a finish per room type, tinted with a realistic base color. */
const STAGED_FLOORS: Record<RoomType, { finish: FloorFinish; color: string }> = {
  living: { finish: "wood", color: "#d6ad80" },
  dining: { finish: "wood", color: "#d6ad80" },
  bedroom: { finish: "wood", color: "#dcb98f" },
  office: { finish: "wood", color: "#d6ad80" },
  hallway: { finish: "wood", color: "#d6ad80" },
  stairs: { finish: "wood", color: "#c99e72" },
  kitchen: { finish: "tile", color: "#e4ded4" },
  bathroom: { finish: "tile", color: "#dfe4e6" },
  balcony: { finish: "terracotta", color: "#cf9270" },
  storage: { finish: "concrete", color: "#cfcac2" },
};

export interface DollhouseLook {
  /** Floor color per room id, e.g. sampled from the room's photos. */
  floors?: Record<string, string>;
  walls?: string;
}

function WallMesh({ wall, plan, color, glass }: { wall: Wall; plan: FloorPlan; color: string; glass: boolean }) {
  const { length, angle, origin } = wallFrame(wall);
  const boxes = wallBoxes(wall, plan.openings, plan.ceilingHeight, length);
  const windows = glass ? plan.openings.filter((o) => o.wallId === wall.id && o.kind === "window") : [];

  return (
    <group position={origin} rotation={[0, angle, 0]}>
      {boxes.map((b, i) => (
        <mesh
          key={i}
          position={[(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[b.x1 - b.x0, b.y1 - b.y0, wall.thickness]} />
          <meshStandardMaterial color={color} roughness={0.9} />
        </mesh>
      ))}
      {windows.map((o) => (
        <mesh key={o.id} position={[o.offset + o.width / 2, (o.sill + o.head) / 2, 0]}>
          <boxGeometry args={[o.width, o.head - o.sill, 0.02]} />
          <meshStandardMaterial color={GLASS_COLOR} transparent opacity={0.35} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

function useRoomShape(room: Room) {
  return useMemo(() => {
    const shape = new THREE.Shape(room.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
    return new THREE.ShapeGeometry(shape);
  }, [room.polygon]);
}

function RoomFloor({
  room,
  color,
  active,
  onClick,
  finish,
}: {
  room: Room;
  color: string;
  active: boolean;
  onClick?: (room: Room, e: ThreeEvent<MouseEvent>) => void;
  finish?: FloorFinish;
}) {
  const geometry = useRoomShape(room);
  const isBalcony = room.type === "balcony";
  const map = useMemo(() => (finish ? floorTexture(finish) : null), [finish]);

  return (
    <mesh
      geometry={geometry}
      rotation={[Math.PI / 2, 0, 0]}
      position={[0, isBalcony ? -BALCONY_DROP : 0.001, 0]}
      receiveShadow
      userData={{ floor: true, roomId: room.id }}
      onClick={
        onClick &&
        ((e) => {
          e.stopPropagation();
          onClick(room, e);
        })
      }
    >
      <meshStandardMaterial
        color={active ? "#c8643b" : color}
        map={map}
        side={THREE.DoubleSide}
        roughness={0.95}
      />
    </mesh>
  );
}

function RoomCeiling({ room, height }: { room: Room; height: number }) {
  const geometry = useRoomShape(room);
  return (
    <mesh geometry={geometry} rotation={[Math.PI / 2, 0, 0]} position={[0, height, 0]}>
      <meshStandardMaterial color={CEILING_COLOR} side={THREE.DoubleSide} roughness={0.95} />
    </mesh>
  );
}

export function Dollhouse({
  plan,
  activeRoom,
  onFloorClick,
  look,
  ceilings = false,
  staged = false,
}: {
  plan: FloorPlan;
  activeRoom: string | null;
  onFloorClick?: (room: Room, e: ThreeEvent<MouseEvent>) => void;
  look?: DollhouseLook;
  /** Close the rooms off for walk mode. */
  ceilings?: boolean;
  /** Textured, realistic floors to go with staged furniture. */
  staged?: boolean;
}) {
  // Inside the house glass panes only tint the projected photos, so walk mode leaves them out.
  const glass = !ceilings;
  return (
    <group>
      {plan.rooms.map((room) => (
        <RoomFloor
          key={room.id}
          room={room}
          color={look?.floors?.[room.id] ?? (staged ? STAGED_FLOORS[room.type].color : ROOM_COLORS[room.type])}
          finish={staged ? STAGED_FLOORS[room.type].finish : undefined}
          active={room.id === activeRoom}
          onClick={onFloorClick}
        />
      ))}
      {ceilings &&
        plan.rooms
          .filter((r) => r.type !== "balcony")
          .map((room) => <RoomCeiling key={room.id} room={room} height={plan.ceilingHeight} />)}
      {plan.walls.map((wall) => (
        <WallMesh key={wall.id} wall={wall} plan={plan} color={look?.walls ?? WALL_COLOR} glass={glass} />
      ))}
    </group>
  );
}
