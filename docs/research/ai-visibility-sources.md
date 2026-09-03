# Sources Behind the AI Visibility Framework ("The Data Sieve")

> Source: Aaron Haynes / Loganix — *"Sources Behind 'This Is How AI Visibility Actually Works'"*.
> *"Every claim traced to data. 108 entries across 88 sources."* What follows is the public
> **subset** Haynes shared; the full corpus (108 entries) belongs to Loganix.
>
> This file exists so that the figures our scorer uses (`src/lib/analyzers/ai-visibility-analyzer.ts`)
> stay **versioned alongside their attribution**. A figure in the code that does not appear here, or
> is attributed to the wrong study, is a candidate for correction. See the final section for the
> external anchors we added ourselves.

---

## Market Data
- **Ethan Smith / Graphite, Mar 2026** — AI = 56% of search, 83% mobile, 300% YoY. (graphite.io/five-percent/ai-is-much-bigger-than-you-think)
- **Ahrefs, Mar 2026** — 863K keywords. Google→AI overlap: 76% → 38%.
- **Conductor, Mar 2026** — 21.9M queries. AIOs in 25% of searches.
- **BrightEdge, Feb 2026** — ~17% top-10 overlap (independently confirmed).
- **Semrush, Feb 2026** — 10M+ keywords. AIOs shifting to commercial intent.

## Entity & Citation Data
- **Yext, Oct 2025** — 6.8M citations. **Listings = 42% for location queries.** *(Note: the "48.7%" that circulated in the code was a secondary cut of this same study — restated, see the corrections below.)*
- **Bernard Huang / Clearscope, Jan 2026** — ChatGPT vs Gemini citation logic mechanics.
- **ConvertMate, Jan 2026** — **Active review profiles = 3x ChatGPT citation.** *(This is where the "3x" actually comes from; it is NOT about author/Person schema.)*
- **Loganix Direct Testing, Mar 2026** — 0/300 category queries cited press releases.
- **Miriam Ellis / Search Engine Land, Aug 2025** — Structured + unstructured citations feed AI.

## Content & Retrieval Architecture
- **Kevin Indig / Gauge, Feb 2026** — 1.2M citations. **44.2% from the first 30% of the text** (the "ski ramp"). Also: five characteristics of cited text, and grounding budget (~800w → 50% coverage vs ~4000w → 13%).
- **McGill NLP (Siva Reddy lab), Mar 2026** — LLM2Vec-Gen: embeddings encode answers, not queries. arxiv.org/abs/2603.10913
- **SAH Researchers, Feb 2026** — Pre-training = permanent knowledge layer. arxiv.org/abs/2602.15829
- **Yang / Binghamton, Jul 2025** — 366K citations. Power-law concentration. arxiv.org/abs/2507.05301

## Platform Behavior & Conversion
- **Passionfruit + Ahrefs** — Only 12% of cited sources match across platforms.
- **Exposure Ninja + Semrush + WaPo, 2025–26** — AI traffic converts 5.1x better than Google.
- **Profound / Mike King, Feb 2026** — SEO factors explain only 4–7% of AI citations. *(Reinforces that the score is directional, not determinative.)*

## Reddit
- **SE Ranking, 2025** — Reddit in 97.5% of product review queries.
- **Forrester / 6sense via Sprout Social** — 72% of tech decision-makers use Reddit.
- **Reddit Q4 2025 Earnings** — Training data licensing: Google, OpenAI confirmed.

## AI Architecture Research
- **Wang & Sun, NYU/UVA, Jul 2025** — Interference degrades retrieval log-linearly. 35 LLMs. arxiv.org/abs/2506.08184
- **GaRAGe Benchmark, Jun 2025** — 60% factuality ceiling. 31% deflection rate. arxiv.org/abs/2506.07671
- **ICLR 2026 Submission** — Format causes accuracy shifts independent of content.

---

## External anchors NOT in The Data Sieve (added by us)

The Data Sieve is solid and traceable, but it is **practitioner aggregation** — several of its
headline figures rest on a single study each (Indig, ConvertMate, Dejan AI). These two external
anchors complement and qualify it:

- **GEO: Generative Engine Optimization** — Aggarwal, Murahari et al., **arXiv 2311.09735, KDD 2024**
  (Princeton / Georgia Tech / Allen AI). The only **peer-reviewed** work that quantifies tactics:
  adding statistics, citations and quotations raises visibility by **up to 40%**. This is the
  academic backing for the L4 approach.
- **Ahrefs — "We Tracked 1,885 Pages Adding Schema" (May 2026)** — a **causal** study (1,885
  treated against 4,000 control): adding schema does NOT raise citations (AI Overviews −4.6%,
  AI Mode +2.4%, ChatGPT +2.2%). It **contradicts** the faith placed in schema, which is why our
  L4 does not score schema as a lever.

---

## Corrections applied to the scorer as a result of this cross-check

| Figure in the code (before) | What the source actually says | Action |
|---|---|---|
| "author schema = 3x higher AI answer appearance" | The 3x is about **active review profiles** (ConvertMate), not author schema | Removed from author schema; re-anchored to review profiles in L1 |
| "directory presence gates 48.7% of AI local citations" | Yext: **42% of citations for location queries** come from listings (48.7% was an OpenAI-only cut) | Restated as "~42% of location-query citations (Yext)" |
| word count sweet spot 600–1800 | Framework / Indig / Dejan: **800–1,500** | Adjusted to 800–1500 |

Outstanding (second pass, fidelity): measure the density of **named entities** rather than numeric
statistics, remove or downweight Speakable, and hold freshness at ≤30–60d with a note about the
platform split.
