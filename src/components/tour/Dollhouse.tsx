import { useMemo } from "react";
import * as THREE from "three";
import {
  type FloorPlan,
  type Opening,
  type Room,
  type RoomType,
  type Wall,
} from "@/lib/floorplan";

const ROOM_COLORS: Record<RoomType, string> = {
  living: "#e9dcc6",
  kitchen: "#e9dcc6",
  bedroom: "#d9e2d3",
  bathroom: "#d3e0e6",
  hallway: "#e6e1d9",
  balcony: "#c9bba8",
  storage: "#e1ddd6",
};

const WALL_COLOR = "#f7f4ee";
const GLASS_COLOR = "#a9c7d6";

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Split a wall into solid boxes (in wall-local coords) around its openings. */
function wallBoxes(wall: Wall, openings: Opening[], height: number, length: number): Box[] {
  const ext = wall.thickness / 2;
  const ops = openings
    .filter((o) => o.wallId === wall.id)
    .sort((p, q) => p.offset - q.offset);

  const boxes: Box[] = [];
  let cursor = -ext;
  for (const o of ops) {
    const start = o.offset;
    const end = o.offset + o.width;
    if (start > cursor) boxes.push({ x0: cursor, x1: start, y0: 0, y1: height });
    if (o.sill > 0) boxes.push({ x0: start, x1: end, y0: 0, y1: o.sill });
    if (o.head < height) boxes.push({ x0: start, x1: end, y0: o.head, y1: height });
    cursor = end;
  }
  if (cursor < length + ext) boxes.push({ x0: cursor, x1: length + ext, y0: 0, y1: height });
  return boxes;
}

function WallMesh({ wall, plan }: { wall: Wall; plan: FloorPlan }) {
  const [ax, ay] = wall.a;
  const [bx, by] = wall.b;
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  const angle = -Math.atan2(dy, dx);
  const boxes = wallBoxes(wall, plan.openings, plan.ceilingHeight, length);
  const windows = plan.openings.filter((o) => o.wallId === wall.id && o.kind === "window");

  return (
    <group position={[ax, 0, ay]} rotation={[0, angle, 0]}>
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
      position={[0, isBalcony ? -0.05 : 0.001, 0]}
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
