/**
 * The shape every GA4 Tool shares: a property, a window, and a header.
 *
 * ── Why this file exists ──
 *
 * `gsc-tool-shape.ts` opens by saying that fifteen Tools asking Search Console
 * the same three questions is "fifteen chances for one of them to forget the lag
 * note and report a two-day dip as a collapse". The Search Console family got
 * that module. The Analytics family never did, and the predicted thing happened:
 *
 *   - The `propertyId` argument's description was copy-pasted into eight Tools.
 *   - `Property: ${propertyId}` was written out in seven, `Window: …` in five.
 *   - `startDate ?? DEFAULT_START` was written out in three.
 *   - The defaults and the fourteen lines of timezone reasoning behind them lived
 *     in **a Tool file**, `ga4-run-report.ts`, imported by three of its siblings —
 *     the only Tool-to-Tool imports anywhere in `src/tools/`. Understanding
 *     `ga4_pivot_report`'s default window meant opening a different Tool.
 *   - **The lag note appeared exactly once.** `ga4_run_report` explained why its
 *     window ends yesterday; `ga4_pivot_report`, `ga4_key_events` and
 *     `ga4_ai_traffic` printed the same yesterday-ending window with no
 *     explanation at all. On the Search Console side that cannot happen, because
 *     the note is produced inside `resolveWindow` and travels in `window.notes`.
 *
 * ── The asymmetry that is not fixed here ──
 *
 * `ga4-report.ts` is the deep half of the response side and stays as it is. This
 * is the missing front half: everything a `ga4_*` Tool must settle before it has
 * rows to interpret.
 */
import { z } from "zod";
import { refreshable } from "../with-cache";
import { InvalidInputError } from "../invalid-input-error";
import { findSite, type Site } from "../sites";

/**
 * The date range every GA4 Tool defaults to, in GA4's own relative form.
 *
 * `NdaysAgo` and `yesterday` rather than dates computed here, and the reason is
 * a bug worth not repeating: computed dates come from `new Date()`, which is
 * UTC, while GA4 resolves a range in the **property's** reporting timezone. For
 * anyone west of Greenwich the window was off by a day.
 *
 * Ending at `yesterday` rather than `today` because Google processes a day's
 * data over the following 24 to 48 hours, so today is always a partial day being
 * compared against whole ones.
 *
 * This reasoning was stated twice — here and in `ga4-ai-traffic.ts` — while the
 * constants themselves lived in a Tool file that three siblings imported from.
 */
export const DEFAULT_DAYS = 28;
export const DEFAULT_START = `${DEFAULT_DAYS}daysAgo`;
export const DEFAULT_END = "yesterday";

/**
 * The sentence a defaulted window owes the reader.
 *
 * Four of the five windowed Tools printed a window ending yesterday without it,
 * so a reader could not tell a quiet day from a day Google has not finished
 * processing. It travels in {@link Ga4Window.header} now, which is the only way
 * a Tool cannot forget it.
 */
const LAG_NOTE = [
  "The window ends yesterday: Google processes a day's data over the following 24 to 48",
  "hours, so today is always a partial day being compared against whole ones.",
];

/** The property argument, described once. */
export const ga4PropertySchema = {
  ...refreshable,
  propertyId: z
    .string()
    .describe(
      "The GA4 property: `123456789` or `properties/123456789`. Both work. A bare " +
        "domain works too, once the site has been registered with `run_site_audit` " +
        "and its GA4 property recorded.",
    ),
};

/** The arguments every windowed GA4 Tool takes. */
export const ga4WindowSchema = {
  ...ga4PropertySchema,
  startDate: z
    .string()
    .optional()
    .describe(`YYYY-MM-DD or a GA4 relative date like '28daysAgo'. Default ${DEFAULT_START}.`),
  endDate: z
    .string()
    .optional()
    .describe(`YYYY-MM-DD or 'yesterday'/'today'. Default ${DEFAULT_END}.`),
};

export interface Ga4WindowArgs {
  propertyId: string;
  startDate?: string;
  endDate?: string;
  /**
   * Window length in days, when no explicit dates are given.
   *
   * `ga4_ai_traffic` takes `days` rather than dates and built `${days}daysAgo`
   * itself, which is how it ended up restating the timezone reasoning that
   * `DEFAULT_START` already carried.
   */
  days?: number;
}

/** Is this already a GA4 property identifier? */
function isPropertyId(input: string): boolean {
  return /^(properties\/)?\d+$/.test(input.trim());
}

