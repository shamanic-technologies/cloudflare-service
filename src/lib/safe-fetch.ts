// ---------------------------------------------------------------------------
// Public-internet-only fetch for URLs a customer (or a caller on a customer's
// behalf) supplies. Ported from chat-service src/lib/safe-fetch.ts
// (SEC-MCP-SSRF-1120) for cloudflare-service `POST /upload` (SSRF-1127).
//
// An attacker plugged ~70 brand MCP servers whose URL was a public redirector
// (tinyurl, httpbin redirect-to) pointing at our docker network
// (`http://mcp-service:8080/mcp`, `brand-service:8080/health`...): the global
// `fetch` followed the redirects from inside chat-service and the stored
// connection error echoed the internal answers back. This module is the ONE
// way this service reaches a caller-supplied URL:
//
//  - every hop (the URL AND each redirect) is checked BEFORE connecting:
//    single-label names (docker service names), `localhost` / `.local` /
//    `.internal`, and every address that is not public unicast (loopback,
//    RFC1918, link-local incl. 169.254.169.254, CGNAT, docker bridges,
//    IPv6 unique-local / link-local, IPv4-mapped / NAT64 / 6to4 forms of
//    any of them) are refused;
//  - names are resolved here (all addresses; ANY non-public one refuses the
//    hop, so `127.0.0.1.nip.io` is refused) and the connection is PINNED to
//    the checked address (custom `lookup`), so a DNS rebinding between the
//    check and the connect cannot move it;
//  - IP spellings (decimal `2130706433`, octal `0177.0.0.1`, hex) are
//    normalised by the WHATWG URL parser before the check;
//  - redirects are followed by hand (max 5), each re-checked; the
//    Authorization header is dropped when a redirect leaves the origin;
//  - a refusal is `PublicUrlRefusedError` with a GENERIC message: never the
//    target's answer, never which internal host was asked.
//
// Never replace a call site's `publicFetch` by the global `fetch` "because
// the URL looks public": the redirect is what made the attack work.
// ---------------------------------------------------------------------------

import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

/** The one message a refused hop carries (stored, returned, shown): no target detail. */
export const PUBLIC_ONLY_MESSAGE = "this address is not on the public internet, only public servers can be reached";

export class PublicUrlRefusedError extends Error {
  constructor() {
    super(PUBLIC_ONLY_MESSAGE);
    this.name = "PublicUrlRefusedError";
  }
}

export const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** [base, prefix] blocks that are never the public internet (IANA special-purpose + our docker ranges). */
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // RFC1918, docker bridges (172.17-31)
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918, docker custom pools
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
  ["62.83.93.230", 32], // our own box: from inside it, its public IP reaches our host ports
];

function isPublicV4Int(n: number): boolean {
  for (const [base, prefix] of V4_BLOCKED) {
    const b = v4ToInt(base)!;
    const size = 2 ** (32 - prefix);
    if (n >= b && n < b + size) return false;
  }
  return true;
}

/** Eight 16-bit groups of an IPv6 address (accepts `::` and a dotted IPv4 tail), or null. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    // A dotted IPv4 tail becomes its two hex groups.
    const v4 = v4ToInt(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const want = 8;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some((x) => Number.isNaN(x))) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = want - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== want) return null;
  return groups;
}

/** True only for a public unicast address; anything unparsable is NOT public. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip.replace(/%.*$/, ""));
  if (family === 4) {
    const n = v4ToInt(ip);
    return n !== null && isPublicV4Int(n);
  }
  if (family !== 6) return false;
  const g = v6Groups(ip);
  if (!g) return false;
  const embeddedV4 = (hi: number, lo: number) => isPublicV4Int(hi * 65536 + lo);
  const zeroUpTo = (k: number) => g.slice(0, k).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compat): the IPv4 decides.
  if (zeroUpTo(5) && g[5] === 0xffff) return embeddedV4(g[6], g[7]);
  if (zeroUpTo(6)) return g[6] === 0 && g[7] <= 1 ? false : embeddedV4(g[6], g[7]);
  // NAT64 well-known prefix 64:ff9b::/96: the IPv4 decides; the local-use /48 never.
  if (g[0] === 0x64 && g[1] === 0xff9b) return g.slice(2, 6).every((x) => x === 0) ? embeddedV4(g[6], g[7]) : false;
  // 6to4 2002::/16 embeds an IPv4 in groups 1-2.
  if (g[0] === 0x2002) return embeddedV4(g[1], g[2]);
  // Teredo 2001::/32 and documentation 2001:db8::/32.
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return false;
  // Global unicast is 2000::/3; everything else (ULA fc00::/7, link-local
  // fe80::/10, site-local, multicast ff00::/8, discard 100::/64...) is not.
  return (g[0] & 0xe000) === 0x2000;
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

/** A host name that only means something inside our network. */
function isInternalName(host: string): boolean {
  if (!host.includes(".")) return true; // docker service names, `localhost`
  return host === "localhost" || /\.(localhost|local|internal|lan|home|intranet|corp|localdomain)$/.test(host);
}

export interface CheckedHop {
  url: URL;
  address: string;
  family: 4 | 6;
}

/**
 * Checks one hop and resolves it: the address the connection MUST use, or a
 * `PublicUrlRefusedError`. A name that does not resolve throws the resolver's
 * own error (a public typo, not a refusal).
 */
