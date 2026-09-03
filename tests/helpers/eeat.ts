import type { TrustPageFinding, TrustPageKind } from "@/lib/site-trust-pages";
import { scoreEeat } from "@/lib/analyzers/eeat-analyzer";
import { readPage } from "@/lib/analyzers/parsed-page";

/**
 * Score a page without standing up a network.
 *
 * `scoreEeat` is pure since the fetch moved to `eeat-tools`, so these tests no
 * longer need `serveHtml`. That matters beyond tidiness: `eeat-page-identity`
 * had to start serving a `BARE_HOME` at the origin root so that a failed home
 * read would stop turning three indicators `not-evaluated` and moving the
 * maximum out from under its arithmetic. Correct behaviour, and not what that
 * file is measuring.
 *
 * `trustPages` defaults to `absent` on all three — the site publishes none of
 * them — because that is the settled answer a bare home produces, and because a
 * default of `unknown` would silently take 15 points out of every maximum here.
 * A file testing the third state passes it explicitly.
 */
export function eeatOf(
  url: string,
  html: string,
  trustPages: Partial<Record<TrustPageKind, TrustPageFinding>> = {},
) {
  const absent = { answer: "absent" } as const;
  const data = scoreEeat({
    page: readPage(url, html),
    trustPages: {
      privacy: trustPages.privacy ?? absent,
      about: trustPages.about ?? absent,
      contact: trustPages.contact ?? absent,
    },
  });

  const all = [
    ...data.signals.experience.indicators,
    ...data.signals.expertise.indicators,
    ...data.signals.authoritativeness.indicators,
    ...data.signals.trustworthiness.indicators,
  ];

  return {
    data,
    /** The indicator with this signal name. Throws rather than returning undefined. */
    get: (signal: string) => {
      const found = all.find((i) => i.signal === signal);
      if (!found) throw new Error(`no indicator named ${signal}`);
      return found;
    },
  };
}