/**
 * No GA4 property is known for what the Operator named.
 *
 * ADR-0003: a Tool that cannot do its whole job returns an error naming what to
 * configure. Without this, a bare `example.com` — which is what a person says to
 * an agent, and what every `gsc_*` Tool accepts — reached the Data API and came
 * back as a raw Google 400. That is not "an error naming what to configure"; it
 * is Google's complaint about an argument the Operator never knowingly supplied.
 *
 * An {@link InvalidInputError} because the caller supplied the value and the
 * caller can fix it on the next call, which is also what makes the message safe
 * to publish through the Tool failure seam.
 */
function ga4ResolutionError(input: string): InvalidInputError {
  return new InvalidInputError(
    `No GA4 property is known for "${input}". Unlike Search Console, Google's Analytics ` +
      `Admin API does not say which site a property measures — a property has a display name ` +
      `the Operator chose, not a domain — so a bare domain cannot be matched to one reliably, ` +
      `and guessing would report another site's traffic as this one's. ` +
      `Run ga4_list_properties to see the properties this Google account can read, then either ` +
      `pass the identifier directly (\`properties/123456789\`) or record it once with ` +
      `run_site_audit's \`ga4PropertyId\`, after which "${input}" will resolve on its own.`,
  );
}

/**
 * `properties/123456789`, from an identifier or from a domain already recorded.
 *
 * A bare numeric id is normalised, a full identifier passes through, and a domain
 * is looked up in the Site the Operator registered — never matched against
 * `displayName`, which is free text and would silently answer about the wrong
 * site. Anything else refuses; see {@link ga4ResolutionError}.
 *
 * Deliberately **not** the Search Console `resolveSiteUrl` treatment.
 * `listProperties` there returns identifiers that carry the domain, so matching
 * is exact; here it returns names an Operator typed, so there is nothing to
 * match on and a heuristic would be a guess dressed as an answer.
 */
export function resolveGa4Property(input: string): string {
  const trimmed = input.trim();
  if (isPropertyId(trimmed)) {
    return trimmed.startsWith("properties/") ? trimmed : `properties/${trimmed}`;
  }

  // A domain, then. `findSite` normalises and reads the local database, which is
  // where `run_site_audit` records the property the Operator named once. It
  // returns `null` rather than throwing when there is no database at all, and
  // throws `InvalidInputError` on something that is not a domain — both of which
  // mean the same thing here, so both arrive at the same refusal.
  let site: Site | null;
  try {
    site = findSite(trimmed);
  } catch {
    throw ga4ResolutionError(input);
  }

  if (!site?.ga4PropertyId) throw ga4ResolutionError(input);

  return resolveGa4Property(site.ga4PropertyId);
}

/** What a windowed GA4 Tool settles before it has rows. */
export interface Ga4Window {
  /** `properties/123456789`, which is the form every Data API call wants. */
  property: string;
  startDate: string;
  endDate: string;
  /** The date range, shaped as the Data API takes it. */
  dateRange: { startDate: string; endDate: string };
  /** The header lines every windowed GA4 Tool opens with, lag note included. */
  header: string[];
}

/**
 * Resolve the property and the window, and open the report.
 *
 * The counterpart of `fetchRows`, minus the fetch: the Analytics Tools read five
 * different endpoints — reports, pivots, realtime, metadata, compatibility — so
 * there is no one read to share, and `ga4-report.ts` already owns the response
 * side. What they do share is everything up to the request.
 */
export function ga4Window(args: Ga4WindowArgs, options: { title: string }): Ga4Window {
  const property = resolveGa4Property(args.propertyId);
  const startDate = args.startDate ?? `${args.days ?? DEFAULT_DAYS}daysAgo`;
  const endDate = args.endDate ?? DEFAULT_END;

  const header = [`=== ${options.title} ===`];
  header.push(`Property: ${property}`);
  header.push(`Window: ${startDate} to ${endDate}`);
  // Only when the end date is ours. A caller who named one asked for something
  // specific, and explaining our default to them would be answering a question
  // they did not ask.
  if (!args.endDate) header.push(...LAG_NOTE);

  return { property, startDate, endDate, dateRange: { startDate, endDate }, header };
}

/**
 * The same, for the Tools that read no window.
 *
 * `ga4_metadata`, `ga4_custom_definitions` and `ga4_get_realtime` ask about a
 * property rather than a period. They still owe the reader the property they
 * resolved, and realtime owes the one sentence about what "now" covers.
 *
 * @param windowLine what this Tool's window is, where it has one that is not a
 *        date range — realtime's is "the last 30 minutes, which is all realtime
 *        covers."
 */
export function ga4Property(
  propertyId: string,
  options: { title: string; windowLine?: string },
): { property: string; header: string[] } {
  const property = resolveGa4Property(propertyId);

  const header = [`=== ${options.title} ===`];
  header.push(`Property: ${property}`);
  if (options.windowLine) header.push(`Window: ${options.windowLine}`);

  return { property, header };
}