export async function checkPublicUrl(
  raw: string | URL,
  opts: { protocols?: readonly string[]; resolve?: Resolver } = {},
): Promise<CheckedHop> {
  const url = raw instanceof URL ? new URL(raw.href) : new URL(raw);
  const protocols = opts.protocols ?? ["https:", "http:"];
  if (!protocols.includes(url.protocol)) throw new PublicUrlRefusedError();
  // WHATWG URL already normalised decimal / octal / hex IPv4 spellings.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) throw new PublicUrlRefusedError();
  const literal = isIP(host);
  if (literal) {
    if (!isPublicAddress(host)) throw new PublicUrlRefusedError();
    return { url, address: host, family: literal as 4 | 6 };
  }
  if (isInternalName(host)) throw new PublicUrlRefusedError();
  const addresses = await (opts.resolve ?? defaultResolver)(host);
  if (addresses.length === 0) throw new PublicUrlRefusedError();
  // ANY private answer refuses: a name that can point inside is never dialled.
  if (addresses.some((a) => !isPublicAddress(a.address))) throw new PublicUrlRefusedError();
  const first = addresses[0];
  return { url, address: first.address, family: (first.family === 6 ? 6 : 4) as 4 | 6 };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface PublicFetchInit {
  method?: string;
  headers?: Record<string, string> | Headers;
  body?: string | Buffer | Uint8Array | null;
  signal?: AbortSignal | null;
  /** Default https + http. */
  protocols?: readonly string[];
  maxRedirects?: number;
  /** Tests only. */
  resolve?: Resolver;
  /** Tests only: the request function (defaults to node http/https). */
  transport?: Transport;
}

export type Transport = (
  hop: CheckedHop,
  req: { method: string; headers: Record<string, string>; body: Buffer | null; signal?: AbortSignal | null },
) => Promise<Response>;

let testDefaults: { resolve?: Resolver; transport?: Transport } = {};

/** Tests only: the resolver/transport `publicFetch` uses when its caller passes none. */
export function setPublicFetchTestDefaults(d: { resolve?: Resolver; transport?: Transport }): void {
  testDefaults = d;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function headerRecord(h: PublicFetchInit["headers"]): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  return { ...h };
}

/** node http(s) on the CHECKED address: the socket never resolves the name again. */
export const nodeTransport: Transport = (hop, req) =>
  new Promise<Response>((resolve, reject) => {
    const { url, address, family } = hop;
    const pinned: LookupFunction = (_hostname, options, cb) => {
      if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
      else cb(null, address, family);
    };
    const mod = url.protocol === "https:" ? https : http;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const r = mod.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: { ...req.headers, ...(req.body ? { "content-length": String(req.body.length) } : {}) },
        lookup: pinned,
        // SNI + certificate check stay on the NAME (never the pinned address).
        ...(url.protocol === "https:" && !isIP(host) ? { servername: host } : {}),
        agent: false,
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
        }
        const status = res.statusCode ?? 0;
        const noBody = NULL_BODY_STATUSES.has(status) || req.method === "HEAD";
        if (noBody) res.resume();
        try {
          resolve(
            new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), {
              status: status < 200 || status > 599 ? 502 : status,
              statusText: res.statusMessage ?? "",
              headers,
            }),
          );
        } catch (err) {
          res.destroy();
          reject(err);
        }
      },
    );
    const onAbort = () => r.destroy(req.signal?.reason instanceof Error ? req.signal.reason : new DOMException("aborted", "AbortError"));
    if (req.signal) {
      if (req.signal.aborted) {
        onAbort();
      } else {
        req.signal.addEventListener("abort", onAbort, { once: true });
        r.on("close", () => req.signal?.removeEventListener("abort", onAbort));
      }
    }
    r.on("error", (err) => reject(req.signal?.aborted ? (req.signal.reason ?? err) : err));
    if (req.body) r.write(req.body);
    r.end();
  });

/**
 * `fetch` for a customer-supplied URL: every hop checked and pinned (see the
 * header). Answers a WHATWG `Response`; refuses with `PublicUrlRefusedError`.
 */
export async function publicFetch(input: string | URL, init: PublicFetchInit = {}): Promise<Response> {
  const transport = init.transport ?? testDefaults.transport ?? nodeTransport;
  const resolve = init.resolve ?? testDefaults.resolve;
  const maxRedirects = init.maxRedirects ?? MAX_REDIRECTS;
  let method = (init.method ?? "GET").toUpperCase();
  let headers = headerRecord(init.headers);
  let body: Buffer | null = init.body == null ? null : Buffer.from(init.body as string | Uint8Array);
  let current = input instanceof URL ? input.href : input;
  for (let hopIndex = 0; ; hopIndex++) {
    const hop = await checkPublicUrl(current, { protocols: init.protocols, resolve });
    const res = await transport(hop, { method, headers, body, signal: init.signal });
    const location = res.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(res.status) || !location) return res;
    await res.body?.cancel().catch(() => undefined);
    if (hopIndex >= maxRedirects) throw new Error(`too many redirects (more than ${maxRedirects})`);
    const next = new URL(location, hop.url);
    // Fetch-spec method rewrite: 303 always, 301/302 for a POST, become a body-less GET.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      if (method !== "HEAD") method = "GET";
      body = null;
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(type|length|encoding|language|location)$/i.test(k)));
    }
    // Credentials never follow a redirect to another origin.
    if (next.origin !== hop.url.origin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k)));
    }
    current = next.href;
  }
}
