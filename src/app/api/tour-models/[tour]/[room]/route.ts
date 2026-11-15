import fs from "node:fs/promises";
import type { NextRequest } from "next/server";
import { localRoomModelPath } from "@/lib/tours";

/**
 * Dev only: a room's generated furniture (exports/<tour>/models/rooms/<level>-<room>/room-web.glb,
 * made by npm run build:models). exports/ is never deployed; built tours in the app serve their
 * models from Storage instead (models.json).
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/tour-models/[tour]/[room]">) {
  const { tour, room } = await ctx.params;
  const file = localRoomModelPath(tour, room);
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(await fs.readFile(file)), { headers: { "Content-Type": "model/gltf-binary", "Cache-Control": "no-store" } });
}
