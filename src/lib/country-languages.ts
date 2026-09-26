/**
 * The language a searcher in a country most likely reads — an approximation,
 * and a deliberately small one.
 *
 * ── Why a table at all ──
 *
 * Search Console reports impressions by the searcher's country, as ISO 3166-1
 * alpha-3 (`esp`, `mex`, `usa`). hreflang declares alternates by language and,
 * optionally, region (`es`, `es-MX`, `en-GB`). Crossing the two needs a bridge
 * from country to language, and there is no neutral one: a country is not a
 * language, a searcher in Spain may search in Catalan or English, and Google
 * does not say which language any impression was in.
 *
 * So this is ours, and every Tool that reads it says so. It lists a country's
 * main language first and, for the countries where more than one is in wide
 * everyday use, the others after it — Switzerland, Belgium, Canada, India. It
 * does not try to be complete: a country not listed is reported as "not in our
 * mapping" rather than guessed at, which is the same choice `answer-patterns.ts`
 * makes for a language it cannot read.
 *
 * Languages are ISO 639-1, because that is what hreflang takes. Regional and
 * minority languages are left out on purpose; including Catalan for Spain would
 * report every Spanish site without a Catalan version as having a gap.
 */

export interface CountryLanguages {
  /** ISO 3166-1 alpha-2, the region subtag hreflang uses. */
  alpha2: string;
  /** Main language first. More than one means more than one is in wide use. */
  languages: readonly string[];
}

/** Keyed by lowercase alpha-3, the way Search Console reports countries. */
export const COUNTRY_LANGUAGES: Readonly<Record<string, CountryLanguages>> = {
  usa: { alpha2: "US", languages: ["en"] },
  gbr: { alpha2: "GB", languages: ["en"] },
  can: { alpha2: "CA", languages: ["en", "fr"] },
  aus: { alpha2: "AU", languages: ["en"] },
  nzl: { alpha2: "NZ", languages: ["en"] },
  irl: { alpha2: "IE", languages: ["en"] },
  ind: { alpha2: "IN", languages: ["en", "hi"] },
  zaf: { alpha2: "ZA", languages: ["en"] },
  sgp: { alpha2: "SG", languages: ["en", "zh"] },
  phl: { alpha2: "PH", languages: ["en", "tl"] },
  nga: { alpha2: "NG", languages: ["en"] },
  pak: { alpha2: "PK", languages: ["en", "ur"] },
  esp: { alpha2: "ES", languages: ["es"] },
  mex: { alpha2: "MX", languages: ["es"] },
  arg: { alpha2: "AR", languages: ["es"] },
  col: { alpha2: "CO", languages: ["es"] },
  chl: { alpha2: "CL", languages: ["es"] },
  per: { alpha2: "PE", languages: ["es"] },
  ven: { alpha2: "VE", languages: ["es"] },
  ecu: { alpha2: "EC", languages: ["es"] },
  ury: { alpha2: "UY", languages: ["es"] },
  pry: { alpha2: "PY", languages: ["es"] },
  bol: { alpha2: "BO", languages: ["es"] },
  gtm: { alpha2: "GT", languages: ["es"] },
  cri: { alpha2: "CR", languages: ["es"] },
  pan: { alpha2: "PA", languages: ["es"] },
  dom: { alpha2: "DO", languages: ["es"] },
  fra: { alpha2: "FR", languages: ["fr"] },
  bel: { alpha2: "BE", languages: ["nl", "fr"] },
  che: { alpha2: "CH", languages: ["de", "fr", "it"] },
  lux: { alpha2: "LU", languages: ["fr", "de"] },
  deu: { alpha2: "DE", languages: ["de"] },
  aut: { alpha2: "AT", languages: ["de"] },
  ita: { alpha2: "IT", languages: ["it"] },
  prt: { alpha2: "PT", languages: ["pt"] },
  bra: { alpha2: "BR", languages: ["pt"] },
  nld: { alpha2: "NL", languages: ["nl"] },
  swe: { alpha2: "SE", languages: ["sv"] },
  nor: { alpha2: "NO", languages: ["nb", "no", "nn"] },
  dnk: { alpha2: "DK", languages: ["da"] },
  fin: { alpha2: "FI", languages: ["fi", "sv"] },
  pol: { alpha2: "PL", languages: ["pl"] },
  cze: { alpha2: "CZ", languages: ["cs"] },
  svk: { alpha2: "SK", languages: ["sk"] },
  hun: { alpha2: "HU", languages: ["hu"] },
  rou: { alpha2: "RO", languages: ["ro"] },
  bgr: { alpha2: "BG", languages: ["bg"] },
  grc: { alpha2: "GR", languages: ["el"] },
  hrv: { alpha2: "HR", languages: ["hr"] },
  tur: { alpha2: "TR", languages: ["tr"] },
  rus: { alpha2: "RU", languages: ["ru"] },
  ukr: { alpha2: "UA", languages: ["uk"] },
  isr: { alpha2: "IL", languages: ["he"] },
  sau: { alpha2: "SA", languages: ["ar"] },
  are: { alpha2: "AE", languages: ["ar", "en"] },
  egy: { alpha2: "EG", languages: ["ar"] },
  mar: { alpha2: "MA", languages: ["ar", "fr"] },
  jpn: { alpha2: "JP", languages: ["ja"] },
  kor: { alpha2: "KR", languages: ["ko"] },
  chn: { alpha2: "CN", languages: ["zh"] },
  twn: { alpha2: "TW", languages: ["zh"] },
  hkg: { alpha2: "HK", languages: ["zh", "en"] },
  idn: { alpha2: "ID", languages: ["id"] },
  mys: { alpha2: "MY", languages: ["ms", "en"] },
  tha: { alpha2: "TH", languages: ["th"] },
  vnm: { alpha2: "VN", languages: ["vi"] },
};

/** The table's entry for an alpha-2 region subtag, with its alpha-3 key. */
export function countryByAlpha2(alpha2: string): { alpha3: string; country: CountryLanguages } | null {
  const upper = alpha2.toUpperCase();
  for (const [alpha3, country] of Object.entries(COUNTRY_LANGUAGES)) {
    if (country.alpha2 === upper) return { alpha3, country };
  }
  return null;
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** "Spain", from `esp` or `ES`; the code itself when there is no name for it. */
export function countryName(code: string): string {
  const alpha2 = code.length === 3 ? COUNTRY_LANGUAGES[code.toLowerCase()]?.alpha2 : code.toUpperCase();
  if (!alpha2) return code.toUpperCase();
  try {
    return regionNames.of(alpha2) ?? alpha2;
  } catch {
    return alpha2;
  }
}
