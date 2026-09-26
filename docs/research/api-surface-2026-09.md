# What the APIs we read could still answer

> **Research note, read 2026-09-24 against `master` at `fe9ae72`.** It inventories every API this
> server calls, what each one offers that no Tool reads yet, which reads can be crossed to answer
> something neither answers alone, and which new sources are worth a Tool. It decides nothing on
> its own; the section at the foot records what was taken up.
>
> Labels: **VERIFIED** = read on an official page or in a live discovery document. **INFERRED** = a
> conclusion drawn from verified facts, or from an absence. Discovery documents read at revision
> `20260923` for Search Console, the Analytics Data API and the Analytics Admin API.

---

## 1. What the server touches today

| API | Calls | Auth |
|---|---|---|
| Search Console | `sites.list`, `searchanalytics.query`, `urlInspection.index.inspect`, `sitemaps.list`, `sitemaps.get` | OAuth `webmasters.readonly` |
| Analytics Data v1beta | `runReport`, `runPivotReport`, `runRealtimeReport`, `getMetadata`, `checkCompatibility` | OAuth `analytics.readonly` |
| Analytics Admin v1beta | `accountSummaries.list` | OAuth `analytics.readonly` |
| PageSpeed Insights v5 | `runPagespeed` | `PAGESPEED_API_KEY` |
| CrUX History | `records:queryHistoryRecord` | `CRUX_API_KEY` |
| Knowledge Graph Search | `entities:search` | `GOOGLE_KG_API_KEY` |
| Wikidata, Reddit | public search | none |

Read-only is a design constraint (`src/lib/google/scopes.ts`), not a default. Anything below that
needs a write-capable scope is excluded for that reason alone.

---

## 2. Search Console

### 2.1 Endpoints

| Method | Scope | Used | Note |
|---|---|---|---|
| `sites.list` | readonly | yes | |
| `sites.get` | readonly | **no** | One property's `permissionLevel`; `SITE_UNVERIFIED_USER` means no data access. A cheaper Property Access check than listing everything. VERIFIED |
| `searchanalytics.query` | readonly | yes | §2.2 |
| `sitemaps.list` | readonly | yes | Optional `sitemapIndex` lists one index's children. Not passed today. VERIFIED |
| `sitemaps.get` | readonly | yes | `contents[].indexed` is deprecated ("do not use"). VERIFIED |
| `urlInspection.index.inspect` | readonly | yes | §2.3 |
| `sites.add/delete`, `sitemaps.submit/delete` | `webmasters` | excluded | write |
| `mobileFriendlyTest.run` | — | excluded | still in discovery, service retired 2023-12-01. VERIFIED |

**Not in the API as of 2026, although in the UI** (VERIFIED by absence from the reference and the
discovery document): page indexing report in bulk, Core Web Vitals, HTTPS, Links, Manual actions,
Security issues, Crawl stats, Removals, Enhancements, Recommendations, custom annotations (Nov
2025), Insights and query groups (Oct 2025), the **branded queries filter** (Nov 2025, AI-assisted
classification, no API), the **generative AI performance reports** (Jun 2026, UI export only), web
multimodal (2026-09-24, no `type` value), platform properties (Jul 2026; whether `sites.list`
returns them is untested).

Consequence: `gsc_branded_split` is our own approximation, not Google's classification, and must
keep saying so.

### 2.2 `searchanalytics.query`

- Dimensions: `date`, **`hour`**, `query`, `page`, `country`, `device`, `searchAppearance`.
  `searchAppearance` cannot be combined with other dimensions. VERIFIED
- `type`: `web` (default, excludes Discover and Google News), `image`, `video`, `news`,
  `discover`, `googleNews`. Discover and Google News reject `query` and position. VERIFIED
- Filters: `groupType` is `and` only; operators `equals`, `notEquals`, `contains`, `notContains`,
  `includingRegex`, `excludingRegex` (RE2, since 2021). 4096-character max. VERIFIED
- `aggregationType`: `auto`, `byPage`, `byProperty`, `byNewsShowcasePanel`. VERIFIED
- `rowLimit` 1–25,000, `startRow` zero-based; paging past the end returns 0 rows. Google's own
  loop steps `startRow` by 25,000 until empty. VERIFIED
- **`dataState`**: `final` (default), `all` (includes fresh partial data), `hourly_all` (required
  with `hour`; up to 10 days). VERIFIED
