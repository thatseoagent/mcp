/**
 * Can an agent operate this page, or only read it?
 *
 * > "browser agents may access your website to gather the data they need to
 * > complete these tasks, such as analyzing visual renderings (like screenshots),
 * > inspecting the DOM structure, and interpreting the accessibility tree."
 * > https://developers.google.com/search/docs/fundamentals/ai-optimization-guide
 *
 * Of everything that guide says about building for the AI era, this is the only
 * sentence naming a mechanism, and the mechanism happens to be one we can check
 * without a browser. The accessibility tree is derived from the DOM by published
 * rules: a `<button>` containing nothing but an `<svg>` has no accessible name in
 * any implementation of them, so it is an unlabelled control for an agent exactly
 * as it is for a screen reader.
 *
 * That makes this the odd one out in the product's AI-era surface, in the
 * direction that matters. `seo_geo_score` and `ai_visibility_score` are our model
 * of how answer engines pick passages — legitimate, disclosed as ours, and
 * unfalsifiable. This is a fact about the page, and the same fact serves a human
 * using a screen reader. Before it, the product shipped two AI scores built on
 * inference and exactly one accessibility check.
 *
 * ## What it deliberately does not do
 *
 * It does not render. Google renders JavaScript and a browser agent runs the page,
 * so a control assembled at runtime is invisible here — which means a finding is
 * evidence and the absence of findings is not. Cheerio-only is also why the
 * `aria-labelledby` case does not resolve the reference: the id may not exist
 * until hydration, and an author who wrote the attribute has thought about the
 * name. Both limits are the same limit as every other analyzer in this directory,
 * recorded in `docs/google-search-central-conformance.md` §3.1.
 */

import type { CheerioAPI } from "cheerio";

/** How many findings a report lists before it starts counting instead. */
const MAX_LISTED = 10;

export type AgentOperabilityFinding = {
  /** Enough of the element to find it in the source. */
  markup: string;
  /** What is missing, in terms of what an agent or a screen reader cannot do. */
  reason: string;
  /**
   * The success criterion this finding is actually about.
   *
   * Per finding rather than one for the module, because they are not all the same
   * criterion and saying they were would be the same class of error as citing the
   * wrong Google page. An unnamed control is 4.1.2 Name, Role, Value; a missing
   * landmark is 1.3.1 Info and Relationships, which is also what the heading check
   * in `check-source.ts` cites.
   */
  standard: string;
};

/** Controls and fields: the accessible name is the whole subject. */
const NAME_ROLE_VALUE = "WCAG 2.2 §4.1.2 Name, Role, Value";
/** Landmarks: structure conveyed programmatically, not naming. */
const INFO_AND_RELATIONSHIPS = "WCAG 2.2 §1.3.1 Info and Relationships";

export type AgentOperabilityResult = {
  findings: AgentOperabilityFinding[];
  /**
   * Every finding, including the ones past {@link MAX_LISTED}.
   *
   * A page whose component template is broken carries the same defect on every
   * instance, so the list says what is wrong and the total says how big it is.
   * Reporting only the truncated list would understate a systematic problem as a
   * handful of oversights.
   */
  total: number;
};

/**
 * The element's accessible name, as far as static HTML can tell.
 *
 * Not a full implementation of the accname algorithm, and does not pretend to be:
 * it checks the four sources that account for essentially every real case, in the
 * order the algorithm gives them precedence. `aria-labelledby` counts as present
 * without resolving it — see the module note.
 */
function hasAccessibleName($: CheerioAPI, el: Parameters<CheerioAPI>[0]): boolean {
  const $el = $(el);
  if ($el.attr("aria-labelledby")) return true;
  if ($el.attr("aria-label")?.trim()) return true;
  if ($el.text().trim()) return true;
  // A control whose visible content is an image is named by that image's alt.
  const alt = $el.find("img[alt]").attr("alt");
  if (alt?.trim()) return true;
  // `title` is a weak last resort in the algorithm, and it is a real one.
  return Boolean($el.attr("title")?.trim());
}

/** Short, stable description of an element, for a reader hunting it in source. */
function describe($: CheerioAPI, el: Parameters<CheerioAPI>[0]): string {
  const $el = $(el);
  const tag = ($el.prop("tagName") ?? "element").toString().toLowerCase();
  const id = $el.attr("id");
  const name = $el.attr("name");
  const type = $el.attr("type");
  const parts = [tag, type && `type=${type}`, name && `name=${name}`, id && `#${id}`].filter(Boolean);
  return `<${parts.join(" ")}>`;
}

/**
 * Input types that carry their own name or take no input.
 *
 * `submit` and `button` are named by their `value`, `hidden` is not in the
 * accessibility tree at all, and `image` is named by `alt`. Reporting any of them
 * would be a false finding on correct markup.
 */
const SELF_NAMING_INPUTS = new Set(["hidden", "submit", "button", "reset", "image"]);

export function auditAgentOperability($: CheerioAPI): AgentOperabilityResult {
  const all: AgentOperabilityFinding[] = [];

  // ── Controls with no accessible name ──
  //
  // An agent asked to "add this to the cart" has to pick a target. A button whose
  // whole content is an icon offers nothing to match against, so the agent either
  // guesses from position or gives up.
  $("button, a[href], [role=button], [role=link]").each((_, el) => {
    const $el = $(el);
    // An explicit aria-hidden is the author saying this is decorative. Arguing
    // with a correct declaration is how a checker loses its credibility.
    if ($el.attr("aria-hidden") === "true") return;
    if (hasAccessibleName($, el)) return;
    all.push({
      markup: describe($, el),
      reason: "no accessible name — an agent has nothing to identify this control by",
      standard: NAME_ROLE_VALUE,
    });
  });

  // ── Fields an agent cannot fill ──
  $("input, select, textarea").each((_, el) => {
    const $el = $(el);
    if ($el.attr("aria-hidden") === "true") return;
    const type = ($el.attr("type") ?? "text").toLowerCase();
    if (SELF_NAMING_INPUTS.has(type)) return;

    if ($el.attr("aria-label")?.trim() || $el.attr("aria-labelledby")) return;
    // Bound by for/id, or wrapped by the label.
    const id = $el.attr("id");
    // Matched by attribute value rather than by interpolating the id into the
    // selector string. An id containing a quote or a bracket is unusual and legal,
    // and it made the selector throw inside the analyzer.
    if (id && $("label[for]").filter((_i, l) => $(l).attr("for") === id).length > 0) return;
    if ($el.closest("label").length > 0) return;

    // Placeholder last, and separately, because it is the usual substitute and
    // the reason it fails is worth stating rather than implying.
    if ($el.attr("placeholder")?.trim()) {
      all.push({
        markup: describe($, el),
        reason:
          "placeholder is not a label — it is not an accessible name and it disappears on focus, so an agent filling the form has nothing to match",
        standard: NAME_ROLE_VALUE,
      });
      return;
    }

    all.push({
      markup: describe($, el),
      reason: "no label — an agent cannot tell what this field expects",
      standard: NAME_ROLE_VALUE,
    });
  });

  // ── The one structural landmark worth demanding ──
  //
  // Only `main`. A nav, a header and a footer are useful and their absence is
  // rarely the thing standing between an agent and the content; not being able to
  // find where the content starts is.
  if ($("main, [role=main]").length === 0) {
    all.push({
      markup: "<body>",
      reason:
        "no main landmark — nothing marks where this page's content begins, so an agent reading the accessibility tree cannot skip the chrome",
      standard: INFO_AND_RELATIONSHIPS,
    });
  }

  return { findings: all.slice(0, MAX_LISTED), total: all.length };
}
