import { describe, it, expect } from "vitest";
import { deriveBotName } from "../../src/lib/bot-traffic/bot-name.js";
import {
  daysNeedingCapture,
  earliestCapturableDay,
  finalAfter,
  isCapturable,
} from "../../src/lib/bot-traffic/days.js";
import { payloadHash, toSilverRows } from "../../src/lib/bot-traffic/capture.js";
import { buildDayQuery } from "../../src/lib/bot-traffic/cloudflare-graphql.js";
import { orderCategories } from "../../src/routes/bot-traffic.js";

describe("deriveBotName", () => {
  // Real user agents from Cloudflare for distribute.you, 2026-09-28.
  const cases: Array<[string, string]> = [
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot", "ChatGPT-User"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +claude-user@anthropic.com)", "Claude-User"],
    ["DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)", "DuckAssistBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)", "GPTBot"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ShapBot/0.1.0", "ShapBot"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)", "Applebot"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; robots.txt; +https://openai.com/searchbot", "OAI-SearchBot"],
    ["Mozilla/5.0 (compatible;PetalBot;+https://webmaster.petalsearch.com/site/petalbot)", "PetalBot"],
    ["Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.52 Mobile Safari/537.36 (compatible; GoogleOther)", "GoogleOther"],
    ["GoogleOther", "GoogleOther"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))", "meta-externalagent"],
    ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "facebookexternalhit"],
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; HubSpot Crawler; +https://www.hubspot.com) Chrome/131.0.0.0 Safari/537.36", "HubSpot Crawler"],
    ["Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)", "MJ12bot"],
    ["Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)", "SemrushBot"],
    ["Go-http-client/2.0", "Go-http-client"],
    ["HubSpot Connect 2.0 (http://dev.hubspot.com/) (namespace: domain_http_fetcher)", "HubSpot Connect 2.0"],
    ["", "unknown"],
  ];
  it.each(cases)("%s -> %s", (ua, name) => {
    expect(deriveBotName(ua)).toBe(name);
  });
});

describe("capture days", () => {
  const now = new Date("2026-09-29T10:00:00Z");

  it("backfills from the oldest day Cloudflare serves in full through yesterday", () => {
    expect(earliestCapturableDay(now)).toBe("2026-08-30");
    const days = daysNeedingCapture(now, new Map());
    expect(days[0]).toBe("2026-08-30");
    expect(days[days.length - 1]).toBe("2026-09-28");
    expect(days).toHaveLength(30);
  });

  it("never captures today, and waits for the final lag on yesterday", () => {
    expect(isCapturable("2026-09-29", now)).toBe(false);
    const early = new Date("2026-09-29T01:30:00Z");
    expect(daysNeedingCapture(early, new Map())).not.toContain("2026-09-28");
    expect(daysNeedingCapture(new Date("2026-09-29T02:00:00Z"), new Map())).toContain("2026-09-28");
  });

  it("skips final days and re-fetches a day only seen before it was final", () => {
    const seen = new Map<string, Date>();
    for (const d of daysNeedingCapture(now, new Map())) seen.set(d, finalAfter(d));
    expect(daysNeedingCapture(now, seen)).toEqual([]);
    seen.set("2026-09-28", new Date("2026-09-29T00:30:00Z"));
    expect(daysNeedingCapture(now, seen)).toEqual(["2026-09-28"]);
  });
});

describe("toSilverRows / payloadHash", () => {
  const groups = [
    { count: 8, dimensions: { verifiedBotCategory: "AI Assistant", userAgent: "x; compatible; ChatGPT-User/1.0" } },
    { count: 3, dimensions: { verifiedBotCategory: "AI Assistant", userAgent: "DuckAssistBot/1.2;" } },
    { count: 2, dimensions: { verifiedBotCategory: "AI Assistant", userAgent: "x; compatible; ChatGPT-User/1.0" } },
    { count: 5, dimensions: { verifiedBotCategory: "", userAgent: "human" } },
  ];

  it("sums repeated (category, UA) pairs and drops non-bot rows", () => {
    const rows = toSilverRows(groups);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.botName === "ChatGPT-User")?.requests).toBe(10);
    expect(rows.reduce((s, r) => s + r.requests, 0)).toBe(13);
  });

  it("hash is order-independent and content-sensitive", () => {
    expect(payloadHash([...groups].reverse())).toBe(payloadHash(groups));
    expect(payloadHash([{ ...groups[0], count: 9 }, ...groups.slice(1)])).not.toBe(payloadHash(groups));
  });
});

describe("buildDayQuery", () => {
  it("filters one day, the host, and verified bots only", () => {
    const q = buildDayQuery("zone123", "distribute.you", "2026-09-28");
    expect(q).toContain('zoneTag:"zone123"');
    expect(q).toContain('date:"2026-09-28"');
    expect(q).toContain('clientRequestHTTPHost:"distribute.you"');
    expect(q).toContain('verifiedBotCategory_neq:""');
    expect(q).toContain("dimensions{verifiedBotCategory userAgent}");
  });
});

describe("orderCategories", () => {
  it("puts AI categories first in fixed order, then the rest by volume", () => {
    const totals = new Map([
      ["Search Engine Crawler", 300],
      ["AI Crawler", 50],
      ["Page Preview", 60],
      ["AI Assistant", 14],
    ]);
    expect(orderCategories(totals)).toEqual(["AI Assistant", "AI Crawler", "Search Engine Crawler", "Page Preview"]);
  });
});
