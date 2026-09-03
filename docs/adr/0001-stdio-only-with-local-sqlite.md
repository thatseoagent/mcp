---
status: superseded by ADR-0004
---

# stdio-only, with a local SQLite database

> **Superseded by [ADR-0004](./0004-http-transport-on-loopback.md).** The
> server ships over HTTP. The reasoning below is kept because the risk it names —
> a Single-tenant server handing the Operator's Google credentials to whoever
> reaches it — did not go away with the decision; ADR-0004 answers it a different
> way, and anyone loosening that answer should read this first.


This server was extracted from a Next.js app that served MCP over HTTP on Vercel,
authenticating each caller by API key against Postgres. We dropped the multi-tenant
model entirely, and without it a deployed HTTP endpoint would hand whoever found the
URL the Operator's own Google credentials. So the server ships as a **stdio server
only**, with its database as a **SQLite file under `db/`**, gitignored.

## Considered options

- **HTTP with a shared API key in env.** Roughly ten lines of xmcp middleware, and it
  keeps a deployable server. Rejected because it re-opens questions the local-only
  posture closes for free (where the file lives when the filesystem is ephemeral,
  what the key rotates against, who owns the deployment) in exchange for a mode
  nobody asked for yet.
- **libSQL/Turso**, which serves both a local file and a remote URL through one
  dialect. Rejected for now: it only pays off if HTTP comes back, and it asks the
  Operator to consider a hosted account they don't need.
- **Postgres/Neon**, as before. Rejected because it forces every user to provision a
  database — and possibly pay — before running a single tool.

## Consequences

Nothing in the codebase may key behaviour on caller identity, and there is no request
context to thread. SQLite has no `uuid`, `timestamp` or `date` types, so ids are text
and instants need an explicit encoding and helpers; the old schema's LATERAL JOINs
have to be rewritten. Deploying this server as a remote service is a new project, not
a config flag.
