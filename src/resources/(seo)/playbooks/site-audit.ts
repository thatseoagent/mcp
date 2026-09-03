import { type ResourceMetadata } from "xmcp";

export const metadata: ResourceMetadata = {
  name: "site-audit",
  title: "Site audit playbook",
  description:
    "How to audit a whole site with this server: what to run, in what order, what a " +
    "refusal means, and how to read Search Console's numbers honestly.",
  mimeType: "text/markdown",
};

export default function siteAudit() {
  return `# Auditing a site

## Start with the refusal

Run \`run_site_audit\` first, even if you expect it to fail. It is the fastest way to find
out which half of this server is available for a given site, and its refusal is written to
tell you which:

- **Google not connected** — nobody has run the login command. Everything under
  \`gsc_*\`, \`ga4_*\` and \`run_site_audit\` is unavailable until they do.
- **No property for this site** — Google is connected, but this account does not hold a
  Search Console property covering the domain.
- **Property found but unverified** — the site is in Search Console and one verification
  step from working. This is a different message from the one above and needs a different
  thing from the Operator.

**A refusal is a state, not a fault.** Read it out in one line and carry on with the
credential-free Tools, which work on any site regardless.

## The credential-free half

These need nothing configured and work on any site, including one you do not own:

| Question | Tool |
|---|---|
| How does the site look across many pages? | \`crawl_site\` |
| Can this page be indexed at all? | \`seo_crawlability_audit\` |
| What does this page say to a search engine? | \`seo_analyze_page\`, \`seo_content_analysis\` |
| What structured data does it publish? | \`seo_schema_detection\` |
| Is it set up to be cited by AI answers? | \`seo_geo_score\`, \`ai_visibility_score\` |
| How does it look to an agent? | \`seo_agent_discovery\`, \`seo_agent_navigability\`, \`seo_llms_txt\` |
| What do its headers and robots say? | \`seo_security_headers\`, \`seo_robots_validator\` |

## Reading Search Console numbers

Three rules, and each exists because breaking it produces a confident wrong answer.

**Data lags two to three days.** A window ending today ends with days that are empty
because they have not been processed. Every Tool here defaults to ending three days back
and says so; if you override the dates, do not end at today.

**Rows are a subset.** Search Console withholds queries it considers personal — on many
sites that is a large share of the clicks. A total summed from query rows is smaller than
the property's total. Use the totals a Tool reports, not the sum of what it listed.

**An absence is an absence in the rows.** "No cannibalization found" means none in what
was read. Every analysis Tool ends by saying how many rows it read and what a full page
implies.

## What history buys

\`run_site_audit\` records its numbers. That is the only reason this server has a database,
and it is what makes \`seo_metric_trend\` and the before-and-after in \`run_page_audit\`
possible. One run is a baseline and no trend; the comparison starts with the second.

Before reading a flat number as a failed change, check \`gsc_crawl_freshness\` — a page
Google has not recrawled cannot be showing the change yet.`;
}
