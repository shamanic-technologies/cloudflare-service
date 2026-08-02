import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  optimizeImageForEmail,
  replaceExtension,
  EmailOptimizeError,
  EMAIL_MAX_WIDTH,
  EMAIL_MAX_HEIGHT,
} from "../../src/lib/email-image.js";

/**
 * Build a noisy raster so the encoders have real detail to work on — a flat
 * colour compresses to a few bytes in every format and would make the
 * size-comparison assertions meaningless.
 */
function noise(width: number, height: number, channels: 3 | 4): Buffer {
  const pixels = Buffer.alloc(width * height * channels);
  for (let i = 0; i < pixels.length; i += channels) {
    const x = (i / channels) % width;
    const y = Math.floor(i / channels / width);
    pixels[i] = (x * 7 + y * 13) % 256;
    pixels[i + 1] = (x * 3 + y * 29) % 256;
    pixels[i + 2] = (x * 17 + y * 5) % 256;
    if (channels === 4) pixels[i + 3] = 255 - ((x + y) % 128);
  }
  return pixels;
}

function rawInput(width: number, height: number, channels: 3 | 4) {
  return sharp(noise(width, height, channels), { raw: { width, height, channels } });
}

async function makePng(width: number, height: number, opts: { alpha?: boolean } = {}): Promise<Buffer> {
  return rawInput(width, height, opts.alpha ? 4 : 3).png({ compressionLevel: 0 }).toBuffer();
}

async function makeJpeg(width: number, height: number, quality = 100): Promise<Buffer> {
  return rawInput(width, height, 3).jpeg({ quality }).toBuffer();
}

describe("replaceExtension", () => {
  it("swaps a known extension", () => {
    expect(replaceExtension("screenshot.png", "jpg")).toBe("screenshot.jpg");
    expect(replaceExtension("photo.JPEG", "jpg")).toBe("photo.jpg");
  });

  it("appends when there is no extension", () => {
    expect(replaceExtension("screenshot", "jpg")).toBe("screenshot.jpg");
  });

  it("only strips the final extension of a dotted name", () => {
    expect(replaceExtension("my.investor.update.png", "jpg")).toBe("my.investor.update.jpg");
  });

  it("keeps a UUID-shaped filename intact", () => {
    const uuid = "3f6b1c2a-0000-4000-8000-0123456789ab";
    expect(replaceExtension(uuid, "jpg")).toBe(`${uuid}.jpg`);
  });
});

