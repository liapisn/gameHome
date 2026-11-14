import fs from "node:fs/promises";
import type { NextRequest } from "next/server";
import sharp from "sharp";
import { canServeMedia, tourMediaPath, tourOriginalPath } from "@/lib/tours";

const WIDTH = { view: 2048, thumb: 480 } as const;

/**
 * Serves resized tour photos from fixtures/<listing>/.derived/{view,thumb}/ in dev, and for fixture
 * tours a protected preview opted in (lib/internal-fixtures), resizing the original when the
 * derived copy isn't deployed. Fixture media is third-party and is never served in production.
 */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/tour-media/[tour]/[...path]">) {
  const { tour, path } = await ctx.params;
  if (!canServeMedia(tour)) return new Response("Not found", { status: 404 });
  const headers = { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" };
  const file = tourMediaPath(tour, path);
  if (file) return new Response(new Uint8Array(await fs.readFile(file)), { headers });
  const original = tourOriginalPath(tour, path);
  if (!original) return new Response("Not found", { status: 404 });
  const width = WIDTH[path[0] as keyof typeof WIDTH];
  const jpeg = await sharp(original).rotate().resize(width, undefined, { withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return new Response(new Uint8Array(jpeg), { headers });
}
