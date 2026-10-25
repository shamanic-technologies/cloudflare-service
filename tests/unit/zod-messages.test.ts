import { describe, it, expect } from "vitest";
import { UploadRequestSchema, PlatformUploadBase64RequestSchema } from "../../src/schemas.js";
import { DailyQuerySchema, CaptureBodySchema } from "../../src/routes/bot-traffic.js";

const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : r.error!.issues.map((i) => i.message);

// Our 400 bodies echo Zod issue messages: they keep the Zod 3 wording after the Zod 4 upgrade.
describe("zod issue messages keep the Zod 3 wording", () => {
  it("missing field, bad url, bad enum", () => {
    expect(messages(UploadRequestSchema.safeParse({}))).toEqual(["Required"]);
    expect(messages(UploadRequestSchema.safeParse({ sourceUrl: "nope" }))).toEqual(["Invalid url"]);
    expect(messages(UploadRequestSchema.safeParse({ sourceUrl: 5 }))).toEqual(["Expected string, received number"]);
    expect(messages(UploadRequestSchema.safeParse({ sourceUrl: "https://x.y/a", optimizeFor: "web" }))).toEqual([
      "Invalid enum value. Expected 'email', received 'web'",
    ]);
  });

  it("support kind and reason bounds", () => {
    const r = PlatformUploadBase64RequestSchema.safeParse({ contentBase64: "a", support: { kind: "x", reason: "" } });
    expect(messages(r)[1]).toBe("String must contain at least 1 character(s)");
    expect(messages(r)[0]).toMatch(/^Invalid enum value\. Expected 'payment_fees' \| /);
  });

  it("bot-traffic query and body", () => {
    expect(messages(DailyQuerySchema.safeParse({ topBots: "abc" }))).toEqual(["Expected number, received nan"]);
    expect(messages(DailyQuerySchema.safeParse({ topBots: "51" }))).toEqual(["Number must be less than or equal to 50"]);
    expect(messages(DailyQuerySchema.safeParse({ topBots: "1.5" }))).toEqual(["Expected integer, received float"]);
    expect(messages(DailyQuerySchema.safeParse({ from: "2026-1-1" }))).toEqual(["expected YYYY-MM-DD"]);
    expect(messages(CaptureBodySchema.safeParse({ days: Array(41).fill("2026-01-01") }))).toEqual([
      "Array must contain at most 40 element(s)",
    ]);
  });
});
