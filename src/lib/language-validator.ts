/**
 * hreflang value validation, in the shape Google documents.
 *
 * Google states the accepted form:
 *
 *   "The language must be in ISO 639-1 format, and the optional region in
 *    ISO 3166-1 Alpha 2 format. Specifying the script is also supported, in
 *    ISO 15924 format."
 *
 * This module used to check codes against two hand-written `Set`s — about 70
 * languages and 60 countries, each labelled "not exhaustive". Everything outside
 * them came back as `critical: Invalid language code`, which meant we reported
 * `zh-Hant` (one of Google's own examples) and `es-419` (how Latin America is
 * addressed, in our own market) as errors on correctly built sites.
 *
 * The fix is to validate the *form* against the complete ISO 639-1 register,
 * rather than validating membership of a subset someone typed out. A region is
 * two letters or three digits by definition; there is no useful register to
 * check it against that a shape check does not already cover.
 */

/**
 * ISO 639-1, complete: all 184 two-letter language codes.
 *
 * Complete on purpose. A partial list here is indistinguishable from a bug — the
 * caller cannot tell "this code is wrong" from "nobody typed this code in yet".
 */
const ISO_639_1 = new Set([
  "aa", "ab", "ae", "af", "ak", "am", "an", "ar", "as", "av", "ay", "az",
  "ba", "be", "bg", "bh", "bi", "bm", "bn", "bo", "br", "bs",
  "ca", "ce", "ch", "co", "cr", "cs", "cu", "cv", "cy",
  "da", "de", "dv", "dz",
  "ee", "el", "en", "eo", "es", "et", "eu",
  "fa", "ff", "fi", "fj", "fo", "fr", "fy",
  "ga", "gd", "gl", "gn", "gu", "gv",
  "ha", "he", "hi", "ho", "hr", "ht", "hu", "hy", "hz",
  "ia", "id", "ie", "ig", "ii", "ik", "io", "is", "it", "iu",
  "ja", "jv",
  "ka", "kg", "ki", "kj", "kk", "kl", "km", "kn", "ko", "kr", "ks", "ku", "kv", "kw", "ky",
  "la", "lb", "lg", "li", "ln", "lo", "lt", "lu", "lv",
  "mg", "mh", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my",
  "na", "nb", "nd", "ne", "ng", "nl", "nn", "no", "nr", "nv", "ny",
  "oc", "oj", "om", "or", "os",
  "pa", "pi", "pl", "ps", "pt",
  "qu",
  "rm", "rn", "ro", "ru", "rw",
  "sa", "sc", "sd", "se", "sg", "si", "sk", "sl", "sm", "sn", "so", "sq", "sr",
  "ss", "st", "su", "sv", "sw",
  "ta", "te", "tg", "th", "ti", "tk", "tl", "tn", "to", "tr", "ts", "tt", "tw", "ty",
  "ug", "uk", "ur", "uz",
  "ve", "vi", "vo",
  "wa", "wo",
  "xh",
  "yi", "yo",
  "za", "zh", "zu",
]);

export interface ParsedLanguageCode {
  /** ISO 639-1, lowercase. */
  language: string;
  /** ISO 15924, title case, when present. */
  script?: string;
  /** ISO 3166-1 Alpha 2 uppercase, or a UN M49 numeric code, when present. */
  region?: string;
}

/**
 * `language[-Script][-REGION]`, the subset of BCP 47 that Google documents.
 *
 * Matched case-insensitively: Google states hreflang values are not
 * case-sensitive, and real sites write `zh-hant` and `EN-gb`.
 */
const CODE_SHAPE = /^([a-z]{2})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/i;

/**
 * Is this a value Google will accept as an hreflang?
 *
 * Form plus a real language subtag. Deliberately not stricter: a region we have
 * not heard of is far more likely to be a country we did not think about than an
 * author error, and the old code proved what the stricter reading costs.
 */
export function validateLanguageCode(code: string): boolean {
  if (!code) return false;
  if (code.toLowerCase() === "x-default") return true;
  return parseLanguageCode(code) !== null;
}

