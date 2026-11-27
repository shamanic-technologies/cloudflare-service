// ---------------------------------------------------------------------------
// Download of a caller-supplied `sourceUrl` for `POST /upload` (SSRF-1127).
//
// The bytes we fetch are stored on the PUBLIC R2 bucket and served to anyone,
// and the URL ultimately comes from customer data (brand-service scrapes the
// customer's own website for image URLs). A plain `fetch(sourceUrl)` let a page
// pointing at `http://key-service:8080/...` get our internal answer stored and
// published. So:
//  - the fetch goes through `publicFetch` (every hop public-only, DNS pinned,
//    redirects re-checked by hand);
//  - only media is stored (image / video / audio, by the source's own
//    Content-Type, or by magic bytes when it says octet-stream / nothing);
//  - size and time are capped.
// Never call the global `fetch` on a sourceUrl.
// ---------------------------------------------------------------------------

import { publicFetch, PublicUrlRefusedError } from "./safe-fetch.js";

export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const SOURCE_TIMEOUT_MS = 30_000;

/** A refusal the route answers with a named 4xx (`status` + `code`). */
export class SourceRefusedError extends Error {
  constructor(
    readonly status: 400 | 413 | 415,
    readonly code: "source_url_not_public" | "source_too_large" | "source_not_media",
    message: string,
  ) {
    super(message);
    this.name = "SourceRefusedError";
  }
}

export type SourceDownload =
  | { ok: true; buffer: Buffer; contentType: string }
  | { ok: false; status: number };

const MEDIA_TYPE = /^(image|video|audio)\/[a-z0-9.+-]+$/i;

/** True for an image/video/audio MIME type (parameters like `; charset` ignored). */
export function isMediaType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return MEDIA_TYPE.test(contentType.split(";")[0].trim());
}

/** The image type the bytes declare by their magic number, or null. */
export function sniffImageType(buf: Buffer): string | null {
  const at = (offset: number, bytes: number[]) => bytes.every((b, i) => buf[offset + i] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  if (at(4, [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])) return "image/avif";
  if (at(0, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  return null;
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new SourceRefusedError(413, "source_too_large", `source is larger than ${max} bytes`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new SourceRefusedError(413, "source_too_large", `source is larger than ${max} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads a media file from a public URL. Refusals throw `SourceRefusedError`;
 * a non-2xx source answer is `{ ok: false, status }` (body never read).
 */
export async function downloadSource(sourceUrl: string): Promise<SourceDownload> {
  let res: Response;
  try {
    res = await publicFetch(sourceUrl, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof PublicUrlRefusedError) {
      throw new SourceRefusedError(400, "source_url_not_public", err.message);
    }
    throw err;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, status: res.status };
  }
  const headerType = res.headers.get("content-type");
  if (headerType && !isMediaType(headerType) && !/^application\/octet-stream\b/i.test(headerType) && !/^binary\//i.test(headerType)) {
    await res.body?.cancel().catch(() => undefined);
    throw new SourceRefusedError(415, "source_not_media", "source is not an image, video or audio file");
  }
  const buffer = await readCapped(res, MAX_SOURCE_BYTES);
  if (headerType && isMediaType(headerType)) return { ok: true, buffer, contentType: headerType };
  const sniffed = sniffImageType(buffer);
  if (!sniffed) throw new SourceRefusedError(415, "source_not_media", "source is not an image, video or audio file");
  return { ok: true, buffer, contentType: sniffed };
}
