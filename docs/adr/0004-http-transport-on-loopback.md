---
status: accepted
---

# HTTP transport on loopback, with no authentication

The server speaks MCP over HTTP rather than stdio, superseding
[ADR-0001](./0001-stdio-only-with-local-sqlite.md). It binds to loopback, and the
endpoint is unauthenticated, with cross-origin requests refused.

The reason is the Operator's preference, and it is worth recording plainly rather
than dressing up. HTTP does buy real things — one server can answer several MCP
clients, it can be inspected while running, it survives the client restarting,
and it is the only shape that could later be deployed — but none of those were
needs anyone had stated, and ADR-0001 had weighed and rejected exactly this
option on exactly those grounds. Nothing factual overturned that reasoning; the
call was made anyway, and this record exists so the next reader knows that is
what happened.

## No authentication, and what stands in for it

The endpoint is unauthenticated. It binds `127.0.0.1` and answers whatever
reaches it, which is the ordinary posture for a tool running on the Operator's
own machine — xmcp's documentation frames it the same way, noting that a local
server "can typically skip authentication" because it "runs in the user's own
environment with their permissions".

An earlier version required a shared key, first by refusing to start without one
and then by generating one into `.env`. Both were removed: for a loopback server
the key protected against very little and got in the way in practice.

**What does not survive that reasoning is CORS.** Loopback is reachable from a
browser, and xmcp's default is `origin: "*"` — so any web page the Operator
visited could drive their Tools from JavaScript, with their Google credentials.
That is not a local-trust situation at all, and it is why `xmcp.config.ts` sets
`cors: { origin: false }`. MCP clients are not browsers and send no `Origin`
header, so they are unaffected.

The residual risk is stated rather than solved: any other process on the machine
can use this server. That is accepted for a single-user desktop and would not be
acceptable on a shared or multi-user host.

## Consequences

**The server still runs on the Operator's own machine.** HTTP is the transport,
not a deployment: nothing here is hosted, and loopback is the default bind. So
the storage decision ADR-0001 made stands — a SQLite file under `db/` is fine,
because the filesystem it sits on is the Operator's.

That holds only while the server stays local. Deploying it to a host with an
ephemeral filesystem silently loses the database, so **deployment and storage have
to be decided together**, and that is the moment to reach for a remote SQLite
(libSQL) or Postgres — not the moment to discover the file is gone.

The listening address is compiled into the bundle, since `xmcp.config.ts` is
evaluated at build time. `src/lib/server-address.json` holds it — read both by
`src/lib/server-address.ts` and by the launcher, which is plain Node and cannot
import TypeScript — and moving the server means rebuilding.

**A port collision fails the start.** xmcp increments rather than failing —
"Port 3737 is in use, trying 3738 instead" — so a client configured with the
compiled URL would silently stop reaching the server while a healthy one ran
beside it. `scripts/start.mjs` is the entry point (`pnpm start` and the published
`bin`) and closes that: it binds the port before loading the bundle and refuses
with a message naming the port and what holds it, then binds again after startup
to confirm the listener really is on the compiled number. The second check reads
backwards on purpose — once our own server is up the bind must *fail*, so a bind
that succeeds means the port is free and the server went elsewhere. That covers
the window between releasing the first probe and xmcp claiming the port, which
the first check cannot see.

Choosing an unpopular port is still worth doing, but it is no longer the defence.

Nothing else changes. There is still no caller identity, no per-user state, and
no request context to thread.
