# Reading code ported from the web app

Everything under `src/lib/analyzers/`, and most of `src/lib/`, was extracted from
the That SEO Agent web app rather than written here. The extraction was
deliberately verbatim: the code and its comments moved together, because the
comments are where the reasoning behind each threshold, each three-state check and
each correction lives, and rewriting them in transit is how that reasoning gets
lost.

The cost is that some pointers in those comments do not resolve in this
repository. When you meet one:

**`#337`, `#340`, `#341`, `#342`, `#343`, `#346`, `#348`, `#397`** — issues in the
retired app's tracker, not in `thatseoagent/mcp`. Read them as dates in the
argument the comment is making ("this was wrong once, here is why it is now
right"), not as something to go and look up. This repo's own issues are on
[GitHub](https://github.com/thatseoagent/mcp/issues) and are cited as links.

**`geo-tools`, `ai-visibility-tools`, `eeat-tools`, `entity-mentions-tools`** —
the retired handlers, one per file, that this repo splits into `src/tools/`, one
file per **Tool**. The Tool names in `metadata.name` are the stable identifiers;
prefer them when you edit a comment.

**`lib/utils/…`, `lib/tools/shared/…`, `lib/mcp/…`** — the retired layout. `utils`
and `shared` are both `src/lib/` here, and `lib/mcp/tool-failure.ts` is
`src/lib/tool-failure.ts`.

**`ADR-0022`, and any ADR number above 0004** — the retired app's decision log.
This repo's records are in [`docs/adr/`](../adr/) and start again from 0001.

**`ADR-0025`** was the exception, and is no longer one. It is cited eight times
across the three `agent-*` analyzers, twice by rule number, so those 2,579 lines
were constrained by a record nobody here could read. Its rules are reconstructed
in [ADR-0006](../adr/0006-the-agent-readiness-axis.md) and the citations now point
there. Rules 1–5 were never cited and are not guessed at.

**`docs/agent-discovery.md`, `docs/agent-api-surface.md`,
`docs/agent-navigability.md`** — cited from those same module headers for "what
these checks may claim", and retired with the web app. What survived of them is
the axis section of ADR-0006; the module headers say so where they name the file.

**`report-findings`, `CheckRow`, `cache-manager`, the shared report and the
dashboard** — code that retired with the web app. A comment comparing this
module's behaviour to one of those is describing a decision, not a dependency you
are missing. (`crawlability-analyzer`, `security-analyzer`, `hreflang-analyzer`
and `site-crawler` were once on this list and have since been extracted; they are
under `src/lib/`.)

The three documents those comments cite most often did come across, because they
are the provenance for what the analyzers claim:

- [`docs/google-search-central-conformance.md`](../google-search-central-conformance.md)
  — what Google actually states, and every rule we removed because it did not.
  Partly pinned by `tests/lib/analyzers/google-conformance.test.ts`. Its section 3
  describes behaviour this code deliberately does **not** have, and says so at the
  top of the section; read it as a record of decisions, not of features.
- [`docs/research/checks-that-cannot-run.md`](../research/checks-that-cannot-run.md)
  — the audit of checks that scored a site for a question nobody managed to ask,
  which is where the third state in `scored-checks.ts` comes from.
- [`docs/research/ai-visibility-sources.md`](../research/ai-visibility-sources.md)
  — the attribution behind every figure in `ai-visibility-analyzer.ts`.

All three were translated into English during the extraction. They were written in
a mix of Spanish and English in the app, so a phrasing that reads like a
translation usually is one; the figures, quotations and dates were not touched.
