interface Env {
  BUCKET: R2Bucket;
}

const ALLOWED_FIT = new Set(["scale-down", "contain", "cover", "crop", "pad"]);
const ALLOWED_FORMAT = new Set(["webp", "avif", "json"]);
const MAX_DIMENSION = 4096;

export interface TransformParams {
  width?: number;
  height?: number;
  fit?: string;
  format?: string;
  quality?: number;
}

export function parseTransformParams(url: URL): TransformParams {
  const params: TransformParams = {};

  const w = url.searchParams.get("w");
  if (w) {
    const n = parseInt(w, 10);
    if (n > 0 && n <= MAX_DIMENSION) params.width = n;
  }

  const h = url.searchParams.get("h");
  if (h) {
    const n = parseInt(h, 10);
    if (n > 0 && n <= MAX_DIMENSION) params.height = n;
  }

  const fit = url.searchParams.get("fit");
  if (fit && ALLOWED_FIT.has(fit)) params.fit = fit;

  const format = url.searchParams.get("format");
  if (format && ALLOWED_FORMAT.has(format)) params.format = format;

  const quality = url.searchParams.get("quality");
  if (quality) {
    const n = parseInt(quality, 10);
    if (n >= 1 && n <= 100) params.quality = n;
  }

  return params;
}

export function hasTransform(params: TransformParams): boolean {
  return !!(params.width || params.height || params.format);
}

export function isImageResizingSubrequest(request: Request): boolean {
  const via = request.headers.get("via");
  return via !== null && via.includes("image-resizing");
}

export function extractR2Key(pathname: string): string {
  // Remove leading slash, decode URI components
  return decodeURIComponent(pathname.slice(1));
}

function buildCorsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-max-age": "86400",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: buildCorsHeaders() });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const key = extractR2Key(url.pathname);

    if (!key) {
      return new Response("Not found", { status: 404 });
    }

    const transformParams = parseTransformParams(url);
    const needsTransform = hasTransform(transformParams);
    const isSubrequest = isImageResizingSubrequest(request);

    // If transform requested and this is NOT a subrequest from image-resizing,
    // re-fetch through Cloudflare's image pipeline
    if (needsTransform && !isSubrequest) {
      const imageOptions: Record<string, unknown> = {};
      if (transformParams.width) imageOptions.width = transformParams.width;
      if (transformParams.height) imageOptions.height = transformParams.height;
      if (transformParams.fit) imageOptions.fit = transformParams.fit;
      if (transformParams.format) imageOptions.format = transformParams.format;
      if (transformParams.quality) imageOptions.quality = transformParams.quality;

      // Strip transform params — fetch the original through cf.image
      const originUrl = new URL(url.origin + url.pathname);

      const transformed = await fetch(originUrl.toString(), {
        cf: { image: imageOptions },
      } as RequestInit);

      // Forward the transformed response with CORS and cache headers
      const response = new Response(transformed.body, {
        status: transformed.status,
        headers: transformed.headers,
      });
      for (const [k, v] of Object.entries(buildCorsHeaders())) {
        response.headers.set(k, v);
      }
      response.headers.set("cache-control", "public, max-age=31536000, immutable");

      return response;
    }

    // Serve original from R2
    // Handle conditional requests (If-None-Match)
    const ifNoneMatch = request.headers.get("if-none-match");

    const object = await env.BUCKET.get(key, {
      onlyIf: ifNoneMatch ? { etagDoesNotMatch: ifNoneMatch } : undefined,
    });

    if (!object) {
      return new Response("Not found", { status: 404 });
    }

    // R2 conditional get: if object body is null, it's a 304
    if (!("body" in object) || object.body === null) {
      return new Response(null, { status: 304 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    for (const [k, v] of Object.entries(buildCorsHeaders())) {
      headers.set(k, v);
    }

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    return new Response(object.body, { status: 200, headers });
  },
} satisfies ExportedHandler<Env>;
