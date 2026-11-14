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
import { download, falRunRetry, jpegDataUri } from "@/lib/fal/client";
import type { ObjectBrief } from "./types";

export { cropViews } from "./crops";

export const REF_EDIT = "openai/gpt-image-2.5/sunburst/edit";
export const REF_T2I = "openai/gpt-image-2.5/sunburst/text-to-image";
export const SCAN =
  "No real-world brand names or logos. Product reference photograph for 3D scanning. The entire object fully " +
  "visible and centered, three-quarter front view from slightly above, plain seamless light-grey background, soft " +
  "even diffuse studio lighting, no harsh shadows, no other objects, no hands, sharp focus, true-to-life materials.";
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
