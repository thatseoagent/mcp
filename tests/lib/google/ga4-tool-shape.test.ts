import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_DAYS,
  ga4Property,
  ga4Window,
  resolveGa4Property,
} from "@/lib/google/ga4-tool-shape";
import { registerSite, rememberGoogleProperty } from "@/lib/sites";
import { InvalidInputError } from "@/lib/invalid-input-error";
import { DB_PATH_VARIABLE } from "@/lib/db/database";
import { resetPersistence } from "@/lib/db/runtime";
import { useTempDatabase } from "../../helpers/temp-database";

/**
 * The invariant this file exists to keep: **a GA4 Tool cannot forget the lag
 * note, and cannot answer about a property it only guessed.**
 *
 * `gsc-tool-shape.ts` says fifteen Tools asking the same three questions is
 * "fifteen chances for one of them to forget the lag note and report a two-day
 * dip as a collapse". The Analytics family had no such module and the note
 * appeared in exactly one of five windowed Tools; the other four printed a
 * window ending yesterday with no explanation at all. So this is a test rather
 * than a comment: the note now travels inside `header`, and what is asserted is
 * that it cannot be separated from the window it describes.
 *
 * The property half is ADR-0003. A bare `example.com` — what a person says, and
 * what every `gsc_*` Tool accepts — used to reach the Data API and come back as a
 * raw Google 400.
 */

let temp: ReturnType<typeof useTempDatabase> | null = null;

afterEach(() => {
  temp?.dispose();
  temp = null;
  delete process.env[DB_PATH_VARIABLE];
  resetPersistence();
});

const LAG = "Google processes a day's data over the following 24 to 48";

describe("the window a GA4 Tool reports", () => {
  it("defaults to the last 28 days ending yesterday, in GA4's own relative form", () => {
    const window = ga4Window({ propertyId: "123456789" }, { title: "T" });

    // Relative rather than computed, because `new Date()` is UTC and GA4 resolves
    // a range in the property's reporting timezone.
    expect(window.dateRange).toEqual({ startDate: "28daysAgo", endDate: "yesterday" });
    expect(DEFAULT_DAYS).toBe(28);
  });

  it("explains why the window ends yesterday, in the header, unconditionally", () => {
    const window = ga4Window({ propertyId: "123456789" }, { title: "ANALYTICS REPORT" });

    expect(window.header[0]).toBe("=== ANALYTICS REPORT ===");
    expect(window.header).toContain("Property: properties/123456789");
    expect(window.header).toContain("Window: 28daysAgo to yesterday");
    // The line four of five Tools did not print. It is in `header` rather than
    // returned separately so a Tool that renders the header has already said it.
    expect(window.header.join("\n")).toContain(LAG);
  });

  it("takes a day count, so a Tool does not rebuild the relative form itself", () => {
    const window = ga4Window({ propertyId: "1", days: 7 }, { title: "T" });

    expect(window.dateRange).toEqual({ startDate: "7daysAgo", endDate: "yesterday" });
    expect(window.header.join("\n")).toContain(LAG);
  });

  it("leaves a caller who named an end date alone", () => {
    const window = ga4Window(
      { propertyId: "1", startDate: "2026-01-01", endDate: "2026-01-31" },
      { title: "T" },
    );

    expect(window.header).toContain("Window: 2026-01-01 to 2026-01-31");
    // They asked for something specific. Explaining our default to them would be
    // answering a question they did not ask.
    expect(window.header.join("\n")).not.toContain(LAG);
  });

  it("says the window even where it is not a date range", () => {
    const { header } = ga4Property("1", {
      title: "ANALYTICS REALTIME",
      windowLine: "the last 30 minutes, which is all realtime covers.",
    });

    expect(header).toEqual([
      "=== ANALYTICS REALTIME ===",
      "Property: properties/1",
      "Window: the last 30 minutes, which is all realtime covers.",
    ]);
  });

  it("omits the window line for the Tools that ask about a property, not a period", () => {
    const { header } = ga4Property("1", { title: "ANALYTICS METADATA" });

    expect(header).toEqual(["=== ANALYTICS METADATA ===", "Property: properties/1"]);
  });
});

describe("resolving what the Operator named to a GA4 property", () => {
  it("normalises a bare numeric id to the form every Data API call wants", () => {
    expect(resolveGa4Property("123456789")).toBe("properties/123456789");
    expect(resolveGa4Property("  123456789 ")).toBe("properties/123456789");
  });

  it("passes a full identifier through, and costs no lookup", () => {
    expect(resolveGa4Property("properties/123456789")).toBe("properties/123456789");
  });

  it("resolves a domain from the property the Operator recorded once", () => {
    temp = useTempDatabase();
    registerSite("example.com");
    rememberGoogleProperty("example.com", { ga4PropertyId: "987654321" });

    // The whole point: `example.com` is what a person says to an agent, and the
    // `gsc_*` Tools have always accepted it.
    expect(resolveGa4Property("example.com")).toBe("properties/987654321");
    expect(resolveGa4Property("https://www.example.com/pricing")).toBe("properties/987654321");
  });

  it("refuses a domain it has no property for, naming what to configure", () => {
    temp = useTempDatabase();
    registerSite("example.com");

    let thrown: unknown;
    try {
      resolveGa4Property("example.com");
    } catch (error) {
      thrown = error;
    }

    // ADR-0003: an error naming what to configure, not Google's complaint about
    // an argument the Operator never knowingly supplied.
    expect(thrown).toBeInstanceOf(InvalidInputError);
    const message = (thrown as Error).message;
    expect(message).toContain("ga4_list_properties");
    expect(message).toContain("run_site_audit");
    expect(message).toContain("properties/123456789");
  });

  it("refuses rather than guessing from a display name", () => {
    temp = useTempDatabase();

    // `FAKE_GA4_PROPERTIES` has a property whose `displayName` is
    // "example.com — GA4". Matching on it would be a guess dressed as an answer:
    // the name is free text the Operator chose, and reporting another site's
    // traffic as this one's is worse than refusing.
    expect(() => resolveGa4Property("example.com")).toThrow(InvalidInputError);
  });

  it("refuses something that is not an id or a domain", () => {
    expect(() => resolveGa4Property("not a property")).toThrow(InvalidInputError);
    expect(() => resolveGa4Property("")).toThrow(InvalidInputError);
  });
});
