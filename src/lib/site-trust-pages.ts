import { fetchHtml } from "./http-client";
import { detectLocalizedPage } from "./localized-page-detection";
import { readPage, type ParsedPage } from "./analyzers/parsed-page";

/**
 * Whether a **site** publishes a privacy policy, an about page, or contact details.
 *
 * ── Why this exists ──
 *
 * Four E-E-A-T indicators asked a question about the site and answered it from
 * whatever the one analyzed page happened to link (#340). A perfectly ordinary deep
 * article on a site with a full footer scored `✗ No privacy policy link`, 0/5, three
 * times over, because the template it renders under carries no chrome. The site has
 * a privacy policy. We looked in one room and reported the house empty.
 *
 * ── The distinction this module exists to keep ──
 *
 * **The evidence is asymmetric.** A link on this page proves the site has the page —
 * conclusive, and nothing more needs reading. The absence of a link on a deep page
 * proves nothing at all. So only a negative is worth a second look, and the second
 * look is the site home, which is where a site's global chrome lives.
 *
 * That asymmetry is the whole design. It is also why this costs almost nothing: a
 * site refresh already analyzes the home, so every answer is settled without a fetch;
 * a page audit spends one request, shared through `fetchHtml`'s single-flight cache
 * with every other analyzer asking the same question on the same run.
 *
 * ── The third answer ──
 *
 * `unknown`, when the home could not be read. Scoring that as a failure is exactly
 * the bug #337 is named after: a 5xx on the home is not a fact about the site's
 * privacy policy. Callers turn it into a `not-evaluated` check, never a zero.
 *
 * ── What is deliberately not here ──
 *
 * Crawling. This reads one document, the origin root, and stops. Following a footer
 * into `/legal/privacy` to confirm it returns 200 is a different and much more
 * expensive question, and no caller asks it: every scorer here is satisfied by the
 * site *linking* the page, which is what `detectLocalizedPage` already answers.
 *
 * Well-known files are not here either. `/robots.txt` and friends live at fixed paths
 * and have their own module in `well-known.ts`; a privacy policy has no fixed path,
 * which is why it takes a multilingual slug table to find at all.
 */
export type TrustPageKind = "privacy" | "about" | "contact";

/**
 * Where an answer came from, because the reader needs different things from each.
 *
 * `present` carries `where`: found on the analyzed page asks nothing of anyone,
 * whereas found only on the home is still a pass but tells the reader their global
 * chrome does not reach this template.
 */
export type TrustPageFinding =
  | { answer: "present"; where: "page" | "home" }
  | { answer: "absent" }
  | { answer: "unknown"; reason: string };

/**
 * Does this document show that the site publishes a page of `kind`?
 *
 * The definition of the evidence lives here rather than at the two call sites so the
 * page and the home are judged by one rule. Contact is the case that makes this
 * matter: `detectLocalizedPage` knows about `ContactPage` schema and multilingual
 * slugs but not about a `mailto:`, a `tel:`, or a phone number in the footer, and
 * E-E-A-T counted all three. Applying a narrower rule to the home than to the page
 * would let a home with a visible phone number and no `/contact` link overturn
 * nothing.
 */
export function showsTrustPage(page: ParsedPage, kind: TrustPageKind): boolean {
  // One **Parsed Page** rather than `($, visibleText, schemas, kind)`. Three of
  // those four arguments always came from the same document, and the fourth was
  // the only thing that varied — a data clump wearing a parameter list, and the
  // reason two callers each had to assemble the same three values by hand.
  const { $, schemas } = page;
  const visibleText = page.readable.allText();
  if (detectLocalizedPage($, visibleText, [...schemas], kind)) return true;
  if (kind !== "contact") return false;
  return (
    $('a[href^="mailto:"]').length > 0 ||
    $('a[href^="tel:"]').length > 0 ||
    // Chrome, deliberately: a phone number belongs in the footer.
    /(?<!\d)\d{3}[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/.test(visibleText)
  );
}

/**
 * Settle each kind for the site, given what the analyzed page already showed.
 *
 * `onPage` is the caller's own reading of the page it is scoring, and its keys decide
 * how much work happens: pass only `{ about: false }` and only the about question is
 * answered. A caller that found everything on the page triggers no request at all.
 *
 * Generic over those keys so a caller gets back exactly the kinds it asked about,
 * rather than a partial record it has to narrow.
 */
export async function resolveTrustPages<K extends TrustPageKind>(
  pageUrl: string,
  onPage: Record<K, boolean>,
): Promise<Record<K, TrustPageFinding>> {
  const kinds = Object.keys(onPage) as K[];
  const found = {} as Record<K, TrustPageFinding>;
  const missing: K[] = [];

  for (const kind of kinds) {
    if (onPage[kind]) found[kind] = { answer: "present", where: "page" };
    else missing.push(kind);
  }
  if (missing.length === 0) return found;

  // The analyzed page IS the home, so there is no second room to look in and the
  // negative is settled. This is the site-refresh case, where `url` is the domain
  // root — the common path, and it costs nothing.
  let home: string;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.pathname === "/") {
      for (const kind of missing) found[kind] = { answer: "absent" };
      return found;
    }
    home = new URL("/", parsed).toString();
  } catch {
    for (const kind of missing) {
      found[kind] = { answer: "unknown", reason: "this page's URL could not be parsed" };
    }
    return found;
  }

  let homePage: ParsedPage;
  try {
    homePage = readPage(home, await fetchHtml(home));
  } catch {
    // A 5xx, a timeout, an auth wall, a robots refusal. We did not find out, and the
    // reason travels to the reader so "not run" can say why.
    for (const kind of missing) {
      found[kind] = { answer: "unknown", reason: "the site home could not be read on this run" };
    }
    return found;
  }

  for (const kind of missing) {
    found[kind] = showsTrustPage(homePage, kind)
      ? { answer: "present", where: "home" }
      : { answer: "absent" };
  }
  return found;
}
