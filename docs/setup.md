# Setting this up from nothing

Follow this on a clean machine and you end with a working server and a Full
Report. It is written to be followed rather than read: every step says what to do
and what you should see.

There are three stages, and **the first one works on its own**. Stop after it if
all you want is the credential-free Tools.

1. [Install and connect](#1-install-and-connect) — no accounts, no keys.
2. [Google Cloud and the login](#2-google-cloud-and-the-login) — for Search
   Console and Analytics.
3. [Your first Full Report](#3-your-first-full-report).

If something goes wrong, [Common failures](#common-failures) maps the message you
saw to the fix.

---

## 1. Install and connect

### What you need

Node 24 or newer, and an MCP client. Check Node with:

```bash
node --version
```

### Install

```bash
git clone https://github.com/thatseoagent/mcp.git
cd mcp
pnpm install
pnpm build
```

`pnpm install` compiles a native module (`better-sqlite3`). If it prints
`ERR_PNPM_IGNORED_BUILDS`, see [Common failures](#common-failures).

### Start it

```bash
pnpm start
```

You should see:

```
✔ MCP Server running on http://127.0.0.1:3737/mcp
```

Leave it running. The server binds loopback only, so nothing outside this machine
can reach it.

### Connect your MCP client

Point it at `http://127.0.0.1:3737/mcp`. In a client that takes JSON:

```json
{
  "mcpServers": {
    "thatseoagent": {
      "url": "http://127.0.0.1:3737/mcp"
    }
  }
}
```

There is no API key and no token. The server is unauthenticated because it
listens on loopback on your own machine — see
[ADR-0004](./adr/0004-http-transport-on-loopback.md).

### Check it works

Ask your client:

> Validate the robots.txt for wikipedia.org

You should get a report naming the crawlers Wikipedia blocks. If you do, the
install is finished and around forty Tools are available to you right now:
everything named `seo_*`, plus `crawl_site`. They read a site's public surface and
work on **any** domain, including ones you do not own.

**You can stop here.** The rest of this document is about reading your own Search
Console and Analytics data.

---

## 2. Google Cloud and the login

The Search Console and Analytics Tools read *your* data, using *your* Google
account, through an OAuth client *you* create. Nothing in this server holds a
credential that could reach anyone else's account, and the quota consumed is
billed to your own project.

This takes about ten minutes and you do it once.

### 2.1 Create a Google Cloud project

1. Go to <https://console.cloud.google.com/projectcreate>.
2. Name it anything — `seo-mcp` is fine.
3. Click **Create**, and wait for it to be selected.

### 2.2 Enable the two APIs

Both are free. With your project selected:

1. Go to <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com>
   and click **Enable**.
2. Go to <https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com>
   and click **Enable**.
3. If you also want `ga4_list_properties` to work, enable
   <https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com>.

### 2.3 Configure the consent screen

Google will not issue a client without this.

1. Go to <https://console.cloud.google.com/apis/credentials/consent>.
2. Choose **External** unless you have a Google Workspace organisation, in which
   case **Internal** is simpler.
3. Fill in the app name and your own email for both support fields. Nothing else
   is required.
4. On the **Scopes** step, add nothing. The login command asks for what it needs
   at the time.
5. If you chose **External**, add your own Google account under **Test users**.
   Without this Google refuses the login with `access_denied`.

### 2.4 Create the OAuth client

**The application type has to be "Desktop app".** That is the only type Google
permits a `localhost` redirect for, and a localhost redirect is the only route
left since Google retired the copy-paste flow in 2022. See
[ADR-0002](./adr/0002-google-login-via-local-cli.md).

1. Go to <https://console.cloud.google.com/apis/credentials>.
2. **Create credentials** → **OAuth client ID**.
3. Application type: **Desktop app**.
4. Name it anything. Click **Create**.
5. Copy the **Client ID** and **Client secret**.

Google's own documentation notes that a Desktop-app secret cannot be kept
confidential. It is required by the token endpoint; it is not protecting
anything.

### 2.5 Put the credentials in `.env`

Create a `.env` file at the root of the server — there is a `.env.example` beside
it listing every variable — and put the two values in it:

```bash
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

A file rather than `export`, because both the login command and the server need
these and `export` only reaches the shell you typed it in. That is the mistake
that looks like the login not having worked: you export in one terminal, log in
there, start the server in another, and the server has nothing.

`.env` is gitignored. A variable already set in your shell still wins over the
file, so a one-off `GOOGLE_CLIENT_ID=... pnpm login` is still the way to try a
second account without editing your configuration and putting it back.

### 2.6 Log in

```bash
pnpm login
```

The command prints the two permissions it is about to ask for, opens your
browser, and waits. Authorize, and it prints:

```
Logged in.
```

You do this once. The server refreshes the access token internally from then on.

### What the two scopes buy

| Scope | Without it |
|---|---|
| `webmasters.readonly` — Search Console | Every `gsc_*` Tool refuses, and `run_site_audit` cannot produce a Full Report: no impressions, clicks, positions, index coverage or URL inspection. |
| `analytics.readonly` — Analytics (GA4) | Every `ga4_*` Tool refuses, including `ga4_ai_traffic`, which is the only way to see visits arriving from AI assistants. |

Both are **read-only**. This server never submits a sitemap, requests indexing,
or writes anything to your Google account. Search Console offers a read-write
scope and this deliberately does not ask for it.

Tokens are stored unencrypted in the local database. That is deliberate: the file
is on your machine and gitignored, and an encryption key sitting in the adjacent
environment file would protect nothing.

### 2.7 Restart the server

`.env` is read once, when the process starts, so a server that was already
running does not have the credentials you just added. Stop it with Ctrl-C and
start it again:

```bash
pnpm start
```

Nothing to re-type: it reads the same file the login command did.

---

## 3. Your first Full Report

Ask your client:

> Which Search Console properties can you read?

That runs `gsc_list_properties`. You should see your properties, each marked as a
**Domain Property** (`sc-domain:example.com`) or a **URL-Prefix Property**
(`https://example.com/`), with the permission level on each.

Then:

> Run a full site audit for example.com

`run_site_audit` registers the Site, checks with Google that you can read its
property, and produces the Full Report — public surface, Search Console and
Analytics together. It records every number it measures.

**It refuses rather than degrading.** If Google is not connected, or you do not
have access to that property, it says which and stops, instead of returning the
public-surface half dressed as a complete report. See
[ADR-0003](./adr/0003-tools-fail-rather-than-degrade.md).

### Analytics needs one more thing

GA4 identifies a property by a number, not a domain, so it cannot be inferred.
Ask:

> Which Analytics properties can you read?

Then pass the one you want:

> Run a full site audit for example.com with ga4PropertyId properties/123456789

The Site remembers it, so you only do this once per site.

### Run it again in a week

The second run is where the database earns its place. `run_site_audit` compares
against the last one, and `seo_metric_trend` shows the whole series.

---

## Common failures

**`ERR_PNPM_IGNORED_BUILDS` during install**
pnpm blocks install scripts by default and `better-sqlite3` is a native module
that needs one. `pnpm-workspace.yaml` in this repo already approves it; if you
still see this, run `pnpm approve-builds better-sqlite3` and install again.

**`Port 3737 on 127.0.0.1 is already in use`**
Something else has the port. The message names what. Stop it, or change the port
in `src/lib/server-address.json` and rebuild — the address is compiled into the
build, which is why the server refuses to move rather than starting somewhere
your client is not looking.

**`There is no build to run: dist/http.js does not exist`**
Run `pnpm build`. If you already did, check whether `pnpm dev` is running in
another terminal — it owns `dist/` too and rewrites it on every change, so the
two cannot run at once.

**Your client cannot reach the server**
Check the server is still running and that the URL ends in `/mcp`. Cross-origin
requests are refused by design, so a browser-based client will not work.

**`GOOGLE_CLIENT_ID is not set`**
There is no `.env`, or it does not carry that line. Copy `.env.example` to `.env`
and fill it in. If you added it while the server was running, restart the server —
the file is read once at startup.

Check you are running from the directory that holds `.env`: it is read relative to
the working directory, which is where `pnpm` puts you.

**Google says `access_denied` in the browser**
Your consent screen is **External** and your own account is not in **Test users**.
Add it at <https://console.cloud.google.com/apis/credentials/consent>.

**Google says `redirect_uri_mismatch`**
The OAuth client is not of type **Desktop app**. No other type permits a
localhost redirect. Create a new client with the right type; you cannot change
the type of an existing one.

**`Google did not return a refresh token`**
A previous grant is still active. Remove this app at
<https://myaccount.google.com/permissions> and run `pnpm login` again.

**`No Full Report for example.com: No Search Console property found`**
This Google account holds no property covering that domain. Add and verify the
site at <https://search.google.com/search-console>, or run `pnpm login` again to
switch accounts. The credential-free Tools work on it regardless.

**`...property found but not verified`**
The property exists and verification was never completed, so Google returns no
data for it. Finish verification in Search Console — this is one step, not a
setup.

**`Google Search Console returned HTTP 403`**
The key was refused. Check that the Search Console API is enabled for the project
your OAuth client belongs to.

**A Tool says something "could not be evaluated"**
That is the Tool being honest rather than failing. A check that did not run is
never reported as a check that passed. Run it again; if it persists, the message
names what could not be reached.