describe("optimizeImageForEmail", () => {
  it("re-encodes an opaque screenshot to JPEG, materially lighter", async () => {
    const source = await makePng(1168, 880);
    const result = await optimizeImageForEmail(source, "screenshot.png", "image/png");

    expect(result.applied).toBe(true);
    expect(result.contentType).toBe("image/jpeg");
    expect(result.filename).toBe("screenshot.jpg");
    expect(result.buffer.length).toBeLessThan(source.length / 2);

    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe("jpeg");
  });

  it("bounds dimensions to the email column at retina density", async () => {
    const result = await optimizeImageForEmail(await makePng(4000, 3000), "big.png", "image/png");

    expect(result.width).toBe(EMAIL_MAX_WIDTH);
    expect(result.height).toBe(Math.round((EMAIL_MAX_WIDTH * 3000) / 4000));

    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBeLessThanOrEqual(EMAIL_MAX_WIDTH);
    expect(meta.height).toBeLessThanOrEqual(EMAIL_MAX_HEIGHT);
  });

  it("bounds a tall image on its height", async () => {
    const result = await optimizeImageForEmail(await makePng(900, 4000), "tall.png", "image/png");

    expect(result.height).toBe(EMAIL_MAX_HEIGHT);
    expect(result.width).toBe(Math.round((EMAIL_MAX_HEIGHT * 900) / 4000));
  });

  it("never upscales an image already smaller than the bound", async () => {
    const result = await optimizeImageForEmail(await makePng(320, 200), "small.png", "image/png");

    expect(result.width).toBe(320);
    expect(result.height).toBe(200);
  });

  it("keeps transparency by emitting PNG, never WebP or AVIF", async () => {
    const source = await makePng(1600, 1200, { alpha: true });
    const result = await optimizeImageForEmail(source, "logo.png", "image/png");

    expect(result.applied).toBe(true);
    expect(result.contentType).toBe("image/png");
    expect(result.filename).toBe("logo.png");

    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
    expect(result.buffer.length).toBeLessThan(source.length);
  });

  it(
    "only ever emits a mail-client-renderable format",
    async () => {
      for (const source of [await makePng(1400, 1000), await makeJpeg(1400, 1000), await makePng(1400, 1000, { alpha: true })]) {
        const result = await optimizeImageForEmail(source, "in.png", "image/png");
        const meta = await sharp(result.buffer).metadata();
        expect(["jpeg", "png", "gif"]).toContain(meta.format);
      }
    },
    30_000
  );

  it("converts a WebP source to a format mail clients draw", async () => {
    const source = await rawInput(1400, 1000, 3).webp({ quality: 90 }).toBuffer();
    const result = await optimizeImageForEmail(source, "shot.webp", "image/webp");

    expect(result.applied).toBe(true);
    expect(result.contentType).toBe("image/jpeg");
    expect(result.filename).toBe("shot.jpg");
    expect((await sharp(result.buffer).metadata()).format).toBe("jpeg");
  });

  it("shrinks a phone-photo-sized JPEG", async () => {
    const source = await makeJpeg(4032, 3024, 100);
    const result = await optimizeImageForEmail(source, "IMG_0042.JPG", "image/jpeg");

    expect(result.applied).toBe(true);
    expect(result.buffer.length).toBeLessThan(source.length / 2);
    expect(result.filename).toBe("IMG_0042.jpg");
  });

  it("bakes EXIF orientation in so a rotated phone photo is not sideways", async () => {
    const source = await rawInput(1000, 500, 3)
      .withMetadata({ orientation: 6 }) // 90deg clockwise
      .jpeg()
      .toBuffer();

    const result = await optimizeImageForEmail(source, "rotated.jpg", "image/jpeg");

    // Orientation applied: the stored raster is portrait, and carries no
    // orientation tag left for the client to apply a second time.
    expect(result.width).toBe(500);
    expect(result.height).toBe(1000);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.orientation).toBeUndefined();
  });

  it("keeps an animated GIF byte-for-byte so its animation survives", async () => {
    const animated = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../fixtures/animated.gif")
    );

    const meta = await sharp(animated).metadata();
    expect(meta.pages).toBeGreaterThan(1); // guard: the fixture really is animated

    const result = await optimizeImageForEmail(animated, "spinner.gif", "image/gif");
    expect(result.applied).toBe(false);
    expect(result.buffer).toBe(animated);
    expect(result.contentType).toBe("image/gif");
    expect(result.filename).toBe("spinner.gif");
  });

  it("keeps the source when a re-encode of a small email-safe image would be heavier", async () => {
    const source = await makeJpeg(40, 30, 40);
    const result = await optimizeImageForEmail(source, "tiny.jpg", "image/jpeg");

    expect(result.applied).toBe(false);
    expect(result.buffer).toBe(source);
    expect(result.contentType).toBe("image/jpeg");
    expect(result.filename).toBe("tiny.jpg");
  });

  it("rejects a payload that is not a decodable raster image", async () => {
    await expect(
      optimizeImageForEmail(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "x.svg", "image/svg+xml")
    ).rejects.toBeInstanceOf(EmailOptimizeError);

    await expect(
      optimizeImageForEmail(Buffer.from("this is a plain text file"), "notes.txt", "text/plain")
    ).rejects.toBeInstanceOf(EmailOptimizeError);
  });
});
