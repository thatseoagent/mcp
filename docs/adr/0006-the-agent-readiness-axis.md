---
status: accepted
---

# The agent-readiness axis, reconstructed

The three `agent-*` analyzers cite **ADR-0025** eight times, twice by rule number,
and that record is the retired app's. It did not travel. Nor did the three
documents beside it: `docs/agent-discovery.md`, `docs/agent-api-surface.md` and
`docs/agent-navigability.md` are cited from the module headers and are not in this
repository.

So the rules constraining 2,579 lines — `agent-discovery.ts`,
`agent-api-surface.ts` and `agent-navigability.ts`, the deepest modules here,
three exports each — exist only inside their own comments. This record is those
rules, reconstructed from the citations, so a change to that tier has something to
be checked against.

**It is a reconstruction, and the numbering is theirs.** Rules 6, 7 and 8 are
named in the code and recovered from what the code does with them. Rules 1–5 were
not cited and are not guessed at. Where this record says something the citations
did not, it is marked.

## The axis

An agent-readiness check is an **assertion about a document a server served or a
response it returned**. Nothing on this axis says anything about ranking or
citation.

That is what separates these three from `geo-analyzer` and
`ai-visibility-analyzer`, and the module headers say so: those two are "our model
of how an answer engine picks text — legitimate, disclosed as ours, and per
`docs/google-search-central-conformance.md` §3.1 unfalsifiable". These are facts a
reader can reproduce, which is why every finding ships the `curl` line that
produced it.

The corollary is the one that bites: **validate the payload, not the status.**
Every defect the original scan found was a 200 response with a structurally
incomplete body, and a checker that asserts reachability finds none of them.

## Rule 6 — same-site is eTLD+1

A document may point our next request at a host, and we follow it only within the
same registrable domain.

Cited twice for two different pointers, and the reasoning is identical: a
discovery document's authorization-server pointer, and an OpenAPI spec's declared
`servers`. `agent-discovery.ts` states the trade-off in full — refusing a
subdomain "would make the traversal check useless on every site that separates
the two", while following anywhere "would mean a document on example.com could
aim our request at `tenant.auth0.com` — a third party we were never asked to
audit, whose response we would then report as the site's, under a `curl` line
pointing at someone else's server."

`agent-probe.land()` enforces the same line for redirects, one level down: an
off-host hop is recorded as a finding and not followed.

## Rule 7 — read-only and unauthenticated

Every request on this axis is a `GET` or a `HEAD` with no credentials.
`agent-probe.ts` says it is "a rule of the axis rather than a property of this
file", which is why it is here rather than in a comment there.

## Rule 8 — a question we did not ask costs nothing

An unanswerable check is `not-evaluated` and leaves both sides of the score. It
is never a zero, and it is never folded into a failure.

Three places lean on this, each with its own wording problem solved:

- A probe that failed takes `couldNotRun`, whose sentence promises the reader
  this is not a finding about their site.
- A probe **robots.txt disallowed** takes `disallowed` instead, because
  `notScored`'s sentence would be two lies at once: it claims innocence on the
  page's behalf when the cause is the page's own robots.txt, and it says "try
  again" when trying again is what we have undertaken not to do.
- An off-host hop is neither. The hop is a fact about the site, so the sentence
  must not claim innocence for it — but we never followed it, so whether the path
  404s is genuinely unknown, and "charging 20 points for an unasked question is
  the thing ADR-0025 forbids."

`agent-navigability` broke the second of those. Every check in it reached for
`couldNotRun` on a failed probe and none read `blockedByRobots`, so a site whose
robots.txt disallowed the probe path was told "this is not a finding about the
page" about its own instruction. `disallowed()` was written for exactly that and
had five adapters in the two sibling tiers and none here. It is one helper now,
rather than a branch in ten checks, for the reason `agent-probe.ts` gives about
the same-host guard: two copies of a distinction is the copy that eventually stops
drawing it.

## Not priced: having an API at all

"Publishes an OpenAPI spec" is informational and worth nothing. It is a property
of having an API, and **a site with no API must not read as a site with a failing
one.** The gate belongs in the other checks' `not-applicable`, not in a zero here.

## Consequences

Restructuring this tier is constrained by rules that were, until now, only in
comments. A gather/judge split — collecting the `Probe`s in one part and judging
them in a pure one, the way `EeatInput` and `GeoInput` already split their
analyzers — must preserve all of the above; in particular rule 8, since the
three-state distinctions are the part a refactor would most easily flatten.

**`agent-navigability` has that split**: `probeNavigability` makes the three
requests, `judgeNavigability` is pure, and `auditAgentNavigability` is both. It
was free there because the dependency order is settled before any judging starts.

**The other two keep their shape, and should.** Their gathering *is* a walk driven
by what it has read: in `agent-discovery`, whether the server card was found
decides whether llms.txt is fetched at all, a parsed endpoint decides the scoped
`oauth-protected-resource` path, and rule 6 applied to a declared authorization
server decides the next URL; in `agent-api-surface`, `findSpec` walks candidate
paths and the spec it parses decides where the error probe goes. There is no point
at which the I/O has finished and the judging has not begun, and forcing one would
mean either fetching unconditionally — losing the documented "the common case
costs one request fewer" — or a "gather" containing the judgements, which is no
split at all.

Splitting navigability is what surfaced the rule-8 breach recorded under rule 8.

Rules 1–5 are unrecovered. If a change appears to need one, the honest move is to
decide it here rather than to infer it from the code that was written under it.

Rules 6 and 7 are not just this axis's business. `robots-gate.ts` and
`ssrf-guard.ts` enforce overlapping constraints for every fetch, and
`http-client.ts` now owns the two obligations for all of them. Nothing in this
record loosens any of that.
