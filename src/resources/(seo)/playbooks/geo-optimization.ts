import { type ResourceMetadata } from "xmcp";

export const metadata: ResourceMetadata = {
  name: "geo-optimization",
  title: "Being cited by AI answers",
  description:
    "What can actually be done about appearing in AI-generated answers, what this " +
    "server can measure about it, and what nobody can measure.",
  mimeType: "text/markdown",
};

export default function geoOptimization() {
  return `# Being cited by AI answers

## What is and is not knowable

**Nobody can measure how an AI system chooses what to cite.** Not this server, not any
other. The scores here — \`seo_geo_score\`, \`ai_visibility_score\`, the agent-readiness
tiers — are readings of signals that are visible on the page and plausibly relevant. They
are directional, and every one of them says so in its own output.

Present them that way. A score presented as a measurement of how ChatGPT behaves is a
claim nobody is in a position to make.

**What *is* measurable** is traffic that arrives with a referrer: \`ga4_ai_traffic\` reports
it. That number is a floor, not a count — an assistant that answers from your page without
linking to it sends no visit at all — and the Tool says so.

## The part that is not speculative

Before anything about AI, the page has to be readable at all. These are ordinary
requirements that happen to matter more here:

1. **The content is in the HTML.** An answer engine that does not run JavaScript sees an
   empty page. \`seo_agent_navigability\` checks this.
2. **Nothing blocks the crawler.** \`seo_robots_validator\` reports which AI crawlers a
   site's robots.txt allows — and blocking them is a legitimate choice, so report what it
   says rather than treating a block as a defect.
3. **The page can be indexed.** \`seo_crawlability_audit\`.

Those three come first, and \`seo_geo_score\` leads with them for that reason.

## What the scores actually look at

- **Answerable structure.** Whether the page states things a citation could quote: direct
  answers near the question, defined terms, dates.
- **Attributable claims.** An author, an organisation, an update date — the things a
  system deciding whether to trust a page can find.
- **Structured data.** \`seo_schema_detection\` says what is published;
  \`seo_schema_generator\` writes valid JSON-LD for what is missing.
- **Agent-readable artifacts.** \`seo_llms_txt\`, \`seo_agent_discovery\`. Publishing none
  of these costs nothing — the discovery tier only ever adds — so an absence is reported
  as n/a rather than as a failure.

## The one thing worth saying to an Operator

The work that makes a page citable by an AI system is mostly the work that made it good
for a person: answer the question near the top, say who wrote it and when, and let a
machine read it without executing anything. Where this differs from ordinary SEO, it
differs by being *less* speculative, not more.`;
}
