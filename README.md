# thatseoagent-mcp

An MCP server that exposes SEO analysis tools — crawlability, structured data,
Search Console and Analytics — to an agent. It runs on your own machine, over
HTTP, and holds your own Google credentials.

One instance serves exactly one **Operator**: you, whoever runs it. The server
never distinguishes between callers. One Operator still covers many sites — an
SEO consultant managing a dozen clients is one Operator, not a dozen.
[`CONTEXT.md`](./CONTEXT.md) defines this and the rest of the vocabulary.

**New here?** [`docs/setup.md`](./docs/setup.md) takes a clean machine to a working
server and a Full Report, including the Google Cloud steps, and maps every common
failure message to its fix.

## Requirements

Node 24 or newer, and `pnpm`.

Nothing else to start with. Around forty Tools do **Basic Analysis**, which reads
a site's public surface alone and works on any domain, including ones you do not
own. The Search Console and Analytics Tools additionally need **Property Access**
— a Google account that can read the site's Google Property — and the SQLite
database under `db/`. Tokens and database both stay on your machine, and neither
is committed.

## Run it

```bash
pnpm install
pnpm build
pnpm start
```

Anything this server needs configured is read from a `.env` file at its root —
copy `.env.example` and fill in what you want. Nothing in it is required to start:
with an empty file, or none at all, the credential-free Tools work as they are.

A variable already set in your shell wins over the file, and the file is read once
at startup, so a change to it needs a restart.

It listens on `http://127.0.0.1:3737/mcp`. Point an MCP client at that URL — for
Claude Code:

```bash
claude mcp add --transport http thatseoagent http://127.0.0.1:3737/mcp
```

There is no authentication. The server binds loopback only and refuses
cross-origin requests, so a web page cannot reach it, but any process on your
machine can. That is fine for a personal machine and is not a posture to deploy.
See [ADR-0004](./docs/adr/0004-http-transport-on-loopback.md).

## Works with nothing configured

Every Tool below is **Basic Analysis**: it reads a site's public surface and needs
no credentials and no database.

- `seo_robots_validator` — reads a site's `robots.txt` and reports which crawlers
  are blocked, whether AI crawlers may train on the content, which sitemaps are
  declared, and any syntax problems.
- `seo_analyze_page` — one page's on-page SEO: meta, headings, word count, links,
  image alt text, Open Graph, JSON-LD, hreflang, and the issues those add up to.
- `seo_content_analysis` — readability, heading structure and outline, link mix,
  vocabulary, and the GEO signals answer engines read.
- `seo_schema_detection` — the structured data a page publishes, validated, plus
  which schema types this kind of page owes and which are missing.
- `seo_schema_generator` — valid JSON-LD for one of ten schema.org types, with the
  snippet to paste and the placeholders left to fill in.
- `seo_eeat_score` — the on-page signals of Experience, Expertise,
  Authoritativeness and Trustworthiness, scored as a directional checklist.
- `seo_geo_score` — the signals that correlate with being cited by AI answer
  engines, led by the three checks that decide whether Google can index the page
  at all.
- `ai_visibility_score` — whether a site resolves as an entity, what a model would
  know about it, where its category is covered editorially, and whether its
  content is structured to be cited.
- `entity_mentions` — where a brand exists off its own site: Wikipedia, Wikidata,
  Reddit, and the LinkedIn, YouTube and GitHub profiles its homepage links to.
- `crawl_site` — walks a site from a root URL for the findings only a multi-page
  view can produce: duplicate titles and meta descriptions, broken internal links,
  pages buried deep in the click hierarchy, and the shortest pages.
- `seo_crawlability_audit` — what stands between one URL and being indexed: its
  canonical, its redirect chain, and the directives that block indexing.
- `seo_security_headers` — the HTTP security headers a URL sends, graded, with the
  header lines to add.
- `seo_hreflang_validator` — a page's hreflang setup wherever it is declared: HTML,
  the `Link` header, and optionally a sitemap.
- `seo_agent_discovery` — the artifacts an agent looks for before reading a site:
  `llms.txt`, an MCP server card, and the well-known documents that point at them.
- `seo_agent_navigability` — the HTTP behaviour an agent depends on when it reads
  one URL, every finding shipped with the request that produced it.
- `seo_agent_api_surface` — the API a site offers an agent, measured against the
  OpenAPI or MCP description it publishes.
- `seo_llms_txt` — reads and scores a site's `/llms.txt`, and generates one from
  the site's own pages.

