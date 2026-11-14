/** Each view of an object cropped out of its photo: what the object worker and its critic look at. */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { ObjectBrief } from "./types";

/** Most views sent per object: the largest ones carry the most detail. */
const MAX_VIEWS = 4;

/** Crop each view with 15% padding (largest first), as JPEG files in `<workDir>/crops/`. */
export async function cropViews(brief: ObjectBrief): Promise<string[]> {
  const dir = path.join(brief.workDir, "crops");
  fs.mkdirSync(dir, { recursive: true });
  const area = (b: number[]) => (b[2] - b[0]) * (b[3] - b[1]);
  const views = [...brief.views].sort((a, b) => area(b.box) - area(a.box)).slice(0, MAX_VIEWS);
  const out: string[] = [];
  for (const [i, v] of views.entries()) {
    const file = path.join(dir, `${i}-${v.photoId}.jpg`);
    if (!fs.existsSync(file)) {
      // Size as displayed: EXIF orientations 5–8 swap width and height.
      const m = await sharp(v.photoFile).metadata();
      const [W, H] = (m.orientation ?? 1) >= 5 ? [m.height!, m.width!] : [m.width!, m.height!];
      const [y0, x0, y1, x1] = v.box.map((n) => n / 1000);
      const px = 0.15 * (x1 - x0);
      const py = 0.15 * (y1 - y0);
      const left = Math.max(0, Math.floor((x0 - px) * W));
      const top = Math.max(0, Math.floor((y0 - py) * H));
      const width = Math.max(8, Math.min(W, Math.ceil((x1 + px) * W)) - left);
      const height = Math.max(8, Math.min(H, Math.ceil((y1 + py) * H)) - top);
      await sharp(v.photoFile).rotate().extract({ left, top, width, height }).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toFile(file);
    }
    out.push(file);
  }
  return out;
}
