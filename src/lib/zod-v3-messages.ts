import { z } from "zod";

/**
 * Zod 4 reworded its default issue messages ("Required" became
 * "Invalid input: expected string, received undefined"). Our 400 bodies echo
 * those messages (`reason`, `details`), so this global error map keeps the
 * Zod 3 wording for every issue our schemas can raise. A message set on a
 * schema itself (e.g. the YYYY-MM-DD regex) still wins over this map.
 */
function v3TypeOf(input: unknown): string {
  if (input === undefined) return "undefined";
  if (input === null) return "null";
  if (Array.isArray(input)) return "array";
  if (typeof input === "number") {
    if (Number.isNaN(input)) return "nan";
    return Number.isInteger(input) ? "integer" : "float";
  }
  if (input instanceof Date) return "date";
  return typeof input;
}

function v3Received(input: unknown): string {
  const t = v3TypeOf(input);
  return t === "integer" || t === "float" ? "number" : t;
}

function quote(v: unknown): string {
  return typeof v === "string" ? `'${v}'` : String(v);
}

export function zodV3Message(iss: z.core.$ZodRawIssue): string | undefined {
  switch (iss.code) {
    case "invalid_type": {
      if (iss.input === undefined) return "Required";
      if (iss.expected === "int") {
        return `Expected integer, received ${v3TypeOf(iss.input) === "float" ? "float" : v3Received(iss.input)}`;
      }
      return `Expected ${iss.expected}, received ${v3Received(iss.input)}`;
    }
    case "invalid_value": {
      return `Invalid enum value. Expected ${iss.values.map(quote).join(" | ")}, received ${quote(iss.input)}`;
    }
    case "too_small": {
      const n = String(iss.minimum);
      if (iss.origin === "string") {
        return iss.exact
          ? `String must contain exactly ${n} character(s)`
          : `String must contain ${iss.inclusive ? "at least" : "over"} ${n} character(s)`;
      }
      if (iss.origin === "array" || iss.origin === "set") {
        return iss.exact
          ? `Array must contain exactly ${n} element(s)`
          : `Array must contain ${iss.inclusive ? "at least" : "more than"} ${n} element(s)`;
      }
      if (iss.origin === "number" || iss.origin === "bigint") {
        return `Number must be ${iss.inclusive ? "greater than or equal to" : "greater than"} ${n}`;
      }
      return undefined;
    }
    case "too_big": {
      const n = String(iss.maximum);
      if (iss.origin === "string") {
        return iss.exact
          ? `String must contain exactly ${n} character(s)`
          : `String must contain ${iss.inclusive ? "at most" : "under"} ${n} character(s)`;
      }
      if (iss.origin === "array" || iss.origin === "set") {
        return iss.exact
          ? `Array must contain exactly ${n} element(s)`
          : `Array must contain ${iss.inclusive ? "at most" : "less than"} ${n} element(s)`;
      }
      if (iss.origin === "number" || iss.origin === "bigint") {
        return `Number must be ${iss.inclusive ? "less than or equal to" : "less than"} ${n}`;
      }
      return undefined;
    }
    case "invalid_format": {
      if (iss.format === "regex") return "Invalid";
      if (iss.format === "datetime") return "Invalid datetime";
      if (iss.format === "email") return "Invalid email";
      return `Invalid ${iss.format}`;
    }
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${iss.keys.map((k) => `'${k}'`).join(", ")}`;
    case "invalid_union":
      return "Invalid input";
    default:
      return undefined;
  }
}

z.config({ customError: zodV3Message });