Every outbound request obeys the target site's `robots.txt` and paces itself, so a
crawl of fifty pages is never a burst at somebody else's server. Requests identify
themselves as `ThatSEOAgentBot` and carry a URL a webmaster can actually reach.

The scores are readings of signals we can see, not measurements of how any AI
system behaves, and each one says so in its own output. A check that could not run
is reported as not run, never as a failure.

## The entry point

- `run_site_audit` — names a domain and produces the **Full Report**: its public
  surface, Search Console and Analytics together, with every number recorded so
  the next run can be compared against it. Registers the Site if it is new.
- `seo_metric_trend` — reads that history back, per run or month by month.
- `sync_gsc_properties` — registers domains as Sites and asks Google which of
  them a Full Report is possible for.
- `run_page_audit` — audits one page and keeps the result. Run it before and
  after a change and the second run reports what moved.
- `get_page_audits` — reads those back, per Site or per page.

`run_site_audit` **refuses rather than degrading**. Without the Google login, or
without access to that Site's Search Console property, it says what to fix
instead of returning the public-surface half dressed as a complete report — see
[ADR-0003](./docs/adr/0003-tools-fail-rather-than-degrade.md). The
credential-free Tools cover that case, and calling one of them is an explicit
choice rather than a report that quietly left half its subject out.

## Needs the Google login

These read the Operator's own Search Console data. Without the login each is
still listed and returns an error naming the command to run.

- `gsc_list_properties` — the properties this Google account can read, with the
  permission level on each and whether it is a Domain Property or a URL-Prefix
  Property. Start here: the other Tools take one of these identifiers.
- `gsc_search_analytics` — clicks, impressions, CTR and average position, broken
  down by query, page, country, device, date or search appearance.
- `gsc_inspect_url` — what Google knows about one URL: indexing verdict, the
  canonical Google chose, last crawl, robots and directive state, rich results.
- `gsc_bulk_url_inspection` — the same across many URLs, reporting which are
  indexed and where Google chose a different canonical.
- `gsc_list_sitemaps` / `gsc_get_sitemap` — what Search Console has recorded
  about a site's sitemaps: submitted against indexed, warnings, errors.
- `gsc_sites_health_check` — every property at once, so you can tell which are
  worth opening before running anything per-site.

And these read the Operator's own Analytics:

- `ga4_list_properties` — the Analytics properties this account can read,
  grouped by the account each belongs to.
- `ga4_run_report` — any report: pick metrics and dimensions, get rows back.
- `ga4_pivot_report` — two dimensions crossed against each other.
- `ga4_get_realtime` — who is on the site in the last 30 minutes.
- `ga4_metadata` / `ga4_custom_definitions` — what this property can report,
  including the custom fields somebody defined for it.
- `ga4_key_events` — what is converting, and whether anything is even marked as
  a conversion.
- `ga4_check_compatibility` — whether a set of fields can be reported together,
  before you spend a report finding out.
- `ga4_ai_traffic` — how much traffic arrives from ChatGPT, Perplexity, Claude,
  Gemini, Copilot and the rest, which pages they land on, and whether it is
  growing. No other Tool here answers this.

The interpreted read of the same data:

- `gsc_detect_quick_wins` — queries already being seen, just below the fold, that
  nobody clicks. Usually a title problem rather than a ranking one.
- `gsc_detect_trends` / `gsc_detect_lost_queries` — this window against the one
  before it, of exactly the same length.
- `gsc_detect_anomalies` — days that do not look like the rest of the window.
- `gsc_detect_cannibalization` — queries where more than one page appears.
- `gsc_branded_split` — people looking for you by name, versus everyone else.
- `gsc_device_gap` / `gsc_country_opportunity` — where the impressions are and
  where they are not converting.
- `gsc_page_query_map` — what each page is actually understood to be about.
- `gsc_search_appearance` / `gsc_serp_features_gap` — how the results look, and
  which enhancements the site is not part of.
- `gsc_detect_featured_snippets` — inferred from position and CTR, and said to be.
- `gsc_index_coverage_analysis` / `gsc_crawl_freshness` / `gsc_rich_results` —
  Google's own record for a sample of the busiest pages.
- `gsc_discover_performance` — the feed, which has no queries and no ranking.

Every one of these says what it is based on: how many rows it read, whose
threshold it applied, and that an absence of findings is an absence in those rows
rather than a fact about the site.

A bare domain works anywhere a property is asked for: `example.com` is matched
against the properties the account holds, preferring the Domain Property.

