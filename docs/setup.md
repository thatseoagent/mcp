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
3. Go to <https://console.cloud.google.com/apis/library/analyticsadmin.googleapis.com>
   and click **Enable**. `ga4_list_properties`, `ga4_setup_audit` and
   `ga4_annotations` read it; without it they answer with the page that enables it.

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
file, so a one-off `GOOGLE_CLIENT_ID=... pnpm mcp-auth` is still the way to try a
second account without editing your configuration and putting it back.

### 2.6 Log in

```bash
pnpm mcp-auth
```

The command prints the two permissions it is about to ask for, opens your
browser, and waits. Authorize, and it prints:

```
Logged in.
```

You do this once. The server refreshes the access token internally from then on.

Google sends you back to `http://127.0.0.1:3738/callback`, the same address on
every login. The command listens there only until the redirect arrives, then
stops. You do not register it anywhere: a **Desktop app** client accepts any
loopback address. It is deliberately not 3737, so you can log in while the server
is running.

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

## Billed Google Cloud APIs

Two Tools read sources that need a key of their own. Nothing above depends on
them; set up only the ones you want. Each Tool that is missing its key says which
variable to set and where to get it.

### `GOOGLE_CLOUD_API_KEY` — `web_risk_check` and `page_entities`

Both APIs need **billing enabled** on the Google Cloud project, even inside their
free tiers. That is a different decision from the free `PAGESPEED_API_KEY`, so
this is a separate variable: the PageSpeed key never has to live on a billed
project.

1. Pick or create a project with billing at
   <https://console.cloud.google.com/billing>.
2. Enable what you need on it:
   - `web_risk_check`: the Web Risk API,
     <https://console.cloud.google.com/apis/library/webrisk.googleapis.com>.
     The first 100,000 lookups a month are free, then $0.50 per 1,000
     (<https://cloud.google.com/web-risk/pricing>).
   - `page_entities`: the Cloud Natural Language API,
     <https://console.cloud.google.com/apis/library/language.googleapis.com>.
     Entity analysis is free for 5,000 units a month and classification for
     30,000; a unit is 1,000 characters of text
     (<https://cloud.google.com/natural-language/pricing>). The Tool sends at most
     10,000 characters of a page, and the page's text goes to Google Cloud.
3. Create an API key at <https://console.cloud.google.com/apis/credentials> and
   put it in `.env` as `GOOGLE_CLOUD_API_KEY=...`.

Restart the server after editing `.env`, as in [2.7](#27-restart-the-server).

---

## Free external sources: Wayback Machine, Wikimedia, Open PageRank

`wayback_history` reads the Internet Archive's Wayback CDX API and
`brand_pageviews` reads Wikimedia's pageview data. Both are free and need
**no key**: they work straight after [section 1](#1-install-and-connect).

`domain_authority` reads Open PageRank and needs a free key of its own.

### `OPEN_PAGERANK_API_KEY` — `domain_authority`

1. Sign in at <https://openpagerank.keywordseverywhere.com/dashboard> with a
   Keywords Everywhere API key. If you have none, the sign-in page offers a free
   one.
2. Create an OPR API key on that dashboard.
3. Put it in `.env` as `OPEN_PAGERANK_API_KEY=...` and restart the server.

The free plan covers 30,000 domain lookups a month at 60 requests a minute, with
no card. Each domain counts once per call, so comparing a site with nine
competitors spends ten.

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

**`Port 3738 on 127.0.0.1 is already in use`**
The login cannot open the port Google redirects to. Usually another `pnpm mcp-auth`
is still waiting in a different terminal: finish or cancel that one, and run the
command again.

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
<https://myaccount.google.com/permissions> and run `pnpm mcp-auth` again.

**`No Full Report for example.com: No Search Console property found`**
This Google account holds no property covering that domain. Add and verify the
site at <https://search.google.com/search-console>, or run `pnpm mcp-auth` again to
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
