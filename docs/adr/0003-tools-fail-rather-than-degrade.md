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
