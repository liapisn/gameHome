import { useState } from "react";
import { type FloorPlan, type RoomType, ROOM_TYPES, polygonArea, polygonCentroid } from "@/lib/floorplan";

export const ROOM_TYPE_LABEL: Record<RoomType, string> = {
  living: "Living room",
  kitchen: "Kitchen",
  dining: "Dining room",
  bedroom: "Bedroom",
  bathroom: "Bathroom",
  hallway: "Hallway / entry",
  office: "Office",
  storage: "Storage",
  stairs: "Stairs",
  balcony: "Balcony / terrace",
};

/** One fill per kind of room, so the drawing reads at a glance. */
const ROOM_FILL: Record<RoomType, string> = {
  living: "#dbeafe",
  kitchen: "#fde68a",
  dining: "#fed7aa",
  bedroom: "#e9d5ff",
  bathroom: "#a7f3d0",
  hallway: "#e5e7eb",
  office: "#fbcfe8",
  storage: "#d6d3d1",
  stairs: "#cbd5e1",
  balcony: "#d9f99d",
};

/**
 * The rooms the engine read from a floor plan: a drawing of their outlines and a list to correct
 * each room's name and kind. Hovering either highlights the room in both.
 */
export function PlanRooms({
  plan,
  onRename,
  onRetype,
}: {
  plan: FloorPlan;
  onRename: (roomId: string, name: string) => void;
  onRetype: (roomId: string, type: RoomType) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const pts = plan.rooms.flatMap((r) => r.polygon);
  const x0 = Math.min(...pts.map((p) => p[0]));
  const y0 = Math.min(...pts.map((p) => p[1]));
  const w = Math.max(...pts.map((p) => p[0])) - x0;
  const h = Math.max(...pts.map((p) => p[1])) - y0;
  const pad = Math.max(w, h) * 0.04;
  // Labels sized to the plan, in metres.
  const font = Math.max(w, h) / 38;

  return (
    <div className="grid gap-3">
      <svg
        viewBox={`${x0 - pad} ${y0 - pad} ${w + 2 * pad} ${h + 2 * pad}`}
        className="w-full rounded-lg border border-black/10 bg-white"
        role="img"
        aria-label={`Rooms read from the plan: ${plan.rooms.map((r) => r.name).join(", ")}`}
      >
        {plan.rooms.map((r) => (
          <polygon
            key={r.id}
            points={r.polygon.map((p) => p.join(",")).join(" ")}
            fill={ROOM_FILL[r.type]}
            stroke="#171717"
            strokeWidth={active === r.id ? font * 0.35 : font * 0.12}
            strokeLinejoin="round"
            opacity={active && active !== r.id ? 0.45 : 1}
            onMouseEnter={() => setActive(r.id)}
            onMouseLeave={() => setActive(null)}
          />
        ))}
        {plan.rooms.map((r) => {
          const [cx, cy] = polygonCentroid(r.polygon);
          return (
            <text key={r.id} x={cx} y={cy} fontSize={font} textAnchor="middle" dominantBaseline="central" fill="#171717" pointerEvents="none">
              {r.name}
            </text>
          );
        })}
      </svg>

      <ul className="divide-y divide-black/5 rounded-lg border border-black/10 bg-white">
        {plan.rooms.map((r) => (
          <li
            key={`${r.id}-${r.name}-${r.type}`}
            className={`flex flex-wrap items-center gap-2 px-2 py-1.5 ${active === r.id ? "bg-black/5" : ""}`}
            onMouseEnter={() => setActive(r.id)}
            onMouseLeave={() => setActive(null)}
          >
            <span aria-hidden className="h-3 w-3 shrink-0 rounded-sm border border-black/20" style={{ background: ROOM_FILL[r.type] }} />
            <input
              defaultValue={r.name}
              aria-label={`Name of ${r.name}`}
              maxLength={60}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name && name !== r.name) onRename(r.id, name);
                else e.target.value = r.name;
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-sm hover:border-black/10 focus:border-neutral-900 focus:outline-none"
            />
            <select
              value={r.type}
              aria-label={`Kind of room for ${r.name}`}
              onChange={(e) => onRetype(r.id, e.target.value as RoomType)}
              className="rounded-md border border-black/10 bg-white px-1.5 py-0.5 text-xs"
            >
              {ROOM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ROOM_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <span className="w-24 text-right text-xs tabular-nums text-neutral-500">
              {r.labeled ? `${r.labeled.width.toFixed(2)} × ${r.labeled.depth.toFixed(2)} m` : `${polygonArea(r.polygon).toFixed(1)} m²`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
