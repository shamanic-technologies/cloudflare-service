import sharp from "sharp";

/**
 * Email-targeted image optimisation.
 *
 * An image destined for an email body is fetched by the recipient's mail client
 * directly from its public URL, with no credentials and possibly years after the
 * send. There is therefore no opportunity to transform it at read time: whatever
 * is stored is exactly what is delivered. This module produces the delivery-ready
 * bytes at upload time.
 *
 * Two hard constraints:
 *  1. The output format must be one mail clients actually draw. Gmail, Outlook and
 *     Yahoo do not render SVG, and Outlook on Windows renders through Word, which
 *     draws neither WebP nor AVIF. Output is therefore always JPEG, PNG or an
 *     untouched (animated) GIF.
 *  2. The stored object stays a plain file behind a plain public URL.
 */

/** 600 CSS px email column at 2x retina density. */
export const EMAIL_MAX_WIDTH = 1200;
/** Same bound vertically, so a tall screenshot cannot stay arbitrarily heavy. */
export const EMAIL_MAX_HEIGHT = 1200;

const JPEG_QUALITY = 82;
const PNG_QUALITY = 90;

/** Input formats mail clients already render, so a pass-through is acceptable. */
const EMAIL_SAFE_INPUT_FORMATS = new Set(["jpeg", "png", "gif"]);

export class EmailOptimizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailOptimizeError";
  }
}

export interface OptimizedImage {
  buffer: Buffer;
  contentType: string;
  filename: string;
  /** false when the source bytes are returned unchanged. */
  applied: boolean;
  /** Why the source was kept, when applied is false. */
  reason?: string;
  width?: number;
  height?: number;
}

/** Swap (or append) a filename extension, preserving any folder-free basename. */
export function replaceExtension(filename: string, extension: string): string {
  const stripped = filename.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const base = stripped.length > 0 ? stripped : filename;
  return `${base}.${extension}`;
}

function contentTypeFor(format: "jpeg" | "png"): string {
  return format === "png" ? "image/png" : "image/jpeg";
}

/**
 * Re-encode an image so it is ready to be delivered inside an email.
 *
 * Bounded to EMAIL_MAX_WIDTH x EMAIL_MAX_HEIGHT (fit inside, never upscaled),
 * EXIF orientation baked in, metadata stripped, and emitted as PNG when the
 * source carries transparency or JPEG otherwise.
 *
 * Returns the source untouched when re-encoding would not help: animated GIFs
 * (whose animation cannot survive a still encode) and already-small,
 * already-email-safe images that the encoder cannot make lighter.
 *
 * @throws EmailOptimizeError when the payload is not a decodable raster image.
 */
export async function optimizeImageForEmail(
  source: Buffer,
  filename: string,
  sourceContentType: string
): Promise<OptimizedImage> {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(source).metadata();
  } catch (err) {
    throw new EmailOptimizeError(
      `not a decodable raster image: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!metadata.format || !metadata.width || !metadata.height) {
    throw new EmailOptimizeError("not a decodable raster image: unknown format or dimensions");
  }

  // An animated GIF renders in every mail client and cannot keep its animation
  // through a still re-encode, so it is stored exactly as supplied.
  if (metadata.format === "gif" && (metadata.pages ?? 1) > 1) {
    return {
      buffer: source,
      contentType: sourceContentType,
      filename,
      applied: false,
      reason: "animated gif kept as-is",
      width: metadata.width,
      height: metadata.height,
    };
  }

  const targetFormat: "jpeg" | "png" = metadata.hasAlpha ? "png" : "jpeg";

  let pipeline = sharp(source, { failOn: "none" })
    // Bake EXIF orientation in: phone photos otherwise arrive sideways once the
    // metadata is stripped.
    .rotate()
    .resize({
      width: EMAIL_MAX_WIDTH,
      height: EMAIL_MAX_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
    });

  pipeline =
    targetFormat === "png"
      ? pipeline.png({ compressionLevel: 9, palette: true, quality: PNG_QUALITY, effort: 7 })
      : pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true, chromaSubsampling: "4:2:0" });

  let encoded: { data: Buffer; info: sharp.OutputInfo };
  try {
    encoded = await pipeline.toBuffer({ resolveWithObject: true });
  } catch (err) {
    throw new EmailOptimizeError(
      `image could not be re-encoded: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Never make an already-email-safe image heavier than it arrived.
  if (
    encoded.data.length >= source.length &&
    EMAIL_SAFE_INPUT_FORMATS.has(metadata.format) &&
    metadata.width <= EMAIL_MAX_WIDTH &&
    metadata.height <= EMAIL_MAX_HEIGHT
  ) {
    return {
      buffer: source,
      contentType: sourceContentType,
      filename,
      applied: false,
      reason: "source already smaller than any re-encode",
      width: metadata.width,
      height: metadata.height,
    };
  }

  return {
    buffer: encoded.data,
    contentType: contentTypeFor(targetFormat),
    filename: replaceExtension(filename, targetFormat === "png" ? "png" : "jpg"),
    applied: true,
    width: encoded.info.width,
    height: encoded.info.height,
  };
}
