import { z } from "zod";
import { type PromptMetadata, type InferSchema } from "xmcp";

export const schema = {
  domain: z.string().describe("The site to audit, e.g. example.com"),
};

export const metadata: PromptMetadata = {
  name: "audit_site",
  title: "Audit a site",
  description:
    "Work through a full audit of one site: the Full Report if Google is connected, " +
    "the credential-free surface if it is not, and what to do about what turns up.",
};

/**
 * The order matters more than the list.
 *
 * An agent handed fifty-five Tools calls the ones whose names match the words in
 * the request, which produces a report assembled from whatever happened to
 * sound relevant. This says which question to ask first and what its answer
 * changes about the next one — starting with `run_site_audit`, because its
 * refusal is the fastest way to find out which half of the surface is available.
 */
export default function auditSite({ domain }: InferSchema<typeof schema>) {
  return `Audit ${domain} and tell me what to fix first.

Work in this order, and stop to tell me what you found rather than running everything:

1. **run_site_audit** on ${domain}. If it refuses, read its message out — it says whether
   Google is not connected or this site's property is not readable, and those need
   different things from me. Then carry on with step 3 and skip step 2.

2. If it worked, follow the numbers it flags:
   - **gsc_detect_quick_wins** for pages a better title would help.
   - **gsc_detect_trends** and **gsc_detect_anomalies** for anything that moved.
   - **gsc_index_coverage_analysis** if you suspect pages are not being indexed.

3. Whether or not Google is connected, the public surface is always readable:
   - **crawl_site** with maxPages 25 for duplicate titles, broken links and deep pages.
   - **seo_crawlability_audit** on the homepage.
   - **seo_security_headers**, **seo_llms_txt** and **seo_agent_discovery** for how the
     site looks to crawlers and to agents.

4. Bring it together as: what is broken, what is worth doing, and what is fine. Do not
   pad the third list — if something was not measured, say it was not measured rather
   than listing it as passing.

Every Tool here says what its numbers are based on and whose thresholds it applied.
Pass that on rather than restating the numbers as facts about the site.`;
}
