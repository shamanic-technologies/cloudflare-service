/**
 * Derive a short bot name from a verified bot's user agent.
 *
 * Cloudflare's httpRequestsAdaptiveGroups exposes the verified-bot CATEGORY but
 * not the bot's name, so the name is parsed from the user agent. Order:
 *   1. the token after "compatible;" (GPTBot, ClaudeBot, Claude-User, PetalBot…)
 *   2. the first "Product/version" token that is not a browser engine token
 *      (facebookexternalhit, Applebot, DuckAssistBot, Go-http-client…)
 *   3. the user agent up to its first "(" or ";" (e.g. "GoogleOther")
 */
const BROWSER_TOKENS = new Set(
  [
    "mozilla",
    "applewebkit",
    "chrome",
    "safari",
    "version",
    "mobile",
    "gecko",
    "firefox",
    "edg",
    "khtml",
    "like",
    "crios",
    "opr",
  ].map((t) => t.toLowerCase())
);

const MAX_NAME_LENGTH = 80;

export function deriveBotName(userAgent: string): string {
  const ua = userAgent.trim();
  if (!ua) return "unknown";

  const compatible = /compatible;\s*([^;/()+]+?)\s*(?:[;/()]|$)/i.exec(ua);
  if (compatible && compatible[1].trim()) return clip(compatible[1].trim());

  const productRe = /([A-Za-z][\w.-]*)\/[\w.~]+/g;
  for (let m = productRe.exec(ua); m; m = productRe.exec(ua)) {
    const name = m[1];
    if (BROWSER_TOKENS.has(name.toLowerCase())) continue;
    if (/^https?$/i.test(name)) continue;
    return clip(name);
  }

  const head = ua.split(/[(;]/)[0].trim();
  return clip(head || ua);
}

function clip(name: string): string {
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
}
