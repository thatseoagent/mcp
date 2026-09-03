import { z } from "zod";
import { type PromptMetadata, type InferSchema } from "xmcp";

export const schema = {
  domain: z.string().describe("The site to look at, e.g. example.com"),
};

export const metadata: PromptMetadata = {
  name: "find_quick_wins",
  title: "Find quick wins",
  description:
    "Find the changes worth making this week: pages already being seen that nobody " +
    "clicks, and the ones ranking just off the first page.",
};

export default function findQuickWins({ domain }: InferSchema<typeof schema>) {
  return `Find the highest-value changes I could ship this week for ${domain}.

1. **gsc_detect_quick_wins** on ${domain}. These are queries already earning impressions
   at positions 4-10 with almost no clicks — usually a title and description problem
   rather than a ranking one, which is why they are quick.

2. **gsc_page_query_map** for the pages those queries land on. What a page actually ranks
   for is often not what it was written for, and that gap is the change to make.

3. **gsc_device_gap** and **gsc_country_opportunity**, which surface a different kind of
   win: traffic the site already earns and is not converting.

4. For the two or three pages that look most worth doing, **seo_analyze_page** on each,
   so the suggestion is about that page's actual title, description and headings.

Give me a short list of specific changes to specific URLs, each with the number that
justifies it. Do not give me general advice — every item should name a page and say what
to change on it.

The thresholds behind "quick win" are this server's own, not Google's, and the estimated
clicks are a floor rather than a forecast. Say so once rather than presenting them as
projections.`;
}
