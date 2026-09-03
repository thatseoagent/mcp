/**
 * The GEO check labels, in a module that imports nothing.
 *
 * A check's label is a de-facto key: in `geo-analyzer`, `naCheck` writes it on
 * the not-applicable branch, the scoring branch writes it again, and `labelMap`
 * looks a recommendation up by it. Three copies of one string, and until this
 * table existed nothing made them agree.
 *
 * They had already drifted. Rewording these labels out of JSON-key spelling and
 * into prose changed the scoring branch and left the other two behind, so
 * `scoreFreshnessSignals` emitted "JSON-LD states when the page was published or
 * last modified" on an article and "JSON-LD contains dateModified or
 * datePublished" on a homepage: one check under two names, depending on the page.
 * The `labelMap` copy fails more quietly still — a key that no longer matches any
 * label simply produces no recommendation, and a missing recommendation looks
 * exactly like a check that needs none.
 *
 * A leaf module, and that is not tidiness. `report-findings` matches stored
 * checks by name, and reaching these three strings through `geo-analyzer` pulled
 * its whole dependency tree (`well-known` → `ssrf-guard` → `node:dns/promises`)
 * into `tests/components/report/no-section-goes-silent.test.tsx`, a jsdom test
 * that then failed to load with "No default export is defined on the
 * node:dns/promises mock". A key does not need a scorer attached to it.
 *
 * `tests/lib/analyzers/geo-label-keys.test.ts` holds `geo-analyzer` to the same
 * rule, and imports this table rather than scraping it.
 */export const LABEL = {
  articleSchema: "Article schema naming an author, a publish date and a modified date",
  publishingEntityIdentity: "Publishing entity with 2 or more identity links (Organization or Person)",
  personSchema: "Person schema with a profile link or a job title",
  dateModified: "Date modified within 90 days (10 pts) or 180 days (5 pts)",
  sitemapLastmod: "Sitemap lastmod agrees with the page's modified date (±7 days)",
  jsonLdDates: "JSON-LD states when the page was published or last modified",
  openGraphDates: "Open Graph meta tag stating when the article was published or modified",
  noindexAbsent: "No noindex directive in the robots meta tag",
  listicleFormatting: "Listicle formatting (numbered headings, ordered lists, comparison tables)",
  questionHeadings: "Question-phrased H2/H3 headings (query-optimized structure)",
  // Was written twice — once on the homepage `naCheck` branch and once on the
  // scoring branch — which is the drift this table exists to prevent.
  tldr: "TL;DR / summary / takeaway section present",
  qaPattern: "Visible Q&A pattern (details/summary, dt/dd, or FAQ container)",
} as const;
