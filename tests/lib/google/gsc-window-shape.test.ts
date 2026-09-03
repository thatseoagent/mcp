import { describe, expect, it } from "vitest";
import {
  fetchRows,
  precedingWindow,
  readAgain,
  readPrecedingWindow,
} from "@/lib/google/gsc-tool-shape";
import { fakeGoogleReader } from "@/lib/google/fake-reader";
import type { SearchAnalyticsQuery, SearchAnalyticsRow } from "@/lib/google/reader";

/**
 * The invariant this file exists to keep: **a windowed read says what it asked
 * for, and a second read asks the same property.**
 *
 * `fetchRows` hid the top half of a windowed read — property resolution, the
 * fallback, the window, the lag note, the header — and leaked the bottom half in
 * two places:
 *
 *   1. `whatTheseRowsAre(rows.length, limit)` had to be handed the row limit a
 *      second time, so nine Tools wrote the same constant twice and 19 call
 *      sites could disagree with the read they were describing. The failure mode
 *      is a false all-clear on a truncated read, which is precisely what that
 *      sentence exists to prevent.
 *   2. `fetchRows` returned `property` with no way to use it, so three Tools
 *      re-entered `withPropertyFallback` by hand. Two of them were a 23-line
 *      block differing in one line.
 *
 * The second one is not only duplication. `withPropertyFallback` can land on a
 * *different* property than the first call did, and a Tool comparing two windows
 * would then be comparing two sites — which is what the last test here pins.
 */

const ARGS = {
  force_refresh: undefined,
  siteUrl: "example.com",
  startDate: "2026-08-01",
  endDate: "2026-08-28",
  days: undefined,
};

function row(clicks: number): SearchAnalyticsRow {
  return { keys: [`q${clicks}`], clicks, impressions: clicks * 10, ctr: 0.1, position: 5 };
}

/** A reader that records every query it was asked, and answers with `rows`. */
function recordingReader(rows: SearchAnalyticsRow[] | ((q: SearchAnalyticsQuery) => SearchAnalyticsRow[])) {
  const asked: SearchAnalyticsQuery[] = [];
  const reader = fakeGoogleReader({
    searchConsole: {
      searchAnalytics: async (query: SearchAnalyticsQuery) => {
        asked.push(query);
        return typeof rows === "function" ? rows(query) : rows;
      },
    },
  });
  return { reader: reader.searchConsole, asked };
}

describe("the footer describes the read that produced it", () => {
  it("warns that the read is truncated when the rows fill the page asked for", async () => {
    const { reader } = recordingReader(Array.from({ length: 100 }, (_, i) => row(i)));

    const fetched = await fetchRows(reader, ARGS, { rowLimit: 100, title: "T" });

    expect(fetched.footer.join("\n")).toContain("there are almost certainly more rows");
  });

  it("does not warn when the rows came in under the page asked for", async () => {
    const { reader } = recordingReader(Array.from({ length: 99 }, (_, i) => row(i)));

    const fetched = await fetchRows(reader, ARGS, { rowLimit: 100, title: "T" });

    expect(fetched.footer.join("\n")).not.toContain("almost certainly more rows");
  });

  it("uses the limit the read actually asked for, not one a caller restates", async () => {
    // The property the old two-argument shape could not have. 100 rows read
    // under a 100-row limit is truncated; the same 100 rows under the 5,000-row
    // default is not, and neither call site has to know which.
    const rows = Array.from({ length: 100 }, (_, i) => row(i));
    const capped = await fetchRows(recordingReader(rows).reader, ARGS, { rowLimit: 100, title: "T" });
    const roomy = await fetchRows(recordingReader(rows).reader, ARGS, { title: "T" });

    expect(capped.footer.join("\n")).toContain("almost certainly more rows");
    expect(roomy.footer.join("\n")).not.toContain("almost certainly more rows");
  });

  it("always says an absence is an absence in these rows", async () => {
    const { reader } = recordingReader([]);

    const fetched = await fetchRows(reader, ARGS, { title: "T" });

    // The half a reader would otherwise take as a clean bill of health.
    expect(fetched.footer.join("\n")).toContain(
      "an absence here is an absence in these rows rather than a fact about the site",
    );
  });
});

describe("reading a second window", () => {
  it("reads the window before this one, of the same length", async () => {
    const { reader, asked } = recordingReader([row(1)]);
    const fetched = await fetchRows(reader, ARGS, { dimensions: ["query"], title: "T" });

    const previous = await readPrecedingWindow(reader, fetched, { dimensions: ["query"] });

    // 28 days inclusive, so the window before ends the day before this one starts.
    expect(previous).toMatchObject({ startDate: "2026-07-04", endDate: "2026-07-31" });
    expect(previous).toMatchObject(precedingWindow(ARGS.startDate, ARGS.endDate));
    expect(asked[1]).toMatchObject({
      startDate: "2026-07-04",
      endDate: "2026-07-31",
      dimensions: ["query"],
    });
  });

  it("states which window it compared against, and how many rows it saw", async () => {
    const { reader } = recordingReader([row(1), row(2), row(3)]);
    const fetched = await fetchRows(reader, ARGS, { title: "T" });

    const previous = await readPrecedingWindow(reader, fetched);

    expect(previous.line).toBe("Compared against: 2026-07-04 to 2026-07-31 (3 rows)");
  });

  it("defaults to the window already read, for a second grain over the same dates", async () => {
    const { reader, asked } = recordingReader([row(1)]);
    const fetched = await fetchRows(reader, ARGS, { dimensions: ["searchAppearance"], title: "T" });

    await readAgain(reader, fetched, { rowLimit: 1 });

    expect(asked[1]).toMatchObject({
      startDate: ARGS.startDate,
      endDate: ARGS.endDate,
      rowLimit: 1,
    });
    // The grain is the caller's to choose, and not carried over from the first read.
    expect(asked[1].dimensions).toBeUndefined();
  });

  it("asks the property the first read resolved, not the argument again", async () => {
    // The reason this matters rather than merely repeating: a domain the Operator
    // gave as `example.com` resolves through the fallback, and re-resolving could
    // land somewhere else — so the two windows a Tool compares would be two sites.
    const { reader, asked } = recordingReader([row(1)]);
    const fetched = await fetchRows(reader, ARGS, { title: "T" });

    await readPrecedingWindow(reader, fetched);

    expect(asked).toHaveLength(2);
    expect(asked[1].siteUrl).toBe(asked[0].siteUrl);
    expect(asked[1].siteUrl).toBe(fetched.property);
  });
});
