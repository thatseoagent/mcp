import { expect } from "vitest";
import type { SearchAnalyticsRow } from "@/lib/google/reader";
import type { Route } from "./serve";

/**
 * What the `site_*` Tool tests share: they read Google through a fake and the
 * Operator's site through `serve`, and every one of them owes the same three
 * assertions about its output.
 */

export const textOf = (result: { content: Array<{ text: string }> }): string =>
  result.content.map((part) => part.text).join("\n");

/** The window arguments every one of these Tools takes, left to their defaults. */
export const WINDOW = {
  force_refresh: undefined,
  siteUrl: "example.com",
  startDate: undefined,
  endDate: undefined,
  days: undefined,
};

export function row(keys: string[], clicks: number, impressions: number, position = 5): SearchAnalyticsRow {
  return { keys, clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position };
}

/** An HTML route. */
export function html(body: string, head = "", lang = "en"): Route {
  return {
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><html lang="${lang}"><head>${head}</head><body>${body}</body></html>`,
  };
}

/** A JSON-LD block, for a page's head. */
export const jsonLd = (value: unknown): string =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

/**
 * No number nobody measured and no value nobody set: `0/0` is `NaN`, an absent
 * field is `undefined`, and both render happily into prose.
 */
export function expectClean(text: string): void {
  for (const bad of ["NaN", "undefined", "Infinity", "[object Object]", "null"]) {
    expect(text, `output contains ${bad}`).not.toContain(bad);
  }
}