- Response `metadata.first_incomplete_date` / `first_incomplete_hour` (camelCase in discovery),
  present only with `all`/`hourly_all` when the range contains partial data. VERIFIED
- Limits: at most 50,000 rows per day per search type; anonymized queries omitted from rows but
  counted in totals; 16 months retained. VERIFIED
- AI Overviews and AI Mode are counted inside `type=web`; there is no `searchAppearance` value for
  either. VERIFIED (the list is dynamic, so "never appears" is INFERRED).

**Gap in our code, VERIFIED by reading it:** `fetchRows` (`src/lib/google/gsc-tool-shape.ts`)
reads one page of 5,000 rows and never pages. Neither `dataState` nor `hour` is used anywhere.

### 2.3 URL Inspection

`indexStatusResult`: `verdict`, `coverageState`, `robotsTxtState`, `indexingState`,
`lastCrawlTime`, `pageFetchState` (12 values incl. `SOFT_404`, `REDIRECT_ERROR`),
`googleCanonical`, `userCanonical`, `sitemap[]`, `referringUrls[]`, `crawledAs`.
`richResultsResult.detectedItems[]` with per-item issues. `mobileUsabilityResult` is deprecated.
Inspects the indexed version only; no live test. VERIFIED

### 2.4 Quotas

Search Analytics 1,200 QPM per site and per user. URL Inspection **2,000 per day and 600 per
minute per property**. Sites and sitemaps 20 QPS / 200 QPM per user. VERIFIED
(<https://developers.google.com/webmaster-tools/limits>)

---

## 3. Google Analytics 4

### 3.1 Scope facts that shape design

- Every Admin API read accepts `analytics.readonly` except `searchChangeHistoryEvents`
  (`analytics.edit`), `accessBindings.*` (`analytics.manage.users.readonly`) and Data v1alpha
  `chat` (`analytics.chatbot.read`). VERIFIED
- `measurementProtocolSecrets.list` returns `secretValue` under the read-only scope. Any Tool
  reading it must not print the value. VERIFIED
- **There is no Search Console link resource** in either Admin version. The four
  `organicGoogleSearch*` metrics are in the Data API and need a link; there is no Search Console
  query dimension. VERIFIED
- GA4 has had an **AI Assistant** default channel since 2026-05-13 (`medium = ai-assistant`). Not
  applied retroactively (INFERRED from third-party reports). `ai-referrers.ts` already treats it as
  the primary rule.

### 3.2 Data API methods not used yet

| Method | Version | Readonly | Value |
|---|---|---|---|
| `batchRunReports` | v1beta | yes | Up to 5 reports per call, same property |
| `comparisons` field, saved comparisons in `getMetadata` | v1beta | yes | |
| `cohortSpec` | v1beta | yes | Retention of organic cohorts |
| `returnPropertyQuota` | v1beta | yes | Tokens consumed/remaining per request |
| `runFunnelReport` | v1alpha | yes | Funnels, own quota bucket |
| `getPropertyQuotasSnapshot` | v1alpha | yes | Quota without running a report |
| `reportTasks`, `audienceExports` | v1alpha / v1beta | yes | Async, create objects on GA's side |

Response metadata we read today: `dataLossFromOtherRow`, `samplingMetadatas`,
`subjectToThresholding`. **Not read:** `dataTruncationReasons` (new 2026-09-14), `emptyReason`,
`schemaRestrictionResponse`. **Bug, VERIFIED by reading the code:** `ga4-report.ts` reads
`samplingMetadatas ?? subjectToThresholding` into one "thresholding" caveat, so a sampled report is
reported as thresholded.

### 3.3 Admin API reads useful for an audit

`properties.get` (industry, time zone, currency, `serviceLevel`), `getDataRetentionSettings`
(TWO_MONTHS … FIFTY_MONTHS), `dataStreams.list`, `getEnhancedMeasurementSettings` (alpha; site
search, scrolls, outbound clicks, forms…), `getDataRedactionSettings` (alpha), `keyEvents.list`
(`countingMethod`), `customDimensions/customMetrics.list`, `channelGroups.list` (alpha),
`getAttributionSettings` (alpha), `getGoogleSignalsSettings` (alpha),
`getReportingIdentitySettings` (alpha), `googleAdsLinks.list`, `bigQueryLinks.list` (alpha),
`reportingDataAnnotations.list` (alpha), `runAccessReport` (administrators only). VERIFIED

Not in the Admin API at all: data filters, internal traffic rules, cross-domain and unwanted
referrals, consent settings. VERIFIED

### 3.4 Quotas

Standard property: 200,000 tokens/day, 40,000/hour, 14,000 per project per property per hour,
10 concurrent. Core, Realtime and Funnel have separate buckets. VERIFIED
(<https://developers.google.com/analytics/devguides/reporting/data/v1/quotas>)

---

## 4. PageSpeed Insights and CrUX

- **PSI will stop returning CrUX field data** ("We plan to discontinue including real-world data
  … We recommend the CrUX API"). No date. VERIFIED
  (<https://developers.google.com/speed/docs/insights/v5/get-started>)
- PSI runs **Lighthouse 13** since 2025-10-20; performance audits became `*-insight` audits.
  Our parser walks `auditRefs` generically, so nothing is keyed on a removed id. VERIFIED (code)
- Lighthouse 13.3 added an **`agentic-browsing`** category (agent accessibility tree, WebMCP,
  llms.txt). Whether PSI accepts it from third-party callers is INFERRED; test with a key.
- `lighthouseResult.entities[]` attributes origins to first- or third-party vendors. VERIFIED
- CrUX `queryRecord` (daily, 28-day window) and `queryHistoryRecord` share a 150 QPM quota.
  History accepts `collectionPeriodCount` 1–40, default 25 — **we ask for the default**. VERIFIED
- Metrics beyond the vitals, in both APIs: `round_trip_time`, `navigation_types` (incl.
  `back_forward_cache`), `form_factors`, `largest_contentful_paint_resource_type`, and the four
  LCP image subparts. Experimental ad metrics since 2026-09-15. VERIFIED
  (<https://developer.chrome.com/docs/crux/methodology/metrics>)

## 5. Knowledge Graph and Wikimedia

- Knowledge Graph Search API is being migrated to Cloud Enterprise Knowledge Graph and is "not
  suitable for use as a production-critical service". VERIFIED (<https://developers.google.com/knowledge-graph>)
- Wikimedia enforces rate limits since 2026: 10/min by IP alone, 200/min with a compliant
  User-Agent. Ours carries `ThatSEOAgentBot/1.0` with a URL. VERIFIED
  (<https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits>)

---

## 6. Crossings of reads we already make

None of these needs a new API. Each answers something no single Tool does today.

1. **Search to value, per page.** Search Console `page` × GA4 `landingPage` (engagement, key
   events): pages that earn clicks and do not engage, pages that convert and are barely seen.
   Today only `run_site_audit` crosses the two, and only as totals.
2. **Orphans and zombies.** `crawl_site` × Search Console pages × sitemap: pages with impressions
   and no internal link; pages in the sitemap or crawl with no impressions.
3. **Title versus the query it ranks for.** `gsc_page_query_map` × title and H1.
4. **Core Web Vitals by traffic.** Busiest pages × CrUX per URL.
5. **Schema declared versus detected.** Markup on the page × `richResultsResult`.
6. **What AI-referred pages share.** `ga4_ai_traffic` landings × content signals and GEO checks.
7. **AI crawlers versus AI traffic.** robots.txt per AI crawler purpose × AI-referred sessions.
8. **Countries without a local version.** Country impressions × hreflang alternates.
9. **`lastmod` honesty.** Sitemap `lastmod` × `lastCrawlTime`.
10. **Content decay.** Monthly page clicks across 16 months.

## 7. New sources

| Source | Answers | Auth / cost | Verdict |
|---|---|---|---|
| Bing Webmaster Tools | Backlinks, Bing queries, crawl issues | free, `webmaster.read` | **Deferred by the Operator, 2026-09-24** |
| Wayback CDX | First seen, content changes (`collapse=digest`), status history | none; ~60/min INFERRED | Fit |
| Open PageRank | Domain authority 0–10 (Common Crawl) | free token, 30k domains/month | Fit |
| Web Risk `uris.search` | Is the site flagged as unsafe | key + billing, 100k/month free | Fit; Search Console exposes no Security Issues |
| Cloud Natural Language | Entities with salience, categories | key + billing, 5k units/month free | Fit |
| Microsoft Clarity export | Dead/rage clicks, scroll, by URL | project token, 10 requests/day | **Removed by the Operator, 2026-09-24** |
| Wikimedia pageviews | Brand interest over time | none | Fit |
| Business Profile, Merchant API | Local, free listings | read/write scopes only | Excluded: no read-only scope |
| Indexing API, IndexNow, Keyword Planner | — | write or gated | Excluded |
| Google Trends API | — | application-only alpha | Watch |
| Cloudflare Radar, Safe Browsing | — | non-commercial licence | Excluded; Web Risk replaces Safe Browsing |
| Rich Results Test | — | no public API | Nothing to add |

---

## Sources

Search Console: <https://developers.google.com/webmaster-tools/v1/api_reference_index>,
<https://developers.google.com/webmaster-tools/v1/searchanalytics/query>,
<https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data>,
<https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult>,
<https://developers.google.com/search/blog/2025/04/san-hourly-data>,
<https://developers.google.com/search/blog/2025/11/search-console-branded-filter>,
<https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports>,
<https://support.google.com/webmasters/answer/7042828>.
Analytics: <https://developers.google.com/analytics/devguides/reporting/data/v1/rest>,
<https://developers.google.com/analytics/devguides/reporting/data/v1/changelog>,
<https://developers.google.com/analytics/devguides/config/admin/v1/rest>,
<https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema>,
<https://support.google.com/analytics/answer/9756891>,
<https://support.google.com/analytics/answer/10737381>.
CrUX and PSI: <https://developer.chrome.com/docs/crux/api>,
<https://developer.chrome.com/docs/crux/history-api>,
<https://developer.chrome.com/blog/moving-lighthouse-to-insights>,
<https://developers.google.com/speed/docs/insights/release_notes>.
Others: <https://github.com/internetarchive/wayback/blob/master/wayback-cdx-server/README.md>,
<https://openpagerank.keywordseverywhere.com/docs>, <https://cloud.google.com/web-risk/pricing>,
<https://docs.cloud.google.com/natural-language/docs/reference/rest>,
<https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api>,
<https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html>.

## What was taken up

Implemented on 2026-09-24, everything in §2–§7 except:

- **Bing Webmaster Tools** — deferred by the Operator.
- **Microsoft Clarity** — built, then removed at the Operator's request the same day: it
  needs Clarity installed on the site, reads one site per token, and allows 10 requests
  a day, which makes it the least SEO-relevant of the sources.
- **`sites.get`** — reviewed and dropped. Property Access (`property-access.ts`) matches a
  *domain* against the properties the account holds, which needs the whole list whatever
  the method; `sites.get` only answers for an identifier already known, so it saves
  nothing here.
- **`batchRunReports`, comparisons, cohorts, `reportTasks`, `audienceExports`,
  `runAccessReport`** — no Tool needed them yet. `returnPropertyQuota` is used by
  `ga4_run_report` and `ga4_funnel_report` instead of `getPropertyQuotasSnapshot`.

Corrections found on the way and fixed: Search Console reads now page past 25,000 rows
(default ceiling 50,000, Google's own); GA4 sampling and thresholding have separate
caveats and `dataTruncationReasons` is read; `pagespeed_insights` takes field data from
the CrUX API; `crux_history` reads 40 periods; a `BILLING_DISABLED` refusal names billing;
a Search Console window of `days: N` now spans N days (it spanned N + 1); Google-Extended
is documented as governing grounding in Gemini Apps as well as training; Mistral's three
crawlers are in `ai-crawlers.ts`.

Found while building, and verified:

- Open PageRank moved to `POST /v1/domains/bulk` with a Bearer token; the old `API-OPR`
  endpoint answers 404.
- Google's sitemap guide says `lastmod` is used only when "consistently and verifiably
  accurate". It does not say generated-time stamps are ignored; `site_lastmod_accuracy`
  labels that as inference.
- GA4 data retention "only affects explorations and funnel reports", not standard
  reports (<https://support.google.com/analytics/answer/7667196>).
- Microsoft documents no crawler behind Copilot's answers; `site_ai_crawler_traffic`
  maps Copilot to Bingbot and labels it inference.

Not verified against live APIs, for want of credentials: every GA4 Admin and funnel
read, CrUX `queryRecord`, PSI's `agentic-browsing` category (probably refused — the
documented enum has four categories), Web Risk, Natural Language, and Open PageRank's success
payload.
