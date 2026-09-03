import { z } from "zod";
import { type PromptMetadata, type InferSchema } from "xmcp";

export const schema = {
  domain: z.string().describe("The site to check, e.g. example.com"),
};

export const metadata: PromptMetadata = {
  name: "track_progress",
  title: "Track progress since last time",
  description:
    "Check whether the changes made to a site have shown up yet, using the history " +
    "this server has recorded.",
};

/**
 * The prompt that only works because the database exists.
 *
 * Everything else here can be answered by a single run. This one asks what
 * changed, which is the question the whole persistence layer was built for — and
 * it is also where an agent is most likely to over-claim, so most of it is about
 * what a number moving does and does not prove.
 */
export default function trackProgress({ domain }: InferSchema<typeof schema>) {
  return `Tell me whether the work I did on ${domain} has shown up yet.

1. **seo_metric_trend** on ${domain}. That is this server's own record of previous runs.
   If it says nothing has been recorded, the answer is that there is no baseline yet —
   run **run_site_audit** to make one and tell me to come back.

2. **run_site_audit** on ${domain} to take a fresh reading. Its "against last time"
   section is the comparison.

3. **gsc_crawl_freshness** on ${domain}. This matters before anything else is read:
   a page Google has not recrawled cannot be showing the change, so a flat number
   there means nothing yet rather than meaning the change did not work.

4. **get_page_audits** for any page I audited before and after — that is the direct
   before-and-after.

Then tell me plainly: what moved, what did not, and what is too early to say. That third
category is the important one. Search Console lags two to three days, a recrawl can take
weeks, and a metric that has not moved yet is not the same as a change that failed.

Do not attribute a movement to my change unless the timing actually fits. Traffic moves
for seasonal reasons, algorithm reasons, and reasons nobody can see, and a report that
credits every rise to the last thing somebody did is worse than no report.`;
}
