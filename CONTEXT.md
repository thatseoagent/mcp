# tsa-mcp — Ubiquitous Language

An MCP server that exposes SEO analysis tools. Extracted from the That SEO Agent
web app, which is being retired. This glossary is the single source of truth for
domain language — use these exact words in code, docs, commits and conversation.

## Language

**Tool**:
A single SEO capability the server exposes to an MCP client, discovered from its
file under `src/tools/`.
_Avoid_: endpoint, command, function, API

**Operator**:
Whoever runs an instance of this server. There is exactly one per instance, and
the server never distinguishes between callers.
_Avoid_: user, account, tenant, customer

**Single-tenant**:
The property that one running instance serves one Operator with one set of Google
credentials, so no code may key behaviour on caller identity. One instance still
covers many Sites — an Operator may be an SEO consultant managing several clients.

**Basic Analysis**:
What the Tools that need no credentials report about a Site from its public surface
alone. Always available. It is a set of Tools, not a degraded Full Report — nothing
falls back to it.
_Avoid_: quick audit, free tier, limited analysis

**Full Report**:
What the server can report once it has Property Access to a Site, adding Search
Console and Analytics data on top of the Basic Analysis.
_Avoid_: premium report, complete audit, paid analysis

**Property Access**:
Whether the Operator's Google account can actually read a Site's Google Property.
Verified against Google, never assumed or stored as an entitlement.
_Avoid_: permission, entitlement, authorization, ownership

**Content Signal**:
A phrasing or structure in a page's copy that answer engines read — a stated
figure, a question-phrased heading, a summary block, listicle formatting,
definitional phrasing. Detected in one place, `analyzers/content-signals.ts`, and
scored or reported separately by whoever asks: the same detection backs a GEO
check worth points and a `seo_content_analysis` measurement worth none. The
phrasings that vary by language come from `answer-patterns.ts`, which says
`unsupported` for a language it cannot read rather than failing a correct page.
_Avoid_: GEO signal (the detection is not GEO's), pattern, heuristic

## Rules

**A Tool that cannot do its whole job says so; it never returns less and stays quiet.**
Missing credentials, missing Property Access or a missing database are all reported as
an error naming what to configure. A partial result presented as a whole one is the
failure this rule exists to prevent.

**Site**:
A domain the Operator analyses, registered in this instance. It has no owner: every
Site in the database belongs to the Operator running the server.
_Avoid_: project, property, client, domain (as an entity)

**Google Property**:
How Search Console or Analytics names a Site on Google's side, either a Domain
Property or a URL-Prefix Property. A Site is linked to one; the two are not the
same thing and the words are not interchangeable.
_Avoid_: site (for the Google-side name), GSC site

## Retired vocabulary

Terms inherited from the web app that have **no** meaning here. Their presence in
new code is a bug, not a naming preference.

**User**, **Account**, **API Key** (as an identity), **MCP Admission**,
**Admitted Session**, **Guarded MCP Server**, **Audit Log**, **Waitlist**,
**Slack Connection**, **Shared Report**.

### There is nothing to buy, so nothing is rationed

The web app sold access, and a whole vocabulary served that: **Plan**,
**Effective Plan**, **Subscription**, **Comped Account**, **Trial**, **Site
Limit**, **Active Site**. None of it survives, and the point is stronger than
"those words are retired": **no Tool here reports less than its whole answer
because of who is asking or how much they have asked for.** Every Tool is
available to every Operator, every registered Site is readable by every Tool,
and nothing counts Sites, calls or runs in order to decide what to return.

A Tool can still be unable to answer — no credentials, no Property Access, no
database — and the rule above says what it does then. That is a missing input,
not a ration, and the two must never be phrased alike.

The caps that do exist are none of this, and a reader meeting one should know
which kind it is:

- **Politeness.** `crawl-pacing.ts` spaces requests to one origin and `robots-gate.ts`
  obeys robots.txt, because every fetch carries `ThatSEOAgentBot` and an
  unthrottled loop is us hammering a stranger's server under our own name.
- **Somebody else's ceiling.** Google rations URL inspections per property per day
  and caps a Search Analytics request at 25,000 rows. Asking for more does not
  get more.
- **Reading length.** `crawl_site` walks 25 pages by default and 50 at most, and
  `hreflang` checks 25 alternates: each one is a stated reading depth a caller can
  see, not an allowance.
- **Print length.** `render-list.ts` truncates a long list and says how many rows
  it withheld. The data was read; the lines were not printed.
