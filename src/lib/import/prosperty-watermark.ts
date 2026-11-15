import "server-only";
import sharp from "sharp";
import { PROSPERTY_WATERMARK_MASK_PNG } from "@/lib/import/prosperty-watermark-mask";

/*
 * Prosperty stamps its logo on most listing photos: a flat white graphic, centred, scaled with
 * the photo's width, alpha-blended at about 22% opacity. Because the logo is the same on every
 * photo we can undo it exactly rather than paint over it:
 *
 *   observed = (1 - a)·original + a·255   ⇒   original = (observed - 255a) / (1 - a)
 *
 * where a = mask × opacity. The mask (prosperty-watermark-mask.ts) was estimated once from a
 * stack of ~70 watermarked photos. Each photo is first checked for the logo; photos without one
 * (some listings have none) come back untouched, and so do very bright photos where there is
 * too little dark background around the logo to be sure it's there.
 *
 * Tuned on fixtures/ (listings 15970 and 8218 are watermarked, 16841 is not): watermarked photos
 * score a strength of 0.14–0.32, clean ones at most 0.09.
 */

/** The mask is drawn for a photo this wide; it scales with the photo's width. */
const MASK_REF_WIDTH = 2560;
const MASK_WIDTH = 1200;
const MASK_HEIGHT = 360;
/** The logo's opacity, the same on every photo. */
const OPACITY = 0.22;
/** Logo evidence below this means "no Prosperty logo here". */
const MIN_STRENGTH = 0.12;
/** Only edge pairs whose outside pixel is darker than this say anything about the logo. */
const DARK_ENOUGH = 170;
/** Fewest such pairs (at the mask's reference size) needed to judge whether the logo is there. */
const MIN_EDGE_PAIRS = 1500;

export interface RawImage {
  data: Buffer;
  info: { width: number; height: number; channels: 3 };
}

/** The mask scaled for a photo `width` px wide, as 0..1 values. */
async function maskFor(width: number): Promise<{ mask: Float32Array; w: number; h: number }> {
  const scale = width / MASK_REF_WIDTH;
  const w = Math.round(MASK_WIDTH * scale);
  const h = Math.round(MASK_HEIGHT * scale);
  const data = await sharp(Buffer.from(PROSPERTY_WATERMARK_MASK_PNG, "base64"))
    .resize(w, h, { fit: "fill" })
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  return { mask: Float32Array.from(data, (v) => v / 255), w, h };
}

/**
 * Decode a Prosperty photo (EXIF-rotated, 3-channel) and remove the logo if it carries one.
 * `removed` says whether it did; when false the image is the photo as it came.
 */
export async function removeProspertyWatermark(input: Buffer): Promise<{ image: RawImage; removed: boolean }> {
  const { data, info } = await sharp(input)
    .rotate()
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image: RawImage = { data, info: { width: info.width, height: info.height, channels: 3 } };
  const { width, height } = image.info;

  const { mask, w, h } = await maskFor(width);
  if (h > height) return { image, removed: false };
  const left = Math.round((width - w) / 2);
  const top = Math.round((height - h) / 2);
  const px = (x: number, y: number) => ((top + y) * width + left + x) * 3;
  const scale = width / MASK_REF_WIDTH;

  // Is the logo there? At the logo's edge a pixel just inside is lifted towards white by
  // a·(255 - outside) over its neighbour just outside. Fit a by least squares over the edge pairs
  // (weighting dark backgrounds, where the lift is visible), then do the same with the mask
  // moved up and down to where there is no logo: ordinary image edges score about the same
  // anywhere, the logo only where it is.
  const step = Math.max(1, Math.round(5 * scale));
  const fit = (dy: number): number | null => {
    if (top + dy < 0 || top + dy + h > height) return null;
    const lum = (x: number, y: number) => {
      const i = px(x, y + dy);
      return (data[i] + data[i + 1] + data[i + 2]) / 3;
    };
    let lift = 0;
    let headroom = 0;
    let pairs = 0;
    for (let y = 0; y < h; y++) {
      for (let x = step; x < w - step; x++) {
        if (mask[y * w + x] <= 0.98) continue;
        for (const d of [step, -step]) {
          if (mask[y * w + x + d] >= 0.02) continue;
          const outside = lum(x + d, y);
          if (outside >= DARK_ENOUGH) continue;
          lift += (lum(x, y) - outside) * (255 - outside);
          headroom += (255 - outside) ** 2;
          pairs++;
        }
      }
    }
    return pairs >= MIN_EDGE_PAIRS * scale ** 2 ? lift / headroom : null;
  };
  const here = fit(0);
  const elsewhere = [-400, -200, 200, 400].map((dy) => fit(Math.round(dy * scale))).filter((v) => v != null);
  if (here == null || !elsewhere.length) return { image, removed: false };
  const strength = here - elsewhere.reduce((s, v) => s + v, 0) / elsewhere.length;
  if (strength < MIN_STRENGTH) return { image, removed: false };

  // Reverse the blend under the logo.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = mask[y * w + x] * OPACITY;
      if (a <= 0) continue;
      const i = px(x, y);
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(Math.min(255, Math.max(0, (data[i + c] - 255 * a) / (1 - a))));
    }
  }

  // Resizing and re-encoding soften the logo's edge, which leaves a faint hairline after the
  // reversal. Replace a thin band along the edge with the local median of the cleaned photo.
  const crop = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) data.copy(crop, y * w * 3, px(0, y), px(0, y) + w * 3);
  const kernel = Math.max(3, Math.round(7 * scale) | 1);
  const smoothed = await sharp(crop, { raw: { width: w, height: h, channels: 3 } }).median(kernel).raw().toBuffer();
  const edge = Buffer.from(mask.map((v) => (v > 0.03 && v < 0.97 ? 255 : 0)));
  const band = await sharp(edge, { raw: { width: w, height: h, channels: 1 } })
    .dilate(Math.max(1, Math.round(2 * scale)))
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  for (let p = 0; p < w * h; p++) {
    if (!band[p]) continue;
    const i = px(p % w, Math.floor(p / w));
    for (let c = 0; c < 3; c++) data[i + c] = smoothed[p * 3 + c];
  }

  return { image, removed: true };
}
