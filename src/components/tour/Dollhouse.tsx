import { useMemo } from "react";
import * as THREE from "three";
import { type FloorPlan, type Room, type Wall } from "@/lib/floorplan";
import {
  BALCONY_DROP,
  GLASS_COLOR,
  ROOM_COLORS,
  WALL_COLOR,
  wallBoxes,
  wallFrame,
} from "@/lib/dollhouse-geometry";

function WallMesh({ wall, plan }: { wall: Wall; plan: FloorPlan }) {
  const { length, angle, origin } = wallFrame(wall);
  const boxes = wallBoxes(wall, plan.openings, plan.ceilingHeight, length);
  const windows = plan.openings.filter((o) => o.wallId === wall.id && o.kind === "window");

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
          <meshStandardMaterial color={WALL_COLOR} roughness={0.9} />
        </mesh>
      ))}
      {windows.map((o) => (
        <mesh key={o.id} position={[o.offset + o.width / 2, (o.sill + o.head) / 2, 0]}>
          <boxGeometry args={[o.width, o.head - o.sill, 0.02]} />
          <meshStandardMaterial color={GLASS_COLOR} transparent opacity={0.35} />
        </mesh>
      ))}
    </group>
  );
}

function RoomFloor({
  room,
  active,
  onSelect,
}: {
  room: Room;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const geometry = useMemo(() => {
    const shape = new THREE.Shape(room.polygon.map(([x, y]) => new THREE.Vector2(x, y)));
    return new THREE.ShapeGeometry(shape);
  }, [room.polygon]);

  const isBalcony = room.type === "balcony";

  return (
    <mesh
      geometry={geometry}
      rotation={[Math.PI / 2, 0, 0]}
      position={[0, isBalcony ? -BALCONY_DROP : 0.001, 0]}
      receiveShadow
      onClick={(e) => {
        e.stopPropagation();
        onSelect(room.id);
      }}
    >
      <meshStandardMaterial
        color={active ? "#c8643b" : ROOM_COLORS[room.type]}
        side={THREE.DoubleSide}
        roughness={0.95}
      />
    </mesh>
  );
}

export function Dollhouse({
  plan,
  activeRoom,
  onSelectRoom,
}: {
  plan: FloorPlan;
  activeRoom: string | null;
  onSelectRoom: (id: string) => void;
}) {
  return (
    <group>
      {plan.rooms.map((room) => (
        <RoomFloor
          key={room.id}
          room={room}
          active={room.id === activeRoom}
          onSelect={onSelectRoom}
        />
      ))}
      {plan.walls.map((wall) => (
        <WallMesh key={wall.id} wall={wall} plan={plan} />
      ))}
    </group>
  );
}
