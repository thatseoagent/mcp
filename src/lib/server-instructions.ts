/**
 * What a client is told at the handshake, before its first Tool call.
 *
 * ── Why this exists ──
 *
 * An agent handed fifty-five Tools calls the ones whose names match the words in
 * the request. That produces a report assembled from whatever happened to sound
 * relevant, and — worse — it produces confident summaries of numbers whose
 * caveats were in the Tool output and got dropped on the way to the answer.
 *
 * These instructions are the smallest thing that fixes both: which Tool to start
 * with, what a refusal means, and the one rule about how to report what comes
 * back.
 *
 * ── Kept short on purpose ──
 *
 * Everything here is paid for in every conversation, in tokens the Operator's
 * question could have used. The playbooks under `seo://` carry the detail; this
 * carries only what an agent needs *before* it knows which playbook to read.
 *
 * It lives in TypeScript rather than inline in `xmcp.config.ts` because it is
 * prose that will be edited, and because a test asserts every Tool name it
 * mentions actually exists.
 */
export const SERVER_INSTRUCTIONS = `SEO analysis over the Operator's own sites.

**Start with run_site_audit.** It produces the Full Report and, when it cannot, its
refusal says which half of this server is available: whether nobody has logged in to
Google, or this account holds no Search Console property for the domain. That is the
fastest way to find out, and a refusal is a state rather than a fault — read it out and
carry on with the Tools that need no credentials.

**Two halves.** Everything named seo_*, crawl_site and pagespeed_insights reads a site's
public surface and works on any domain, including one the Operator does not own. Anything
named gsc_*, ga4_*, run_site_audit or sync_gsc_properties reads the Operator's own Google
data and needs the login.

**Report what the Tools say about their own numbers.** They state whose threshold they
applied, how many rows they read, and when something could not be measured. A check that
did not run is not a check that passed, an absence of findings is an absence in the rows
read, and the AI-visibility and GEO scores are directional readings of visible signals
rather than measurements of how any AI system behaves. Dropping those qualifications on
the way to a summary is the failure mode this server is built to avoid.

Prompts: audit_site, find_quick_wins, track_progress. Playbooks are readable as resources
under seo://.`;
