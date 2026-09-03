# tsa-mcp

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `thatseoagent/mcp`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Ported code

`src/lib/analyzers/` and most of `src/lib/` came out of the retired web app
verbatim, comments included. Their references to `#337`-style issues, to
`lib/utils/…` paths and to modules that did not travel are explained in
`docs/agents/ported-code.md`. Read it before "fixing" a pointer that does not
resolve.
