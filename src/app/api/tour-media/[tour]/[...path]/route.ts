import fs from "node:fs/promises";
import type { NextRequest } from "next/server";
import { tourMediaPath } from "@/lib/tours";

/**
 * Dev-only: serves resized tour photos from fixtures/<listing>/.derived/{view,thumb}/.
 * Fixture media is third-party and must never be served in production.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/tour-media/[tour]/[...path]">) {
  if (process.env.NODE_ENV === "production") return new Response("Not found", { status: 404 });
  const { tour, path } = await ctx.params;
  const file = tourMediaPath(tour, path);
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(await fs.readFile(file)), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
  });
}
