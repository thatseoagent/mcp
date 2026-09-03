import { parseLanguageCode } from "../language-validator";

/**
 * What the page declares, verbatim: `en-GB`, `es-419`, `pt_BR`.
 *
 * Separate from `pageLanguage` because the two answer different questions and
 * merging them would lose information a reader wants. A report saying
 * "Lang: en-GB" is more useful than one saying "Lang: en", and a check matching
 * pattern sets needs the opposite. `onpage-seo` read the attribute itself and so
 * knew nothing about `xml:lang`, which made `seo-rules` fire `lang-missing` at a
 * page that had declared its language (#348).
 */
export function declaredLanguage(html: string): string | null {
  const declared =
    html.match(/<html[^>]*\slang=["']([^"']+)["']/i)?.[1] ??
    html.match(/<html[^>]*\sxml:lang=["']([^"']+)["']/i)?.[1];
  return declared?.trim() || null;
}

/**
 * The language a page declares it is written in.
 *
 * One line of markup, read in one place, because three checks and two external
 * lookups need the same answer and none of them should be parsing `<html>` for it
 * (#342).
 *
 * `html[lang]` is what a page *declares*, not what it is written in — a template
 * shipping `lang="en"` around Spanish copy will be believed. Guessing from the text
 * instead would mean shipping a language identifier, and every caller here has a safe
 * fallback for "we do not know", so believing the declaration is the cheaper honest
 * option. It is also the signal Google reads.
 *
 * Returns the base language only: `es-419` and `es-MX` are Spanish, and no caller
 * varies on the region.
 */
export function pageLanguage(html: string): string | null {
  const declared = declaredLanguage(html);
  if (!declared) return null;

  // `_` is the locale-identifier separator, which real pages copy in from a config.
  return parseLanguageCode(declared.replace(/_/g, "-"))?.language ?? null;
}
