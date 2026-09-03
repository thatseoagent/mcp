# Conformance with Google Search Central

> **This document audits what we CLAIM, not how we CALL the API.** The second
> question had its own record in the retired application; it did not exist until
> 2026-08-30, and by then it had twelve accumulated defects. The distinction was
> not explicit, and that cost.

> **What this document is.** The contract between our analyzers and the official
> Google Search Central documentation, read on **2026-07-31**. It describes
> implemented behaviour. Every rule in section 1 is pinned by
> `tests/lib/analyzers/google-conformance.test.ts`, with the tests grouped by the
> Google sentence that settles them.
>
> The rule this document pins: **thatseoagent does not invent SEO rules.** If
> Google does not say it, we do not report it as a problem. If Google says the
> opposite, we correct it. If it is our own judgement, we label it as our own
> judgement.

## Why it matters

Google publishes a page specifically about third-party SEO tools
([`/search/docs/fundamentals/third-party-seo`](https://developers.google.com/search/docs/fundamentals/third-party-seo)):

> "Third-party tools don't have access to our internal ranking data. They can't
> guarantee performance." "Any predictions are their own and like predictions
> generally, may not happen."

Our only defence against that is traceability. A report that cannot separate
Google's rules from its own is making exactly the claim Google warns about.

---

## 1. Rules Google does not have, and that we no longer apply

Ten checks reported as a problem something Google explicitly says is not one.
They are documented with their previous state on purpose: anybody who wants to
restore one of them needs to know they would be arguing with Google.

### 1.1 Word-count minimums

**Before:** `Low word count (N words, recommended ≥300)` and `Below optimal word
count (recommended ≥600)`, in `onpage-seo.ts`, `content-analyzer.ts` and the
retired report builder; and in the site crawler as `thin_content` with critical
severity below 150 words.

**Google:** "The length of the content alone doesn't matter for ranking
purposes." ([SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide))

The 300 and the 600 are industry folklore. And calling it `thin_content` was
worse than inventing a threshold: it mapped the finding to a **real spam policy**
about pages with no added value, so an 80-word contact page came back flagged as
a spam risk.

**Now:** no finding depends on length. `wordCount` is still reported as a metric.
The crawler returns `shortPages`, an ordered list with no verdict attached,
because there is no length at which Google considers a page deficient.

### 1.2 A single H1, and skipped heading levels

**Before:** `Multiple H1 headings found (N)` and `Skipped heading level` mixed in
with the SEO findings. GEO additionally required `Exactly 1 H1 tag` and deducted
3 points for having two.

**Google:** "From Google's perspective, it doesn't matter if you're using them
out of order", and on the count, "there's no magical ideal number".

**Now:** a missing H1 is still reported, because a page with no H1 has not stated
its subject anywhere. Order and count are emitted with the accessibility label
they deserve (`HEADING_ACCESSIBILITY`, WCAG 2.2 §1.3.1) and with Google's
position written into the finding's own text. In GEO the check became "Page
states its subject in an H1".

### 1.3 Missing canonical

**Before:** `Missing canonical URL` as an issue, and `No canonical tag found` as
a `warning`.

**Google:** "While we encourage you to use these methods, **none of them are
required**; your site will likely do just fine without specifying a canonical
preference." ([Canonicalization](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls))

**Now:** `info`, with the real text: without an explicit canonical Google picks a
URL, which is a decision rather than a defect. It is only worth setting if the
page is reachable at more than one URL.

### 1.4 A canonical pointing elsewhere: this was a bug

**Before:** `crawlability-analyzer.ts` raised a `self_reference` conflict with the
message `Canonical does not reference self` every time the canonical pointed
somewhere else.

That is **exactly what** `rel="canonical"` **is for**. A URL with filter
parameters pointing at its clean version is doing the right thing, and we flagged
it. Google documents self-reference as a recommendation *on the canonical page*,
not on the duplicates; the code did not distinguish the two roles.

**Now:** the `self_reference` type no longer exists. What is checked are the shape
errors Google does name: a relative canonical (Google discards it, so the page
believes it declares one and has none), a canonical pointing at a fragment, an
unparseable canonical, and an HTML canonical that differs from the HTTP header.
`cross_domain` is kept as critical, with the note that it is legitimate for
syndicated content.

### 1.5 Character limits on title and description

**Before:** title 10–60 characters, description 50–160.

**Google (title):** "The title link is truncated in Google Search results as
needed, **typically to fit the device width**." No limit is published.
**Google (description):** "**There's no limit on how long a meta description can
be.**"

Truncation is by pixels and by device. A 62-character title of narrow letters
fits; a 55-character one of wide letters does not. And the 50-character minimum
for the description had no basis at all: Google asks for unique and relevant, not
long.

**Now:** there are no minimums. Above deliberately high thresholds
(`TITLE_LIKELY_TRUNCATED` 70, `DESCRIPTION_LIKELY_TRUNCATED` 165) the finding says
"may be truncated", never "too long", and the text names the real reason.

### 1.6 `llms.txt` scored as a positive signal

**Before:** 3 points in `geo-analyzer`, 7 in `ai-visibility-analyzer`, with the
text "signals AI-ready infrastructure and entity transparency to LLM crawlers",
and a priority-2 recommended action to create it.

**Google:** its generative-AI optimization guide lists it among the things it does
**not** use: Google Search does not read llms.txt, and it neither helps nor hurts.
([Optimizing for generative AI](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide))

It was the sharpest contradiction in the product: a tool whose premise is "we
check what Google checks" spent a recommendation on a file Google ignores,
justified with language nobody backs. No other engine has published that it reads
it either.

**Now:** 0 points in both analyzers, and no recommended action. It is still
detected and reported for what it is: harmless to maintain, and it contributes
nothing.

### 1.7 Schema: two conflicting rules in the same file

`expectedSchemas()` correctly derives what a page ought to declare from its
identity (homepage, article, product, depth, visible breadcrumb) and explains
every exemption. It is Google's "use the most specific applicable type".

But `detectSchemaIssues()` went on emitting the older fixed list in parallel, so a
single report said both "Organization is not required here" and "Missing
Organization schema".

**Now:** `detectSchemaIssues` only judges what it can judge on its own — missing
required properties and invalid JSON. These were withdrawn:

- `Missing WebSite`: it was asked of every URL; only the homepage owes it.
- `Missing Organization`: the same question, already answered with a reason.
- `Duplicate schema types`: several nodes of one type is normal and permitted.
- `Multiple schema formats`: Google accepts JSON-LD, Microdata and RDFa; it
  recommends the first, it does not forbid mixing.

### 1.7bis E-E-A-T: a byline is required where one might be expected, not on every page

**Google:** the self-assessment asks whether pages carry "a byline, where one
might be expected". The `Article` type is described for "your news, blog, and
sports article pages" and states "There are no required properties; instead, add
the properties that apply to your content", with `author` under *Recommended*. No
Google page says that a product, a category, a home, a legal or a tool page must
carry an author.

**Before:** `eeat-analyzer` knew nothing about page type. Its two largest
indicators, "Author bio / credentials" (10 pts) and "Author published elsewhere"
(8 pts), plus certifications (5) and "Last updated date" (5), were required of
every URL. A product page lost 28 of 100 points for lacking a byline and a date it
never should have carried. `geo-analyzer` already excluded **the same signals**
with `isUnauthoredPage` / `isUndatedPage`, so one report could say both things at
once.

**Now:** all four indicators are derived from the page's identity, exactly as §1.7
did for "Missing X schema", and every exemption says which kind of page it is and
why. The points leave the numerator **and** the denominator, so the percentage is
over what the page could have earned. On an article all four are still required.

It is the same criterion as §1.7 applied to another module: if Google phrases the
expectation conditionally, we do not turn it into a universal requirement.

### 1.7ter Security headers: HSTS is not required over `http://`

**RFC 6797** §7.2: "An HSTS Host MUST NOT include the STS header field in HTTP
responses conveyed over non-secure transport." §8.1: "If an HTTP response is
received over insecure transport, the UA MUST ignore any present STS header
field(s)."

**Before:** on an `http://` URL we asked for that header and deducted 20 of 94
points plus a CRITICAL. A fifth of the grade for complying with the
specification. The implementation guide already printed "requires HTTPS", so the
fact was in the file and not in the arithmetic.

**Now:** the check does not apply when the transport is not secure, it leaves both
sides of the fraction, and the recommendation names the real finding, which is the
transport and not the header. CSP, `X-Frame-Options` and `Referrer-Policy` are
**not** excluded: their specifications place no condition on transport and they
work over `http`.

### 1.7quater Evidence that does not support the claim

**The problem:** the mirror image of the unanswerable-check audit. That one
charged for a question that could not be answered; this rewarded an answer that
had not been earned, and nearly always by the same route: the check said "the
page's copy" and consulted the whole document. The chrome is identical across
every page of a site, so a correct breadcrumb, a footer with social icons and a
row of partner logos scored the same on every URL.

**Now**, by kind of failure:

- **Scope.** `ReadableDocument` already distinguished copy from chrome for *text*
  (`mainContent()` against `allText()`) and did not do so for *elements*.
  `countInContent()` closes that asymmetry, and with it: a breadcrumb `<ol>` stops
  proving worked examples (3 pts), the social footer stops proving the author's
  footprint (5), footer links stop proving cited sources (5), and `<code>` is
  counted inside the content.
- **Definition.** "Author bio / credentials" (10 pts) accepted any `Person` or any
  `author` key on any node, so a testimonial's `Person` won it outright. Now
  `findPageAuthor` resolves the author **of the main entity**, following `@id`
  references. "Author published elsewhere" additionally accepted a top-level
  `sameAs`, which on almost every site is the Organization's: the company's social
  profiles scored as the author's.
- **Withdrawn to 0 points.** "Before/after evidence" (5 pts) awarded 5 for two
  words out of nine in the copy, and no word list demonstrates that a page shows a
  before and an after. "Detailed technical content" loses its image branch:
  counting images is not evidence of technical depth at any threshold. They are
  named for the reader and score nothing, following the `llms.txt` precedent in
  §1.6. The module's maximum drops from 100 to 95.
- **Restated.** "Listed in *vertical* directories" (7 pts) claimed to be listed on
  G2 / Clutch / Yelp and measured outbound links from a page. The evidence is
  asymmetric: linking the profile is weak but real evidence that it exists, while
  not linking it proves nothing. It is now called "Links to *vertical*
  directories", scores when it finds one, and is `not-evaluated` when it does not
  — which is to say, out of the denominator.

### 1.7quinquies Checks a Spanish-language page could not pass

**The problem:** 35 points across `ai-visibility-analyzer` and `eeat-analyzer`
moved with the page's language and with nothing else. **This product is sold in
Spanish**, so a customer analysing their own site lost points for writing in their
own language, and there was no way to explain it to them.

No Google guidance supports what we were doing: its helpful-content documents say
nothing about writing formulas in a particular language, and the `lang` on `<html>`
is a signal Google reads, not one it penalises.

**Now**:

- **Language as an input, not an assumption.** `page-language.ts` reads what the
  page declares and `answer-patterns.ts` holds the patterns per language, Spanish
  and English. If the page declares a language with no pattern set, the check is
  `not-evaluated` and the detail names the language: the points leave the
  denominator and the reader knows the limitation is ours. Adding Spanish
  alternatives alongside the English ones would have fixed Spanish and left German
  broken without saying so, which is the shape of the bug rather than its fix.
- **With no declared `lang`, every set is tried.** The attribute is missing on a
  great many real pages and the `lang-missing` rule already reports it; emptying
  the scorecard over it would cost far more than the rare false positive this
  risks.
- **Figures.** The statistic pattern matched `million`, `billion` and `thousand`,
  so "2 millones" did not count. Spanish has its own.
- **Accented entities.** `entityDensity` required `/^[A-Z][a-zA-Z]/`, which meant
  `Ángel`, `México` and `Öhlins` were not proper nouns. Now `\p{Lu}\p{L}`.
- **Headings that ask a question.** The `[^<]*` regex could not match a heading
  with any nested tag, and in Spanish the opening `¿` usually sits next to markup.
  They are read from the heading's visible text.
- **Wikidata and Knowledge Graph.** The search always went out in English, so an
  item labelled only in Spanish was invisible; and the term was the first label of
  the hostname rather than `Organization.name`, even though that name was already
  computed twenty lines further down in order to print it. It now asks in the
  page's language and with the name the page declares.
- **Withdrawn to 0 points.** "Industry terminology" awarded 4 points for more than
  ten words of 12+ letters. Spanish morphology produces those far more often, so it
  measured the language rather than the vocabulary. A per-language threshold does
  not fix it, it redistributes it. The E-E-A-T maximum drops from 95 to 91.

Outstanding and not done: there is no language-bias audit for the remaining
analyzers. This list is what came out of auditing the ones above.

### 1.8 `robots.txt`: `crawl-delay` accepted, `Noindex:` not warned about

**Google:** "Google supports the following fields (**other fields such as
`crawl-delay` aren't supported**): user-agent, allow, disallow, sitemap."

**Now:** `crawl-delay` is still parsed but reported as ignored by Google, with the
note that other crawlers do honour it. `Noindex:` and `Nofollow:` in robots.txt
are detected as a conflict, because they look like they work and do not. `Host`,
`Clean-param`, `Request-rate` and `Visit-time` are identified by name instead of
falling into "Unknown directive". And the 500 KiB limit is reported, past which
Google discards the rest of the file.

### 1.9 Language codes: false criticals from an allowlist

**Before:** `language-validator.ts` validated against two hand-written `Set`s, of
~70 languages and ~60 countries, both labelled "not exhaustive". Everything
outside them came back as `critical: Invalid language code`, including `zh-Hant`
(Google's own example) and `es-419` (Latin America, our market).

**Google:** ISO 639-1 for the language, ISO 3166-1 Alpha 2 for the region, **and
ISO 15924 for the script**.

**Now:** the BCP 47 *shape* is validated (`language[-Script][-REGION]`) against the
complete ISO 639-1 register, with alphabetic or UN M49 numeric regions. What is
still flagged is the error Google names — writing a region where a language goes —
but as a *warning*: the cases that survive validation are precisely the dangerous
ones, because `uk` is Ukrainian and a British site using it is correctly annotated
for the wrong audience.

### 1.10 Redirect-chain thresholds

**Before:** a warning from 3 hops ("Recommended: ≤2") and another from 2. Google
publishes no hop limit at all.

**Now:** loops and a missing `Location` are still reported, because those do
break. Chain length is emitted above 3 hops labelled as our own heuristic, with
the true reason: latency and fragility, not ranking.

---

### 1.11 GEO recommendations that asserted mechanisms nobody published

**Before:** `geo-analyzer`'s action map closed nearly every line with a claim about
machinery no vendor documents. Among others: "cited 2× more by AI than generic
prose", "increase AI citation rates ~2x", "extracted by AI engines at ~3× the rate
of prose paragraphs", "this length is the sweet spot", "Q&A format is the most
cited content structure by AI engines", "AI engines treat blockquoted content as
high-credibility citation anchors".

**Google:** its generative-AI optimization guide lists among the **unnecessary**
things precisely the two techniques those numbers were selling: splitting content
into small pieces so AI can understand it, and writing in a specific way solely
for generative AI.
([Optimizing for generative AI](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide))

It is §1.6 again and at scale. No AI engine publishes citation rates, so a
multiplier there measured nothing: it was invented. And what made it invisible is
that `geo-analyzer` was the only analyzer without a single call to `annotate()`, so
its findings reached the reader indistinguishable from the ones that cite Google.

**Now:** all 37 checks declare a `source` and are annotated when rendered, and the
action map's rule is written into the code: *an action may say what to change and
what becomes true of the page; it may not say what an engine does in response*.
Three exceptions earn it, and all three are verifiable: a blocked crawler
demonstrably cannot read the page, Google publishes what `noindex` does, and the
two Q&A lines cite the Ahrefs causal study by name so the reader can go and argue
with it.

The 40–60 word threshold **is still shown**, because without it a failed check is
not actionable. What it no longer does is send anyone off to write to that
measurement: it says the number is ours and that writing for it is not the point.

Also closed in §2.6.

## 2. Gaps closed

### 2.1 A `noindex` Google will never be able to read

> "Keep in mind that these settings can be read and followed only if crawlers are
> allowed to access the pages that include these settings."
> [Robots meta tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)

We had both pieces and never crossed them. A page with `Disallow` **and**
`noindex` is not deindexed: Google never fetches it, so it never sees the
directive, and the URL can keep appearing from inbound links. The owner believes
it is hidden.

`src/lib/analyzers/robots-ruleset.ts` implements path matching the way Google
documents it (most specific user-agent group, then longest pattern, ties to
`allow`, `*` and `$` wildcards with the rest literal), and
`crawlability-analyzer` crosses it with indexability.

When robots.txt cannot be read, the answer is `null` and the finding is **not**
emitted. "I don't know" and "it is not blocked" are different things.

### 2.2 Links Google cannot follow

Google enumerates exactly what it does not follow: `<a>` with no `href`,
`routerLink`, `href` on a `span` or a `div`. They were invisible to us in the
worst way: every counter selects `a[href]`, so a page whose entire navigation was
`<span onclick>` reported zero problems and zero internal links, which reads as
"there are no links" rather than "the links are unreachable".

`findUncrawlableLinks()` detects them, and the finding cites a concrete example
rather than a count.

### 2.3 Uniqueness of titles and descriptions

Already covered: the site crawler builds `titlesMap` and `descriptionsMap` and
`crawl_site` reports the duplicate groups. Google asks for this explicitly ("use
distinct titles", "unique descriptions for each page").

---

### 2.4 Agent operability

Implemented in `src/lib/analyzers/agent-operability.ts`, reported by
`seo_analyze_page`.

Of everything the generative-AI guide recommends building, this is the only
sentence that names a mechanism:

> "Agents may interact with your site by analyzing visual rendering, inspecting the
> DOM, and interpreting the accessibility tree."

And the accessibility tree is derived from the DOM by published rules, so it can be
checked without a browser: a `<button>` whose content is only an `<svg>` has no
accessible name under any implementation of those rules. It is the only AI-era
check in the product that is a fact rather than a model, and the same fact serves
somebody using a screen reader.

The product had **one** accessibility check before this (heading structure) while
shipping two AI-visibility scores built on inference. That imbalance is what this
closes.

It is marked `accessibility`, not `google`: Google names the mechanism, it does not
say that an unnamed button costs you positions. The criterion is chosen **per
finding**, not once for the module: a control with no name is WCAG 2.2 §4.1.2 Name,
Role, Value; a missing landmark is §1.3.1 Info and Relationships, the same one the
heading check already cites. Citing §4.1.2 for both, as the first draft did, is the
same kind of error as citing the wrong Google page.

What it checks and what it does not: accessible name on controls and links, a label
on form fields (a `placeholder` does not count, and the reason is explained), and
the presence of a `main` landmark. It does not render, so a finding is evidence and
the absence of findings is not, exactly like the rest of the directory (§3.1).

#### 2.4bis The second axis: agent navigability

`agent-operability.ts` was the odd one in the directory because it checked a fact
rather than a model. It is no longer alone: `src/lib/analyzers/agent-navigability.ts`
audits the HTTP facts an agent depends on to traverse a site, not merely to read a
page (a real 404 against a 200 shell, a recoverable 404 body, redirects in HTTP
rather than in JavaScript, `text/markdown` negotiation and `Vary: Accept`, a token
budget, balanced code fences, RFC 8288 `Link` headers).

None of those checks asserts anything about ranking or citation, and that
restriction is exactly what makes them valuable: every finding travels with the
`curl` line that produced it.

### 2.5 The indexability gate

Implemented in `src/lib/analyzers/technical-requirements.ts`, reported by
`seo_geo_score` before the score.

Google defines a minimum for a page to be eligible
([Technical requirements](https://developers.google.com/search/docs/essentials/technical)):

> "As long as your page meets the minimum technical requirements, it's eligible to
> be indexed by Google Search:"

HTTP status only carried weight inside the GEO scoring, 3 points next to
"Blockquote elements present", so a page Google cannot index came back graded like
any other with the reason thirty checks further down. It is a gate now: if it
fails, the report leads with `=== BEFORE ANYTHING ELSE ===` and says how many of
the three checks fail. The score is still computed, because today's 500 does not
invalidate the analysis, it only makes it premature; what changes is the order.

**Two of the three are Google requirements, not three.** This module's first draft
called the third requirement `noindex`, and it is not: the third is "the page has
indexable content", which Google defines as a supported file type plus the absence
of spam-policy violations, neither of which we can check. `noindex` is a different
mechanism documented on a different page. That error put a sentence Google never
wrote in front of customers, which is why the quotations in `check-source.ts` are
now single, unedited sentences.

Three decisions the module makes that are worth not reverting without reading the
tests:

- **`Disallow` is per path.** `Disallow: /admin/` blocks a dashboard, not the site.
- **Blocking GPTBot does not raise the gate.** It is a decision about AI training,
  not a Search problem. The GEO category still reports it.
- **`nofollow`, `nosnippet` and `noarchive` do not remove the page from the index.**
  `none` does, because Google defines it as "Equivalent to `noindex, nofollow`".

### 2.6 Provenance in `ai-visibility-analyzer`, and the fourth kind

Implemented in `src/lib/analyzers/ai-visibility-analyzer.ts` (21 checks and
signals) and in `src/lib/analyzers/check-source.ts`.

This analyzer was **the best-supported in the product and read like the worst**.
[`docs/research/ai-visibility-sources.md`](./research/ai-visibility-sources.md)
traces every figure it reports, and even records the attributions that were caught
and corrected: the "3×" was attached to author schema and belongs to active review
profiles (ConvertMate); the "48.7%" was a secondary cut of the Yext study and was
restated to 42%. None of that reached the reader. A user saw "44.2% of AI citations
come from the first 30% of content" as a bare assertion of ours.

**Why GEO's fix could not simply be copied.** §4 gave three kinds: from Google,
ours, and accessibility. None of them is true of a third-party study. Putting
Indig/Gauge into `heuristic` throws away a measurement over 1.2M citations, and
`google` would be false. Hence the fourth kind, `research`, which carries the
study, the finding and a URL:

```ts
| { kind: "research"; study: string; finding: string; url?: string }
```

The `finding` field is not decorative: it is what the study measured, in its own
terms, and it exists so the check can be held against it. Two checks had a real
source and still exceeded it, and both were corrected here:

- **`"Content length 800–1500 words (AI grounding sweet spot)"`.** Indig and Dejan
  measure *grounding coverage* by length (≈50% at ~800 words, ≈13% at ~4000). That
  is not a rule about how long a page should be, and "sweet spot" is the same
  phrase §1.11 removed from the sibling analyzer. Renamed to "measured
  grounding-coverage range"; the measurement stays, because it is what makes the
  check actionable.
- **`"Q&A structure is the most-cited content format"`.** The source says that 72.4%
  of the posts ChatGPT cited had an answer capsule after a question heading (Indig /
  SEL). That is not "the most-cited format", and no platform publishes a ranking of
  formats.

`provenance` is persisted as a string rather than the `source` object: a `research`
entry carries a study name and a sentence of finding, and storing those on 21
checks of every audit would put the audit trail into the database.

## 3. Open gaps

> ⚠️ **Nothing in this section is implemented.** It describes behaviour the code
> does NOT have, so that an agent does not read it as true. An entry marked
> **wontfix** is stronger than an outstanding item: it is a decision taken, and
> closing it means reversing the decision rather than finding the time.

### 3.1 Rendering

Every analyzer does `fetchHtml` + cheerio. Google executes JavaScript in headless
Chromium before indexing:

> "Some JavaScript sites may use the app shell model where the initial HTML does
> not contain the actual content and Google needs to execute JavaScript before
> being able to see the actual page content."
> [JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)

**Mitigated, not solved.** We do not render, and we are not going to: standing up
Playwright is expensive infrastructure for a problem whose frequency we do not
currently know.

What we do instead is stop asserting what we cannot see. When the GEO check detects
that content arrives via JavaScript, the report replaces the findings that **assert
an absence in the page body** with a single one that explains it and points at
Search Console's URL Inspection.

The distinction that decides what gets discarded is between **asserting an absence**
and **reporting something found**:

- Discarded: `h1-missing` and `schema-none`. They are assertions about what is not
  there, and in unrendered HTML we do not know.
- Kept: `schema-invalid`, `images-alt`, `title-long`. They report something we did
  see, so the verdict is about something real.
- Also kept: the `<head>` ones (title, description, canonical, viewport, lang). An
  SPA serves those statically anyway, so they are as reliable there as on any other
  page.

The analyzers still measure over raw HTML. What changes is that the customer's
report no longer accuses a page of lacking an H1 it probably has.

### 3.2 The guide's local and ecommerce sections: decided against

**wontfix.** Not an outstanding item, a decision (2026-08-01).

The generative-AI guide closes by recommending that local-business and ecommerce
data be optimized: Merchant Center feeds and Google Business Profile. We are not
going to cover it. Neither is a check on a page: they are new API integrations, each
with its own OAuth, its own data model and its own support surface, for a product
whose unit of analysis is a URL.

What we do have from that vertical: `detectVertical` distinguishes `local` and
`ecommerce`, and `buildL3Guide` returns the editorial directories that matter in
each. That covers the part which can be read from outside the site.

It is written down as a decision so nobody reads it as an oversight, and so that if
it is ever reversed, it is reversed on purpose.

### 3.3 The generative-AI performance report has no API

> ⚠️ **Not implementable today.** Verified on 2026-08-01 against the
> [searchanalytics.query reference](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
> and the [search appearance help doc](https://support.google.com/webmasters/answer/7576553).
> **Re-verified on 2026-08-11**, this time against the live discovery doc, after
> Search Console launched its "Generative AI features" section in the interface.

The generative-AI optimization guide recommends measuring with Search Console's
**"Generative AI Performance Report"**. That data is not in the API: the dimensions
are `country`, `device`, `page`, `query`, `searchAppearance`, `date` and `hour`, and
the `type` values are `discover`, `googleNews`, `news`, `image`, `video` and `web`.
No dimension, filter or `type` exposes AI Overviews or AI Mode.

**The report shipped, the API did not change.** Google published the generative-AI
performance reports on 2026-06-03
([announcement](https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports)),
so the interface now shows a section the API does not have. Verified against the
source that cannot be misread, the discovery doc Google serves at
`https://searchconsole.googleapis.com/$discovery/rest?version=v1`, revision
**20260810**:

| Field | Published enum |
|---|---|
| `type` / `searchType` | `WEB`, `IMAGE`, `VIDEO`, `NEWS`, `DISCOVER`, `GOOGLE_NEWS` |
| `dimensions` | `DATE`, `QUERY`, `PAGE`, `COUNTRY`, `DEVICE`, `SEARCH_APPEARANCE`, `HOUR` |
| `ApiDimensionFilter.dimension` | `QUERY`, `PAGE`, `COUNTRY`, `DEVICE`, `SEARCH_APPEARANCE` |

Identical to the enum from before the announcement.

**Why this is not an oversight on Google's part, and why it probably will not arrive
soon.** The [report's help doc](https://support.google.com/webmasters/answer/16984139)
clarifies that its data "includes data from the Web search type of the performance
report": appearances in AI Overviews and AI Mode were **already counted inside
`WEB`**, mixed in with ordinary results. The new section does not add data, it
separates it in the interface. The API still returns the combined total and there is
no way to split it. The report also carries **impressions only**: no clicks, no CTR,
no position, no queries.

The other two routes are closed as well:

- **Bulk export to BigQuery.** The `searchdata_url_impression` schema has no AI
  column at all ([fields](https://support.google.com/webmasters/answer/12917991)). If
  one ever arrives it will be a new `is_*` among the appearance types, and that is
  the second place worth watching.
- **`searchAppearance` as a shortcut.** Google does not expose AI Overviews as a
  value of that dimension. Checked empirically with `gsc_search_appearance` against a
  property with **140,987 impressions over 90 days** (2026-05-10 → 2026-08-09): zero
  search-appearance rows. A site with that volume would return the value if it
  existed.

This is written here because it is exactly the gap an agent tries to close twice.
**Do not close it by scraping the Search Console interface**: that is fragile, it is
against the terms, and the report is still in partial rollout (it started in the
United Kingdom), so a property may not have it. The signal that it can be
implemented is a new value in the discovery doc's enum, not a screenshot of the
interface.

What we do have is `ga4_ai_traffic`, which measures referral traffic from AI engines
in GA4: our own data, and it does not pretend to be a Google metric. On the same side
are `ai_visibility_score` and `entity_mentions`, which measure AI visibility by
mentions rather than by Google impressions.

---

## 4. Provenance per check

Implemented in `src/lib/analyzers/check-source.ts`.

The conflicts in section 1 were not ten independent errors: they were the same error
ten times. Nothing in a check's type forced it to say where it came from, and
`push("Low word count…")` compiled just as well as a real rule.

The correction moves the cost into the type:

```ts
type CheckSource =
  | { kind: "google"; doc: string; quote: string }
  | { kind: "research"; study: string; finding: string; url?: string }
  | { kind: "heuristic"; rationale: string }
  | { kind: "accessibility"; standard: string; seoImpact: string };
```

`research` arrived fourth, with §2.6. The distinction it adds is not cosmetic:
between "we believe this" and "somebody measured it, here is who and where" there is
a difference the reader can verify, and flattening it into `heuristic` gave away the
one asset the product has that competitors do not.

`GOOGLE_SAYS` collects the quotations the code depends on, each with its URL and its
verbatim sentence. When Google revises a page, a single edit moves every finding that
rests on it.

`annotate()` marks the finding in the text the user sees. Google's go unmarked,
because they are the baseline; heuristics and accessibility findings announce
themselves. Nobody is going to write `{ kind: "google", doc, quote }` for a 300-word
minimum, because that sentence does not exist.

The E-E-A-T and GEO scores are our own models. Google says that "E-E-A-T itself isn't
a specific ranking factor"; presenting them without that context suggests a precision
we do not have.

---

## Sources read (2026-07-31, extended 2026-08-01 and 2026-08-11)

Full index: [`/search/docs`](https://developers.google.com/search/docs)

- Search Essentials: overview, [technical](https://developers.google.com/search/docs/essentials/technical), [spam policies](https://developers.google.com/search/docs/essentials/spam-policies)
- [SEO Starter Guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)
- [Creating helpful, reliable, people-first content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- [Optimizing for generative AI](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)
- [Third-party SEO tools and advice](https://developers.google.com/search/docs/fundamentals/third-party-seo)
- [robots.txt intro](https://developers.google.com/search/docs/crawling-indexing/robots/intro) · [spec](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt)
- [Robots meta tag / X-Robots-Tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)
- [Canonicalization](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [Redirects](https://developers.google.com/search/docs/crawling-indexing/301-redirects)
- [Crawlable links](https://developers.google.com/search/docs/crawling-indexing/links-crawlable)
- [JavaScript SEO basics](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)
- [Title links](https://developers.google.com/search/docs/appearance/title-link) · [Snippets](https://developers.google.com/search/docs/appearance/snippet)
- [Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals)
- [Structured data general guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
- [Localized versions / hreflang](https://developers.google.com/search/docs/specialty/international/localized-versions)

Read on 2026-08-01, for §1.11, §2.4, §3.2 and §3.3:

- [Optimizing for generative AI](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) — re-read in full
- [Search Analytics: query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query) · [Search appearance](https://support.google.com/webmasters/answer/7576553)
- [UrlInspectionResult](https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult) — enums for `pageFetchState`, `robotsTxtState`, `indexingState`

Read on 2026-08-11, to re-verify §3.3 after the "Generative AI features" section
launched in the Search Console interface:

- [Introducing Search Generative AI performance reports](https://developers.google.com/search/blog/2026/06/gen-ai-performance-reports) — 2026-06-03 announcement
- [Generative AI performance report (Search)](https://support.google.com/webmasters/answer/16984139) · [(Discover)](https://support.google.com/webmasters/answer/16983858)
- [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features) — "included in the overall search traffic", inside the Web `type`
- [BigQuery export fields](https://support.google.com/webmasters/answer/12917991) — no AI columns
- Live discovery doc: `https://searchconsole.googleapis.com/$discovery/rest?version=v1`, revision 20260810

---

## What was already aligned

| Area | State |
|---|---|
| **Core Web Vitals** | `vital-thresholds.ts` matches exactly: LCP 2.5s, INP 200ms, CLS 0.1, and the "poor" cutoffs at 4s / 500ms / 0.25. It distinguishes the three ranking vitals from FCP/TTFB as diagnostics. |
| **hreflang** | Reciprocity, self-reference, absolute URLs, `x-default`, conflicts between HTML/header/sitemap, duplicates per language. Point for point with Google's documentation. |
| **HTML canonical vs header** | It is a "common mistake" Google names. |
| **Robots meta / X-Robots-Tag** | Both are parsed, and the "most restrictive wins" rule is Google's. |
| **Page identity + expected schema** | `page-identity.ts` + `expectedSchemas()` implement "the most specific applicable type" and do not require irrelevant types. |
| **`schema-mismatch-analyzer`** | Covers "Don't mark up content that is not visible to readers", an explicit structured-data policy. |
