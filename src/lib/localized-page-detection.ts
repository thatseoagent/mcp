/**
 * Language-agnostic detection of trust / entity pages (About, Privacy, Contact).
 *
 * The original scorers matched English slugs and phrases only (`/about`,
 * "about us", `/privacy`…), so a correct Spanish (or FR/DE/PT/IT) site using
 * localized URLs like `/acerca-de-mi` or `/nuestro-equipo` was scored as if the
 * page didn't exist — a false negative that unfairly lowered E-E-A-T and AI
 * visibility scores.
 *
 * Detection now uses two layers:
 *   1. Structured data (language-agnostic, most reliable when present) — an
 *      `AboutPage` / `ProfilePage` / `ContactPage` node, or an `Organization`
 *      with a `contactPoint`.
 *   2. A multilingual slug + link-text fallback for the majority of sites that
 *      don't emit that schema.
 */

import type { CheerioAPI } from "cheerio";
import { escapeRegExp } from "./escape-regexp";

export type LocalizedPageKind = "about" | "privacy" | "contact" | "press";

// URL slug fragments (matched as a path segment after "/"). Lowercase, no accents
// (accents rarely appear in URLs). Covers en, es, fr, de, pt, it.
const SLUGS: Record<LocalizedPageKind, string[]> = {
  about: [
    "about", "about-us", "aboutus", "about-me",
    "acerca", "acerca-de", "acerca-de-mi", "acerca-de-nosotros",
    "quienes-somos", "quienes", "nosotros", "sobre-nosotros", "sobre-mi",
    "nuestra-empresa", "nuestro-equipo", "equipo", "empresa",
    "company", "our-story", "our-team", "our-company", "who-we-are", "meet-the-team", "team",
    "a-propos", "apropos", "qui-sommes-nous", "notre-equipe",
    "uber-uns", "ueber-uns", "impressum", "unternehmen",
    "chi-siamo", "azienda",
    "sobre", "sobre-nos", "quem-somos", "equipe",
  ],
  privacy: [
    "privacy", "privacy-policy", "privacypolicy",
    "privacidad", "politica-de-privacidad", "politica-privacidad", "aviso-de-privacidad",
    "privacidade", "politica-de-privacidade",
    "confidentialite", "politique-de-confidentialite", "vie-privee",
    "datenschutz", "datenschutzerklarung",
    "informativa-privacy", "privatlivspolitik",
  ],
  contact: [
    "contact", "contact-us", "contactus",
    "contacto", "contactar", "contactanos", "contactenos",
    "contato", "fale-conosco",
    "nous-contacter", "contactez-nous",
    "kontakt", "kontaktieren",
    "contatti", "contattaci",
  ],
  press: [
    "press", "media", "newsroom", "news", "press-room", "press-kit", "media-kit", "in-the-news",
    "prensa", "sala-de-prensa", "sala-prensa", "notas-de-prensa", "actualidad", "noticias", "medios", "kit-de-prensa",
    "presse", "salle-de-presse", "actualites", "communiques", "communiques-de-presse",
    "pressemitteilungen", "aktuelles", "neuigkeiten", "medien",
    "imprensa", "sala-de-imprensa", "novidades",
    "stampa", "sala-stampa", "comunicati", "comunicati-stampa", "notizie", "novita",
  ],
};

// Visible link/heading text (lowercased, accents kept). Kept specific (mostly
// multi-word) to avoid false positives from an "about" substring anywhere.
const TEXTS: Record<LocalizedPageKind, string[]> = {
  about: [
    "about us", "acerca de", "sobre nosotros", "sobre nós", "sobre nos",
    "quiénes somos", "quienes somos", "quem somos", "nuestro equipo",
    "à propos", "qui sommes-nous", "über uns", "uber uns", "chi siamo",
    "wer wir sind",
  ],
  privacy: [
    "privacy policy", "política de privacidad", "politica de privacidad",
    "aviso de privacidad", "política de privacidade", "politica de privacidade",
    "politique de confidentialité", "datenschutz", "informativa sulla privacy",
  ],
  contact: [
    "contact us", "contáctanos", "contactanos", "fale conosco",
    "nous contacter", "kontaktieren sie uns", "contattaci",
  ],
  // Distinctive multi-word phrases only — single tokens like "press"/"news"
  // would false-positive (WordPress, compress…); the slug list handles those.
  press: [
    "in the news", "press room", "press kit",
    "sala de prensa", "notas de prensa", "kit de prensa",
    "salle de presse", "pressemitteilungen",
    "sala de imprensa", "sala stampa", "comunicati stampa",
  ],
};

const SCHEMA_TYPES: Partial<Record<LocalizedPageKind, string[]>> = {
  about: ["AboutPage", "ProfilePage"],
  contact: ["ContactPage"],
};



/**
 * Elements that declare a link. `<base>` is deliberately absent: it sets the
 * document's resolution root, it does not link anywhere.
 */
const LINKING = "a[href], area[href], link[href]";

/**
 * True if the page links to a page of `kind` in any supported language.
 *
 * Two halves, each read from where it actually lives:
 *
 * - Slugs come from the `href` of elements that really link. Scanning the HTML
 *   for `href="…"` also matched a URL inside a `<script>` or a commented-out
 *   block.
 * - Phrases come from `visibleText`, the page's visible words as
 *   `readableDocument($).allText()` returns them (case does not matter).
 *   Scanning the HTML matched them in an `aria-label`, an `alt`, a comment, or
 *   serialized data — so a page with no privacy link at all was credited one.
 */
export function hasLocalizedLink(
  $: CheerioAPI,
  visibleText: string,
  kind: LocalizedPageKind
): boolean {
  const slugAlt = SLUGS[kind].map(escapeRegExp).join("|");
  // A slug occupying a full path segment, optionally followed by more path,
  // query or hash.
  const slugRe = new RegExp(`/(?:${slugAlt})(?:[/?#]|$)`, "i");

  const linked = $(LINKING)
    .toArray()
    .some((el) => slugRe.test($(el).attr("href") ?? ""));
  if (linked) return true;

  const lower = visibleText.toLowerCase();
  return TEXTS[kind].some((phrase) => lower.includes(phrase));
}

/**
 * True if parsed JSON-LD schema objects indicate a page of `kind`
 * (language-agnostic). For contact, also accepts an Organization/LocalBusiness
 * carrying a `contactPoint`.
 */
export function schemasIndicate(schemas: readonly unknown[], kind: LocalizedPageKind): boolean {
  const types = SCHEMA_TYPES[kind];
  const hasType = (obj: Record<string, unknown>): boolean => {
    const t = obj["@type"];
    if (types) {
      if (typeof t === "string" && types.includes(t)) return true;
      if (Array.isArray(t) && (t as string[]).some((v) => types.includes(v))) return true;
    }
    if (kind === "contact" && obj["contactPoint"]) return true;
    return false;
  };
  return schemas.some((s) => {
    if (!s || typeof s !== "object") return false;
    const obj = s as Record<string, unknown>;
    if (hasType(obj)) return true;
    // Walk one level into @graph, which many sites use to bundle nodes.
    const graph = obj["@graph"];
    if (Array.isArray(graph)) {
      return graph.some((g) => g && typeof g === "object" && hasType(g as Record<string, unknown>));
    }
    return false;
  });
}

/** Convenience: schema first (reliable), multilingual link fallback second. */
export function detectLocalizedPage(
  $: CheerioAPI,
  visibleText: string,
  schemas: readonly unknown[],
  kind: LocalizedPageKind
): boolean {
  return schemasIndicate(schemas, kind) || hasLocalizedLink($, visibleText, kind);
}
