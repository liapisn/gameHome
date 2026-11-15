import "server-only";
import { z } from "zod";
import { type Point, type RoomType, polygonArea, polygonCentroid } from "@/lib/floorplan";
import type { ParsedPlan } from "@/lib/floorplan-parser/schema";

/**
 * Reads a Matterport 3D tour (the "3D space" on some Prosperty listings) through the GraphQL
 * endpoint Matterport's own Showcase viewer uses. It's public but undocumented: the schema below
 * fails loudly if it changes, and the import then carries on without the tour.
 *
 * From a tour we take, per floor: the measured room outlines with their doors and windows (so
 * the plan needs no model read), Matterport's rendered floor plan as the drawing, and the 360°
 * panoramas, whose four side faces of the cube map are level 90° photos of a known room.
 */
const GRAPH = "https://my.matterport.com/api/mp/models/graph";

/** Matterport serves tour files from these hosts only; no other URL is fetched. */
export const isMatterportAsset = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && /^cdn-\d+\.matterport\.com$/.test(url.hostname);
  } catch {
    return false;
  }
};

/** The model id of a Matterport link (`my.matterport.com/show/?m=ejXQrTQc8Sq`), or null. */
export function matterportModelId(link: string | null | undefined): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    if (url.hostname !== "matterport.com" && !url.hostname.endsWith(".matterport.com")) return null;
    const m = url.searchParams.get("m");
    return m && /^[A-Za-z0-9]{8,16}$/.test(m) ? m : null;
  } catch {
    return null;
  }
}

const QUERY = `query($m: ID!) { model(id: $m) {
  floors { sequence rooms {
    label classifications { label }
    dimensions { height }
    boundary { edges { id vertices { id position { x y } } openings { type width relativeCenter } } }
    panoLocations { position { x y } skyboxes { resolution status urlTemplate } }
  } }
  assets { floorplans { flags format url } }
} }`;

const XY = z.object({ x: z.number(), y: z.number() });
const Model = z.object({
  data: z.object({
    model: z
      .object({
        floors: z.array(
          z.object({
            sequence: z.number(),
            rooms: z.array(
              z.object({
                label: z.string().nullish(),
                classifications: z.array(z.object({ label: z.string() })).nullish(),
                dimensions: z.object({ height: z.number().nullish() }).nullish(),
                boundary: z
                  .object({
                    edges: z.array(
                      z.object({
                        id: z.string(),
                        vertices: z.array(z.object({ id: z.string(), position: XY })),
                        openings: z
                          .array(z.object({ type: z.string(), width: z.number(), relativeCenter: z.number() }))
                          .nullish(),
                      }),
                    ),
                  })
                  .nullish(),
                panoLocations: z
                  .array(
                    z.object({
                      position: XY,
                      skyboxes: z.array(z.object({ resolution: z.string(), status: z.string(), urlTemplate: z.string() })),
                    }),
                  )
                  .nullish(),
              }),
            ),
          }),
        ),
        assets: z.object({
          floorplans: z.array(z.object({ flags: z.array(z.string()), format: z.string(), url: z.string() })).nullish(),
        }),
      })
      .nullable(),
  }),
});

export interface MatterportPhoto {
  url: string;
  /** Index into the floor's plan rooms: the built plan's room id is `r${roomIndex}`. */
  roomIndex: number;
}

export interface MatterportFloor {
  /** Rooms and openings in plan space (meters, y down), ready for buildFloorPlan. */
  parsed: ParsedPlan;
  ceilingHeight: number;
  /** Matterport's rendered plan of this floor, with room names and measurements, or null. */
  drawingUrl: string | null;
  photos: MatterportPhoto[];
}

const TYPES: [RegExp, RoomType][] = [
  [/kitchen/i, "kitchen"],
  [/dining/i, "dining"],
  [/living|family|lounge|den|great room/i, "living"],
  [/bed|nursery/i, "bedroom"],
  [/bath|toilet|wc|shower|powder/i, "bathroom"],
  [/hall|corridor|entr|foyer|lobby/i, "hallway"],
  [/office|study|library/i, "office"],
  [/stair/i, "stairs"],
  [/balcon|terrace|patio|porch|deck|veranda|outdoor|yard|garden/i, "balcony"],
  [/closet|storage|laundry|utility|pantry|garage|basement|attic|boiler/i, "storage"],
];

const roomType = (label: string): RoomType => TYPES.find(([re]) => re.test(label))?.[1] ?? "storage";

/** Plan space is y down (lib/floorplan); Matterport's floor plane is y up. */
const toPlan = (p: { x: number; y: number }): Point => [p.x, -p.y];

/** A room's outline from its boundary edges, which come unordered: walk them vertex to vertex. Null if they don't form one loop. */
function outline(edges: { vertices: { id: string; position: { x: number; y: number } }[] }[]): Point[] | null {
  const next = new Map<string, string[]>();
  const at = new Map<string, Point>();
  for (const { vertices } of edges) {
    if (vertices.length !== 2) return null;
    const [a, b] = vertices;
    at.set(a.id, toPlan(a.position));
    at.set(b.id, toPlan(b.position));
    next.set(a.id, [...(next.get(a.id) ?? []), b.id]);
    next.set(b.id, [...(next.get(b.id) ?? []), a.id]);
  }
  if (next.size < 3 || [...next.values()].some((n) => n.length !== 2)) return null;
  const start = next.keys().next().value!;
  const loop = [start];
  let prev = start;
  let cur = next.get(start)![0];
  while (cur !== start) {
    loop.push(cur);
    const [a, b] = next.get(cur)!;
    [prev, cur] = [cur, a === prev ? b : a];
  }
  return loop.length === next.size ? loop.map((id) => at.get(id)!) : null;
}

