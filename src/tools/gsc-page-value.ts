import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { toolText } from "../lib/tool-result";
import { fetchRows, gscWindowSchema } from "../lib/google/gsc-tool-shape";
import { ga4PropertySchema, resolveGa4Property } from "../lib/google/ga4-tool-shape";
import { organicLandings } from "../lib/google/traffic-segments";
import {
  DEFAULT_VALUE,
  clicksWithoutValue,
  joinPages,
  valueWithoutReach,
  type JoinedPage,
} from "../lib/google/page-join";
import type { GoogleReader } from "../lib/google/reader";
import { capped } from "../lib/render-list";
import { basisSection } from "../lib/render-basis";

export const schema = {
  ...gscWindowSchema,
  propertyId: ga4PropertySchema.propertyId,
  minClicks: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `The Search Console clicks a page needs before its engagement is judged. Default ` +
        `${DEFAULT_VALUE.minClicks}.`,
    ),
  lowEngagement: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      `An engagement rate below this percentage counts as low. Default ${DEFAULT_VALUE.lowEngagement}.`,
    ),
};

export const metadata: ToolMetadata = {
  name: "gsc_page_value",
  description:
    "What search traffic is worth, page by page: Search Console clicks, impressions and " +
    "position joined to GA4's Google organic landing sessions, engagement and key events. " +
    "Finds pages that earn clicks and then do little, and pages that produce key events but " +
    "are barely seen in search. Needs the Google login and a GA4 property; without either " +
    "this Tool says so.",
  annotations: {
    title: "Join search clicks to what they are worth",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "join this site's Search Console pages to its GA4 landing pages";

/**
 * How many landing pages to ask GA4 for.
 *
 * High, because the join happens here: a GA4 read cut short would report the
 * pages below the cut as "Search Console only", which reads as a tracking gap
 * that is not there.
 */
const GA4_ROW_LIMIT = 25_000;

const MAX_LISTED = 15;

function percent(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";
}

function pageLine(page: JoinedPage): string {
  return (
    `${page.search.url} — ${Math.round(page.search.clicks)} clicks, ` +
    `${Math.round(page.search.impressions)} impressions, position ${page.search.position.toFixed(1)}; ` +
    `${Math.round(page.analytics.sessions)} organic sessions, ` +
    `${(page.analytics.engagementRate * 100).toFixed(0)}% engaged, ` +
    `${Math.round(page.analytics.keyEvents)} key event(s)`
  );
}

export async function handler(args: InferSchema<typeof schema>, google: GoogleReader) {
  // Resolved before either read, so a GA4 property that cannot be named refuses
  // before Search Console has been asked anything.
  const ga4Property = resolveGa4Property(args.propertyId);
  const config = {
    minClicks: args.minClicks ?? DEFAULT_VALUE.minClicks,
    lowEngagement: args.lowEngagement ?? DEFAULT_VALUE.lowEngagement,
  };

  const fetched = await fetchRows(google.searchConsole, args, {
    dimensions: ["page"],
    title: "SEARCH TO VALUE, BY PAGE",
  });

  // The same calendar dates on both sides, spelled out rather than as GA4's
  // relative `NdaysAgo`, so the two reads cannot drift apart by the day that
  // GA4's property timezone and Search Console's Pacific one disagree on. The
  // slice is Google organic, as `traffic-segments.ts` defines it and for the
  // reason it gives: it is the one GA4 slice Search Console's pages join to.
  const organic = await organicLandings(
    google,
    {
      property: ga4Property,
      dateRange: { startDate: fetched.startDate, endDate: fetched.endDate },
    },
    { limit: GA4_ROW_LIMIT },
  );
  const landings = organic.pages;
  const join = joinPages(fetched.rows, landings);
  const unattributed = {
    rows: organic.unattributed.rows + join.analyticsUnreadable.rows,
    sessions: organic.unattributed.sessions + join.analyticsUnreadable.sessions,
  };

  const lines = [...fetched.header];
  lines.push("");
  lines.push(`GA4 property: ${ga4Property}`);
  lines.push(`GA4 rows read: ${organic.rowsRead} landing page(s), sessions from google / organic`);
  lines.push(
    "Dates: the same calendar dates on both sides — Search Console's in Pacific Time, GA4's in " +
      "the property's timezone, so the edges of the window can differ by some hours.",
  );
  const gaSessions = landings.reduce((sum, row) => sum + row.sessions, 0) + organic.unattributed.sessions;
  const keyEventsMeasured = landings.some((row) => row.keyEvents > 0);

  // How much of each side the join reached. It is what every figure below
  // rests on, so it is the basis section's `read`, beside Search Console's rows.
  const coverage: string[] = [];
  coverage.push(
    `Search Console clicks on pages GA4 also saw: ${Math.round(join.joinedClicks)} of ` +
      `${Math.round(join.totalClicks)} (${percent(join.joinedClicks, join.totalClicks)})`,
  );
  coverage.push(`Pages joined: ${join.joined.length}`);
  coverage.push(
    `Search Console pages with no GA4 organic landing on the same path: ${join.searchOnly.length}` +
      (join.searchOnly.length > 0
        ? ` (${Math.round(join.searchOnly.reduce((sum, page) => sum + page.clicks, 0))} clicks)`
        : ""),
  );
  if (join.ambiguous.length > 0) {
    coverage.push(
      `Not joined because the same path exists on more than one host: ${join.ambiguous.length} ` +
        `page(s). GA4's landing page carries no host, so its one row for that path cannot be ` +
        `split between them.`,
    );
  }
  if (join.unreadable > 0) {
    coverage.push(`Search Console rows that were not a URL: ${join.unreadable}`);
  }
  coverage.push(
    `GA4 organic landing pages Search Console reported nothing for: ${join.analyticsOnly.length}`,
  );
  if (unattributed.rows > 0) {
    coverage.push(
      `GA4 rows with no path to join, such as "(not set)": ${unattributed.rows} ` +
        `(${Math.round(unattributed.sessions)} sessions)`,
    );
  }
  coverage.push(`GA4 organic sessions read: ${Math.round(gaSessions)}`);

  // Named as GA4's because this answer rests on two reads, and "this property
  // has 400 rows" is ambiguous beside a Search Console property.
  const basis = basisSection(fetched.basis, {
    read: coverage,
    caveats: organic.caveats.map((caveat) => `GA4: ${caveat}`),
  });

  if (join.joined.length === 0) {
    lines.push("");
    lines.push(
      fetched.rows.length === 0
        ? "Search Console reported no pages in this window, so there is nothing to join."
        : landings.length === 0
          ? "GA4 reported no Google organic landing pages in this window, so there is nothing to " +
            "join. That is a fact about the GA4 rows: check that this is the property measuring " +
            "this site, and that it has data for these dates."
          : "No Search Console page shares a path with a GA4 landing page. The usual cause is a GA4 " +
            "property that measures a different site than this Search Console property.",
    );
    lines.push(...whyTheyDiffer());
    lines.push(...basis);
    return toolText(lines.join("\n"));
  }

  const leaky = clicksWithoutValue(join.joined, config, { keyEventsMeasured });
  lines.push("");
  lines.push(`=== CLICKS THAT DO LITTLE (${leaky.length}) ===`);
  lines.push(
    `At least ${config.minClicks} clicks, and an engagement rate under ${config.lowEngagement}%` +
      (keyEventsMeasured ? " or no key event at all" : "") +
      ". Thresholds are this Tool's, not Google's.",
  );
  if (!keyEventsMeasured) {
    lines.push(
      "No key event was recorded on any Google organic landing page, so pages are not flagged for " +
        "having none: if the property has no key events set up, every page would be. ga4_key_events " +
        "lists what is configured.",
    );
  }
  if (leaky.length === 0) {
    lines.push("  None in these rows.");
  } else {
    lines.push(...capped(leaky.map(pageLine), MAX_LISTED, { noun: "pages" }));
  }

  const reach = valueWithoutReach(join.joined);
  lines.push("");
  lines.push(`=== VALUE THAT IS BARELY SEEN (${reach.pages.length}) ===`);
  lines.push(
    `Key events from Google organic sessions, and fewer impressions than the median joined page ` +
      `(${Math.round(reach.median)}). Worth promoting: better internal links, a title that matches ` +
      `what it ranks for, or a query it could rank for and does not.`,
  );
  if (reach.pages.length === 0) {
    lines.push("  None in these rows.");
  } else {
    lines.push(...capped(reach.pages.map(pageLine), MAX_LISTED, { noun: "pages" }));
  }

  const unseenValue = join.analyticsOnly.filter((page) => page.keyEvents > 0);
  if (unseenValue.length > 0) {
    lines.push("");
    lines.push(
      `GA4 landing pages with key events that Search Console reported no page row for: ` +
        `${unseenValue.length}. Search Console may not have shown them in this window, or reported ` +
        `them under a URL whose path differs:`,
    );
    lines.push(
      ...capped(
        unseenValue.map(
          (page) => `${page.path} — ${Math.round(page.sessions)} organic sessions, ${Math.round(page.keyEvents)} key event(s)`,
        ),
        5,
        { noun: "pages" },
      ),
    );
  }

  lines.push(...whyTheyDiffer());
  lines.push(...basis);
  return toolText(lines.join("\n"));
}

/** Why the two sides' numbers do not match, and what that does to every ratio above. */
function whyTheyDiffer(): string[] {
  return [
    "",
    "=== WHY CLICKS AND SESSIONS DIFFER ===",
    "A Search Console click and a GA4 session are different counts of different things. GA4",
    "misses visitors who decline consent or block its tag, and one click can become no session",
    "(a bounce before the tag loads) or several. GA4 also attributes a session to google / organic",
    "by its own rules, so Discover, Images or News visits can land there too. Every ratio between",
    "the two is therefore directional: good for ranking pages against each other, not for saying",
    "what share of search visitors did anything.",
    "Joined on the path alone, with query strings and trailing slashes set aside.",
  ];
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "gsc_page_value", domainOf: (args) => args.siteUrl ?? null },
  handler,
);