/**
 * Split a code into its subtags, or null when the shape or the language is wrong.
 *
 * Subtags come back in their conventional casing regardless of how they were
 * written, so callers can compare them without normalizing again.
 */
export function parseLanguageCode(code: string): ParsedLanguageCode | null {
  if (!code) return null;

  if (code.toLowerCase() === "x-default") {
    return { language: "x-default" };
  }

  const match = code.match(CODE_SHAPE);
  if (!match) return null;

  const language = match[1].toLowerCase();
  if (!ISO_639_1.has(language)) return null;

  const parsed: ParsedLanguageCode = { language };

  if (match[2]) {
    // ISO 15924 is written title case: "Hant", not "HANT" or "hant".
    parsed.script = match[2][0].toUpperCase() + match[2].slice(1).toLowerCase();
  }
  if (match[3]) {
    parsed.region = /^\d{3}$/.test(match[3]) ? match[3] : match[3].toUpperCase();
  }

  return parsed;
}

/**
 * Country codes that also parse as languages, and what the author probably meant.
 *
 * Google names writing a region where a language belongs as a common mistake:
 * "You can't specify the country code by itself. The first code stands for the
 * language." Most such mistakes fail validation outright — `EU` is not a
 * language. These do not: `uk` is Ukrainian, so a site meaning the United Kingdom
 * gets a perfectly valid annotation pointing at the wrong audience, and no
 * validator built on form alone can see it.
 *
 * A warning, never a failure. `uk` really is Ukrainian and some sites mean it.
 */
const CONFUSABLE_WITH_REGION: Record<string, string> = {
  uk: "Ukrainian. If you meant the United Kingdom, the value is en-GB",
  eu: "Basque. There is no hreflang for the European Union; target its languages or countries individually",
  no: "Norwegian. If you meant Norway, pair it with a language, e.g. nb-NO",
  is: "Icelandic. If you meant Israel, the value is he-IL or en-IL",
  ms: "Malay. If you meant Montserrat, pair it with a language, e.g. en-MS",
  se: "Northern Sami. If you meant Sweden, the value is sv-SE",
  id: "Indonesian. If you meant Indonesia, id-ID is unambiguous",
};

/**
 * A note when a bare code is probably a country, or null when it reads fine.
 *
 * Only fires on a bare language: `uk-UA` says what it means, so it is left alone.
 */
export function regionCodeMistakenForLanguage(code: string): string | null {
  const parsed = parseLanguageCode(code);
  if (!parsed || parsed.region || parsed.script) return null;
  return CONFUSABLE_WITH_REGION[parsed.language] ?? null;
}

/**
 * Rewrite a code in its conventional casing, or null if it is not valid.
 *
 * Also repairs the underscore separator, which is a frequent copy from a locale
 * identifier: `en_us` is not a valid hreflang, but the intent is unambiguous.
 */
export function normalizeLanguageCode(code: string): string | null {
  if (!code) return null;
  if (code.toLowerCase() === "x-default") return "x-default";

  const parsed = parseLanguageCode(code.replace(/_/g, "-"));
  if (!parsed) return null;

  return [parsed.language, parsed.script, parsed.region].filter(Boolean).join("-");
}

/**
 * Human-readable name, for report prose.
 *
 * Names come from `Intl.DisplayNames` rather than a table: the table covered 20
 * languages and fell back to shouting the code, which is how "UZ" reached a
 * report instead of "Uzbek".
 */
export function getLanguageName(code: string): string {
  const parsed = parseLanguageCode(code);
  if (!parsed) return code;
  if (parsed.language === "x-default") return "Default (x-default)";

  let name = parsed.language.toUpperCase();
  try {
    name =
      new Intl.DisplayNames(["en"], { type: "language" }).of(parsed.language) ??
      name;
  } catch {
    // Intl data unavailable for this subtag; the bare code is still readable.
  }

  const qualifier = [parsed.script, parsed.region].filter(Boolean).join(", ");
  return qualifier ? `${name} (${qualifier})` : name;
}
