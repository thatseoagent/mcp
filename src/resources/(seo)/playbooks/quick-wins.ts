import { type ResourceMetadata } from "xmcp";

export const metadata: ResourceMetadata = {
  name: "quick-wins",
  title: "Quick wins playbook",
  description:
    "The changes worth shipping in a week without a developer: titles and descriptions " +
    "on pages already being seen, internal links, and the reports that surface each.",
  mimeType: "text/markdown",
};

export default function quickWins() {
  return `# Quick wins

Changes worth shipping in a week, without a developer.

**Site level in, page level out.** Every step starts from Search Console data for a whole
property and ends on a named URL to change. A finding that does not name a page is not
finished.

## What counts as a quick win

A query the site is *already* being shown for, at a position where a click is plausible,
that nobody clicks. That combination is usually a title and description problem rather
than a ranking problem — and a title is something you can change this afternoon.

\`gsc_detect_quick_wins\` looks for exactly that shape: at least 50 impressions, CTR at or
below 2%, position between 4 and 10. **Every one of those numbers is this server's own,
not Google's.** Say so when you present the list.

## The order

1. \`gsc_detect_quick_wins\` — the candidate queries.
2. \`gsc_page_query_map\` — which page each lands on, and what else that page ranks for.
   A page ranking for something it was not written for is the most common finding here,
   and often the most useful.
3. \`seo_analyze_page\` on the two or three pages worth changing, so the suggestion is
   about that page's actual title, description and headings rather than about titles in
   general.

## The other two kinds of quick win

**Traffic already earned and not converting.** \`gsc_device_gap\` and
\`gsc_country_opportunity\` find segments where the site is seen and not clicked. Some of
the device gap is the web rather than the site — mobile results carry more above the
organic ones — so compare the position column before assuming the page is at fault.

**Links that go nowhere.** \`crawl_site\` reports broken internal links, duplicate titles
and duplicate meta descriptions across a whole site. The duplicates are quick wins in the
plainest sense: two pages competing on one string is one edit.

## What not to promise

The estimated clicks in a quick-wins report are a floor built on a modest 5% target CTR,
not a forecast. Nothing here knows whether a better title will actually earn the click.

And the numbers describe the rows Search Console agreed to show. It withholds queries it
considers personal, so a total summed from these rows is smaller than the site's. Every
Tool prints what it read; pass that on.`;
}
