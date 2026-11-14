/**
 * Photos → one clean product image of an object, the input for 3D generation. A raw crop is never
 * sent to a 3D generator: it is occluded, in perspective and often watermarked.
 *
 * Adapted from https://github.com/apekshik/anyscene (endpoint/props.py), MIT licence: the crop
 * with 15% padding, the crop → clean-reference edit call and the SCAN prompt (word for word).
 * Changed: all views of the object go to the edit call together.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { download, falRunRetry, jpegDataUri } from "@/lib/fal/client";
import type { ObjectBrief } from "./types";

export const REF_EDIT = "openai/gpt-image-2.5/sunburst/edit";
export const REF_T2I = "openai/gpt-image-2.5/sunburst/text-to-image";
export const SCAN =
  "No real-world brand names or logos. Product reference photograph for 3D scanning. The entire object fully " +
  "visible and centered, three-quarter front view from slightly above, plain seamless light-grey background, soft " +
  "even diffuse studio lighting, no harsh shadows, no other objects, no hands, sharp focus, true-to-life materials.";
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

export interface Reference {
  file: string;
  /** fal URL of the image (expires); `file` is the durable copy. */
  url: string;
  source: "photos" | "label";
}

/**
 * The clean product image. `problem` is what was wrong with the last one, added to the prompt.
 * Cached in `dir`: a rerun with the reference already made pays nothing.
 */
export async function cleanReference(brief: ObjectBrief, crops: string[], dir: string, problem?: string, log?: (m: string) => void): Promise<Reference> {
  const file = path.join(dir, "reference.png");
  const meta = path.join(dir, "reference.json");
  if (fs.existsSync(file) && fs.existsSync(meta)) return { ...(JSON.parse(fs.readFileSync(meta, "utf8")) as Reference), file };
  fs.mkdirSync(dir, { recursive: true });
  const details = [brief.color ? `main colour about ${brief.color}` : "", brief.material ? `mostly ${brief.material}` : "", brief.note ?? ""].filter(Boolean).join("; ");
  const fix = problem ? ` The previous attempt was wrong: ${problem}. Avoid that.` : "";
  let url: string;
  let source: Reference["source"];
  if (crops.length) {
    const prompt =
      `Recreate the ${brief.label} shown in these photos as one clean, complete object. ` +
      `They show the same object from different angles. Keep its exact design, colours, materials and condition.` +
      `${details ? ` (${details})` : ""}${fix} ${SCAN}`;
    const images = await Promise.all(crops.map(async (c) => jpegDataUri(fs.readFileSync(c))));
    const { result } = await falRunRetry<{ images: { url: string }[] }>(
      REF_EDIT,
      { image_urls: images, image_size: "square_hd", quality: "high", prompt },
      { pending: path.join(dir, "reference.pending.json"), meta: { kind: "reference", asset: brief.assetId }, log },
    );
    url = result.images[0].url;
    source = "photos";
  } else {
    const prompt = `A ${brief.label}${details ? ` (${details})` : ""}, as found in a lived-in home.${fix} ${SCAN}`;
    const { result } = await falRunRetry<{ images: { url: string }[] }>(
      REF_T2I,
      { prompt, image_size: "square_hd", quality: "high", num_images: 1, output_format: "png" },
      { pending: path.join(dir, "reference.pending.json"), meta: { kind: "reference", asset: brief.assetId }, log },
    );
    url = result.images[0].url;
    source = "label";
  }
  await download(url, file);
  const ref: Reference = { file, url, source };
  fs.writeFileSync(meta, JSON.stringify(ref, null, 2));
  return ref;
}
