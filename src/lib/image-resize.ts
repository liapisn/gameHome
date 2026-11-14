/**
 * Browser-side image preparation: decode any supported image, scale it down, and
 * re-encode as WebP. Keeps uploads small (and inside the free storage tier) while
 * staying sharp enough for the 3D engine.
 */

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
}

export const ACCEPTED_IMAGE_TYPES = "image/jpeg,image/png,image/webp,image/heic,image/heif";

async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    // Respect EXIF orientation so phone photos aren't sideways.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This browser can't read that image. Use JPEG, PNG or WebP (iPhone HEIC works in Safari).");
  }
}

function encode(bitmap: ImageBitmap, maxSide: number, quality: number): Promise<PreparedImage> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);

  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve({ blob, width, height }) : reject(new Error("Could not encode the image."))),
      "image/webp",
      quality,
    ),
  );
}

/** A photo at up to 2560 px plus a 480 px thumbnail for the admin grid. */
export async function preparePhoto(file: File): Promise<{ full: PreparedImage; thumb: PreparedImage }> {
  const bitmap = await decode(file);
  try {
    const full = await encode(bitmap, 2560, 0.85);
    const thumb = await encode(bitmap, 480, 0.75);
    return { full, thumb };
  } finally {
    bitmap.close();
  }
}

/** Floor plans keep more resolution so printed dimensions stay legible for the parser. */
export async function prepareFloorplan(file: File): Promise<PreparedImage> {
  const bitmap = await decode(file);
  try {
    return await encode(bitmap, 4096, 0.92);
  } finally {
    bitmap.close();
  }
}