## Needs configuration

One Tool needs something set before it can work:

- `pagespeed_insights` — Google's PageSpeed Insights for a URL, reporting both
  halves separately: field data (what real Chrome users experienced over the last
  28 days, which is what Google ranks on) and lab data (one throttled Lighthouse
  run, which is a diagnostic). Needs `PAGESPEED_API_KEY`.

Put it in a `.env` file at the root of the server:

```bash
PAGESPEED_API_KEY=your_key
```

Create the key at [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
and enable the PageSpeed Insights API for its project. The free quota is 25,000
requests a day and needs no billing account.

**Without it the Tool is still listed**, and returns an error naming the variable
and where to get a value. That is the rule for every Tool on this server, recorded
in [ADR-0003](./docs/adr/0003-tools-fail-rather-than-degrade.md): a Tool that
cannot do its whole job says what to configure and never returns a smaller result
instead. Tools stay in `tools/list` whether or not they are usable, because many
MCP clients cache that list and a Tool that vanishes leaves the agent nothing to
explain.

## Prompts and playbooks

Three prompts orchestrate the Tools rather than leaving an agent to pick them by
name: `audit_site`, `find_quick_wins` and `track_progress`. Three playbooks are
readable as MCP resources under `seo://playbooks/` — quick wins, site audit, and
being cited by AI answers.

The server also delivers instructions in the handshake, so an agent knows which
Tool to start with and what a refusal means before its first call. A test asserts
that every Tool name any of those mention actually exists.

## Development

```bash
pnpm test        # unit suite: no network, no credentials, no database
pnpm test:e2e    # builds, then drives the real server over HTTP
pnpm typecheck
```

`pnpm dev` runs the server with reloading.

`pnpm dev` and `pnpm start` cannot run at the same time: both own `dist/`, and
they would fight over the port anyway.

Opening `http://127.0.0.1:3737/` in a browser shows the server's own page — what
is running, what needs no setup, and how to connect. It is generated by
`pnpm home` (which `pnpm build` runs first) and committed, so its Tool count is
never a number somebody forgot to update.

## Google login

The Search Console and Analytics Tools read the Operator's own Google data, so
they need the Operator's own OAuth client. Create one in
[Google Cloud Console](https://console.cloud.google.com/apis/credentials) under
APIs & Services > Credentials, choosing the application type **Desktop app** —
that type is what permits the localhost redirect this login uses
([ADR-0002](./docs/adr/0002-google-login-via-local-cli.md)). Enable the Search
Console API and the Google Analytics Data API for the same project.

Put the two values in `.env` — `.env.example` lists every variable this server
reads — and then log in:

```bash
# .env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

```bash
thatseoagent-mcp-login          # or `pnpm login` from a clone
```

The command prints the two scopes it asks for and what stops working without
each, opens your browser, receives Google's redirect on an ephemeral loopback
port, stores the tokens and stops listening. Both scopes are **read-only**: this
server never submits a sitemap, requests indexing, or writes anything to your
Google account.

You log in once. The server refreshes the access token internally from then on.
Re-running the command switches accounts. Tokens are stored unencrypted in the
local database, which ADR-0002 records as deliberate — the file is local and
gitignored, and a key in the adjacent environment file would protect nothing.

## Persistence

The server keeps a SQLite database under `db/`. It is created on first use and
migrated automatically — there is no command to run. What it holds is history:
Site records, audit runs, metric readings and their monthly rollups, page audits,
and a cache of Tool results so repeating an analysis does not re-crawl the site.

It is optional. With `TSA_DB_PATH=off` in `.env` the server starts anyway, every
credential-free Tool works exactly as before, and nothing is cached or kept.
`TSA_DB_PATH=/some/path.sqlite` puts the file elsewhere.

```bash
pnpm db:generate   # regenerate drizzle/ after editing src/lib/db/schema.ts
```

`pnpm start` goes through `scripts/start.mjs`, which refuses to start when port
3737 is already taken rather than letting the server move to another port — the
listening address is compiled into the build, so a server that moved would leave
your MCP client pointed at nothing. To change the port, edit
`src/lib/server-address.json` and rebuild.

## Design

- [`CONTEXT.md`](./CONTEXT.md) — the domain glossary. Use these words.
- [`docs/adr/`](./docs/adr/) — the decisions that are hard to reverse, and why.
  Read these before changing how the server is reached, how it authenticates to
  Google, or what a tool does when it cannot do its whole job.

## License

MIT — see [`LICENSE`](./LICENSE).
