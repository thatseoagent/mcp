---
status: accepted
---

# The owner's wording stays, though nothing reads it

`seo-rules.ts` gives every rule two wordings. `practitioner()` is the line
`seo_analyze_page` prints — "Title is 84 characters and may be truncated" — and
`reader` is the site owner's version: a severity, a title, a why, and sometimes a
target. `asFinding()` renders the second.

**Nothing calls `asFinding()`.** The consumer was `report-findings`, which built
the shared report page, and it retired with the web app; `CONTEXT.md` lists
**Shared Report** under retired vocabulary. So eleven `reader:` blocks and the
function that renders them are an interface with no adapter, and an architecture
review will keep noticing that — as one did.

They stay.

## Why

The two audiences are real, and `seo-rules.ts` argues it at length: a
practitioner wants the measurement, an owner wants what it costs them. What was
never real was the two copies of *the rule itself*, and that is what the module
fixed. Deleting the owner's copy would not undo the fix; it would throw away the
editorial half.

And the halves are not equally expensive. A threshold is a number and a
`CheckSource` is a citation — both cheap to restore. The owner's copy is written
prose that had to be argued over once, per rule, and rewriting eleven of them is
the part nobody wants to do twice. `docs/agents/ported-code.md` says the
extraction was deliberately verbatim because "the comments are where the
reasoning behind each threshold, each three-state check and each correction
lives, and rewriting them in transit is how that reasoning gets lost". The same
holds for the copy.

The cost of keeping it is bounded and visible: a reader of `seo-rules.ts` has to
learn that `reader` and `asFinding` have no live consumer. This record is that
sentence, so they learn it once.

## What was narrowed anyway

Keeping the copy is not a reason to keep everything. Removed, because each was an
export with no caller and nothing but a line or two to restore:

- `needsRenderedContent(verdict)` — a predicate exported for a caller to filter
  with, and no caller ever did. A seam with no adapter, and the guard it describes
  was therefore applied nowhere: `seo_analyze_page` reported "Missing H1 heading"
  about pages whose copy a browser assembles. `evaluatePage` applies it now and
  reports what it could not ask, which is where a rule's own decision belongs.
- `DESCRIPTION_LIKELY_TRUNCATED` — `TITLE_LIKELY_TRUNCATED` has one outside
  reader in `site-crawler`; this had none. A number nobody outside can see is a
  number nobody outside can copy, which is this file's whole point.
- In `vital-thresholds.ts`: `vitalThreshold`, `RANKING_VITALS`, `goodBelow`,
  `targetPhrase` and `formatVitalValue`. The first four were the retired summary's
  and help dialog's phrasings; the fifth is how the surviving two are built and is
  private now. `goodUnder` and `poorAbove` remain, with callers.

`ALL_RULE_IDS` also has no production caller and stays exported: its test asserts
no rule is stated twice, and TypeScript has no way to export to a test file only.
That is the same **internal seam** the `score*` functions in `geo-analyzer.ts`
are, and it is noted in both places.

## Consequences

An architecture review that flags `asFinding` and the `reader:` blocks as a
shallow two-audience interface is reading the code correctly and should be
answered with this record rather than with a deletion.

If a second audience returns — a shared report, an email digest, a client PDF —
it inherits eleven rules already worded for it. If one never does, the cost is
this page.
