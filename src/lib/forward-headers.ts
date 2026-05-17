import type { IncomingHttpHeaders } from "http";

const FORWARD_HEADER_NAMES = [
  "x-campaign-id",
  "x-brand-id",
  "x-workflow-slug",
  "x-workflow-run-id",
  "x-workflow-step-id",
  "x-feature-slug",
];

export function extractForwardHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARD_HEADER_NAMES) {
    const value = headers[name];
    if (typeof value === "string" && value.length > 0) {
      out[name] = value;
    }
  }
  return out;
}
