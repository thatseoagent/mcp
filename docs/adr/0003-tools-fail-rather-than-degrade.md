# A Tool fails rather than degrading

A Tool that cannot do its whole job returns an error naming what to configure. It
never returns a smaller result instead. This holds even for `run_site_audit`, the
entry-point tool, and even though the codebase can produce a credential-free Basic
Analysis: if Google credentials or Property Access are missing, `run_site_audit`
refuses rather than reporting on the public surface alone.

The reason is that the Operator usually *does* have the access, so a degraded result
is far more likely to be a misconfiguration we failed to surface than a deliberate
choice — and it arrives looking like a complete report. Tools stay registered in
`tools/list` regardless, because many MCP clients cache that list and a tool that
vanishes gives the agent nothing to explain to the user; an error message does.

## Consequences

Basic Analysis is a set of Tools that need no credentials, **not** a fallback mode.
Nothing degrades into it. An Operator who has configured nothing can still run those
Tools, but cannot run `run_site_audit`, so the cold-install on-ramp is those Tools
alone. Someone will eventually try to make this friendlier by falling back; that is
the change this record exists to stop.

## A scored Tool states its coverage

The rule above governs a Tool that cannot run **at all**. A scored Tool that
*partly* ran is the same failure in a quieter form, and the record did not cover
it: `scored-checks.ts` takes a check that could not be evaluated out of both
sides of the fraction, which is correct — a page should not be charged for a
lookup that timed out — but it means the denominator moves, and a score printed
over a moved denominator is a partial result presented as a whole one.

So: **a Tool that reports a score reports what the score was measured on.** The
two figures come from `tally` and the sentence comes from `renderCoverage`; a
surface that computes either itself has opted out of the rule.

Two Tools had. `seo_eeat_score` printed `Score: 61 / 85` when a site's home page
did not answer, with nothing naming the 15 points that left; `seo_security_headers`
printed a score out of 74 on an `http://` site and had destroyed the record that
HSTS was worth 20, so it could not have named them. Both looked like complete
reports. `tests/lib/analyzers/coverage-travels.test.ts` pins it, for the reason
`no-answer-says-why.test.ts` gives: the correct type and the correct helper were
both already there.
