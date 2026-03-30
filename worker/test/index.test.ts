import { describe, it, expect } from "vitest";
import {
  parseTransformParams,
  hasTransform,
  isImageResizingSubrequest,
  extractR2Key,
} from "../src/index.js";

describe("extractR2Key", () => {
  it("strips leading slash", () => {
    expect(extractR2Key("/brands/uuid/logo.png")).toBe("brands/uuid/logo.png");
  });

  it("decodes URI components", () => {
    expect(extractR2Key("/brands/uuid/my%20image.png")).toBe("brands/uuid/my image.png");
  });

  it("returns empty string for root path", () => {
    expect(extractR2Key("/")).toBe("");
  });
});

describe("parseTransformParams", () => {
  function url(qs: string): URL {
    return new URL(`https://assets.example.com/img.png${qs}`);
  }

  it("parses width", () => {
    expect(parseTransformParams(url("?w=400"))).toEqual({ width: 400 });
  });

  it("parses height", () => {
    expect(parseTransformParams(url("?h=300"))).toEqual({ height: 300 });
  });

  it("parses all params together", () => {
    expect(parseTransformParams(url("?w=800&h=600&fit=cover&format=webp&quality=80"))).toEqual({
      width: 800,
      height: 600,
      fit: "cover",
      format: "webp",
      quality: 80,
    });
  });

  it("ignores invalid fit value", () => {
    expect(parseTransformParams(url("?w=200&fit=invalid"))).toEqual({ width: 200 });
  });

  it("ignores invalid format value", () => {
    expect(parseTransformParams(url("?w=200&format=bmp"))).toEqual({ width: 200 });
  });

  it("clamps width to MAX_DIMENSION", () => {
    expect(parseTransformParams(url("?w=9999"))).toEqual({});
  });

  it("ignores zero or negative width", () => {
    expect(parseTransformParams(url("?w=0"))).toEqual({});
    expect(parseTransformParams(url("?w=-10"))).toEqual({});
  });

  it("clamps quality to 1-100", () => {
    expect(parseTransformParams(url("?quality=0"))).toEqual({});
    expect(parseTransformParams(url("?quality=101"))).toEqual({});
    expect(parseTransformParams(url("?quality=50"))).toEqual({ quality: 50 });
  });

  it("returns empty for no params", () => {
    expect(parseTransformParams(url(""))).toEqual({});
  });
});

describe("hasTransform", () => {
  it("true when width set", () => {
    expect(hasTransform({ width: 400 })).toBe(true);
  });

  it("true when format set", () => {
    expect(hasTransform({ format: "webp" })).toBe(true);
  });

  it("false when only quality set (no resize, no format change)", () => {
    expect(hasTransform({ quality: 80 })).toBe(false);
  });

  it("false when empty", () => {
    expect(hasTransform({})).toBe(false);
  });
});

describe("isImageResizingSubrequest", () => {
  it("true when via header contains image-resizing", () => {
    const req = new Request("https://example.com", {
      headers: { via: "1.1 image-resizing" },
    });
    expect(isImageResizingSubrequest(req)).toBe(true);
  });

  it("false when via header missing", () => {
    const req = new Request("https://example.com");
    expect(isImageResizingSubrequest(req)).toBe(false);
  });

  it("false when via header has other value", () => {
    const req = new Request("https://example.com", {
      headers: { via: "1.1 varnish" },
    });
    expect(isImageResizingSubrequest(req)).toBe(false);
  });
});