/** Photos per room from its panoramas: one, or two far apart in a large room. */
function pickPanos<T extends { position: { x: number; y: number } }>(panos: T[], polygon: Point[]): T[] {
  if (!panos.length) return [];
  const dist = (p: T, q: Point) => Math.hypot(toPlan(p.position)[0] - q[0], toPlan(p.position)[1] - q[1]);
  const centre = polygonCentroid(polygon);
  const first = [...panos].sort((a, b) => dist(a, centre) - dist(b, centre))[0];
  if (panos.length < 2 || polygonArea(polygon) < 15) return [first];
  const second = [...panos].sort((a, b) => dist(b, toPlan(first.position)) - dist(a, toPlan(first.position)))[0];
  return [first, second];
}

/** The four side faces of a pano's cube map (0 is the ceiling, 5 the floor), at the best resolution offered. */
function sideFaces(skyboxes: { resolution: string; status: string; urlTemplate: string }[]): string[] {
  const ready = skyboxes.filter((s) => s.status === "available");
  const best = ["2k", "high"].map((r) => ready.find((s) => s.resolution === r)).find(Boolean);
  return best ? [1, 2, 3, 4].map((face) => best.urlTemplate.replace("<face>", String(face))).filter(isMatterportAsset) : [];
}

/** The floor's drawing: the measured metric plan if there is one, else the coloured one. */
function drawingFor(plans: { flags: string[]; format: string; url: string }[], sequence: number): string | null {
  const suffix = `_${String(sequence).padStart(3, "0")}.`;
  const file = (u: string) => new URL(u).pathname.split("/").pop() ?? "";
  const ours = plans.filter((p) => p.format === "jpg" && isMatterportAsset(p.url) && file(p.url).includes(suffix));
  for (const name of ["measureplan_metric_room", "colorplan_room", "colorplan"]) {
    const hit = ours.find((p) => file(p.url).startsWith(`${name}_`));
    if (hit) return hit.url;
  }
  return null;
}

/** The tour's floors, lowest first. Throws if Matterport can't be reached or answers in another format. */
export async function fetchMatterportModel(modelId: string): Promise<MatterportFloor[]> {
  const res = await fetch(GRAPH, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { m: modelId } }),
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Matterport answered ${res.status}.`);
  const parsed = Model.safeParse(await res.json());
  if (!parsed.success) throw new Error("Matterport's tour format has changed; the importer needs updating.");
  const model = parsed.data.data.model;
  if (!model) throw new Error("This 3D tour is no longer available.");

  return [...model.floors]
    .sort((a, b) => a.sequence - b.sequence)
    .map((floor): MatterportFloor => {
      const warnings: string[] = [];
      const rooms: ParsedPlan["rooms"] = [];
      const openings: ParsedPlan["openings"] = [];
      const photos: MatterportPhoto[] = [];
      const seenOpenings = new Set<string>();
      const heights: number[] = [];

      for (const room of floor.rooms) {
        const label = room.label?.trim() || room.classifications?.[0]?.label || "Room";
        const polygon = room.boundary ? outline(room.boundary.edges) : null;
        if (!polygon) {
          warnings.push(`Skipped "${label}": its outline isn't one closed loop.`);
          continue;
        }
        const roomIndex = rooms.length;
        rooms.push({
          name: label,
          type: roomType(room.classifications?.[0]?.label ?? label),
          labeledWidth: null,
          labeledDepth: null,
          polygon: polygon.map(([x, y]) => ({ x, y })),
        });
        if (room.dimensions?.height) heights.push(room.dimensions.height);

        // A shared wall's doors are listed by both rooms it separates: keep each once.
        for (const edge of room.boundary!.edges) {
          const [a, b] = edge.vertices.map((v) => toPlan(v.position));
          for (const o of edge.openings ?? []) {
            const key = `${edge.id}:${o.relativeCenter.toFixed(3)}`;
            if (seenOpenings.has(key)) continue;
            seenOpenings.add(key);
            openings.push({
              kind: o.type === "window" ? "window" : o.type === "door" ? "door" : "opening",
              x: a[0] + (b[0] - a[0]) * o.relativeCenter,
              y: a[1] + (b[1] - a[1]) * o.relativeCenter,
              width: o.width,
              note: `${label} (Matterport ${o.type})`,
            });
          }
        }

        for (const pano of pickPanos(room.panoLocations ?? [], polygon)) {
          for (const url of sideFaces(pano.skyboxes)) photos.push({ url, roomIndex });
        }
      }

      const ceilingHeight = heights.length ? Math.round((heights.reduce((s, h) => s + h, 0) / heights.length) * 100) / 100 : 2.7;
      return {
        parsed: { levelName: `Floor ${floor.sequence + 1}`, scaleMethod: "printed_dimensions", rooms, openings, warnings },
        ceilingHeight: Math.min(4, Math.max(2.2, ceilingHeight)),
        drawingUrl: drawingFor(model.assets.floorplans ?? [], floor.sequence),
        photos,
      };
    })
    .filter((f) => f.parsed.rooms.length > 0);
}
