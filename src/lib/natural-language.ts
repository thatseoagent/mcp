/**
 * Google Cloud Natural Language: which entities a text is about, and how much.
 *
 * ── Why v1 and not v2 ──
 *
 * v2 is the newer surface and it dropped the two fields this module exists for.
 * The v1 `Entity` has `salience` — "the salience score associated with the
 * entity in the [0, 1.0] range" — and `metadata` carrying `wikipedia_url` and
 * `mid`, the Knowledge Graph identifier.
 * (https://docs.cloud.google.com/natural-language/docs/reference/rest/v1/Entity)
 * The v2 `Entity` has neither: name, type, metadata for a handful of types
 * (phone numbers, prices, dates), mentions, sentiment.
 * (https://docs.cloud.google.com/natural-language/docs/reference/rest/v2/Entity)
 * "Is the page's own subject the thing it is most about?" cannot be asked of an
 * API that does not rank entities, so the question pins the version.
 *
 * Classification goes through v1 too, asking for the V2 model and the V2
 * category tree. The V1 model reads English only and needs twenty tokens; the V2
 * model reads twelve languages. Without `classificationModelOptions` v1 defaults
 * to the V1 model, so the option is not decoration.
 * (https://docs.cloud.google.com/natural-language/docs/reference/rest/v1/ClassificationModelOptions,
 * https://docs.cloud.google.com/natural-language/docs/languages,
 * https://docs.cloud.google.com/natural-language/docs/classifying-text)
 *
 * ── What it costs, which is why the caller caps the text ──
 *
 * Billed per request in units of 1,000 Unicode characters, rounded up — "if you
 * send three requests … that contain 800, 1,500, and 600 characters
 * respectively, you are charged for four units". Entity analysis: 5,000 units a
 * month free, then $1.00 per 1,000 units. Content classification: 30,000 units a
 * month free, then $2.00 per 1,000 units. (https://cloud.google.com/natural-language/pricing,
 * read 2026-09-24.) Characters are counted as code points here, which is what
 * "Unicode characters" means; JavaScript's `length` counts UTF-16 units and
 * would bill an emoji twice.
 *
 * ── The key ──
 *
 * `GOOGLE_CLOUD_API_KEY`, shared with Web Risk and for the same reason
 * `web-risk.ts` gives: both need billing on the project, and the free
 * `PAGESPEED_API_KEY` should never be what sits on a billed one. Sent as the
 * `x-goog-api-key` header, which Google recommends over `?key=`
 * (https://docs.cloud.google.com/docs/authentication/api-keys-use).
 */
import { callApi, type ThirdPartyService } from "./third-party-api";
import type { ConfigRequirement } from "./required-config";
import { isRecord } from "./type-guards";

export const NATURAL_LANGUAGE_KEY_REQUIREMENT: ConfigRequirement = {
  variable: "GOOGLE_CLOUD_API_KEY",
  purpose:
    "call Google's Cloud Natural Language API, which reads the page's text for entities and " +
    "content categories",
  howToGet:
    "Create an API key at https://console.cloud.google.com/apis/credentials in a Google Cloud " +
    "project that has billing enabled, and enable the Cloud Natural Language API " +
    "(https://console.cloud.google.com/apis/library/language.googleapis.com) for that project. " +
    "It needs billing on the project even inside its free tier: entity analysis is free for " +
    "5,000 units a month and content classification for 30,000, a unit being 1,000 characters " +
    "(https://cloud.google.com/natural-language/pricing). The same key serves web_risk_check " +
    "once the Web Risk API is enabled too. PAGESPEED_API_KEY is deliberately not used for this.",
};

const NATURAL_LANGUAGE = {
  name: "Google's Cloud Natural Language API",
  key: { requirement: NATURAL_LANGUAGE_KEY_REQUIREMENT, in: "header", header: "x-goog-api-key" },
  // Both calls read a few thousand characters and answer in about a second.
  timeoutMs: 20_000,
  // "Requests per minute: 600", across every method, the project default
  // (https://docs.cloud.google.com/natural-language/quotas, read 2026-09-24).
  perMinute: 600,
} satisfies ThirdPartyService;

const ENTITIES_ENDPOINT = "https://language.googleapis.com/v1/documents:analyzeEntities";
const CLASSIFY_ENDPOINT = "https://language.googleapis.com/v1/documents:classifyText";

/** One billing unit, in characters. */
export const CHARACTERS_PER_UNIT = 1_000;

/**
 * The languages the V2 classification model reads, as base codes.
 *
 * Checked before classifying rather than learnt from a 400, because a 400 is
 * indistinguishable by status from a malformed request and its body is not
 * ours to forward — and because a request Google is going to refuse should not
 * be sent at all. Traditional Chinese is `zh-Hant`, whose base is `zh`, which
 * is on the list either way.
 */
const CLASSIFIABLE_LANGUAGES = new Set([
  "zh", "nl", "en", "fr", "de", "it", "ja", "ko", "pt", "ru", "es",
]);

export type EntityType =
  | "UNKNOWN"
  | "PERSON"
  | "LOCATION"
  | "ORGANIZATION"
  | "EVENT"
  | "WORK_OF_ART"
  | "CONSUMER_GOOD"
  | "OTHER"
  | "PHONE_NUMBER"
  | "ADDRESS"
  | "DATE"
  | "NUMBER"
  | "PRICE";

const ENTITY_TYPES = new Set<string>([
  "UNKNOWN", "PERSON", "LOCATION", "ORGANIZATION", "EVENT", "WORK_OF_ART",
  "CONSUMER_GOOD", "OTHER", "PHONE_NUMBER", "ADDRESS", "DATE", "NUMBER", "PRICE",
]);

export interface PageEntity {
  name: string;
  type: EntityType;
  /** 0–1. An entity with no readable salience is dropped, not scored zero. */
  salience: number;
  wikipediaUrl: string | null;
  /** The Knowledge Graph machine id, e.g. `/m/0k8z`. */
  mid: string | null;
  /** How many times the text mentions it. */
  mentionCount: number;
  /** Whether any mention is a proper name rather than a common noun. */
  properName: boolean;
  /** The distinct surface forms it was mentioned as, for matching a stated subject. */
  mentionTexts: string[];
}

export interface EntityAnalysis {
  /** Most salient first. */
  entities: PageEntity[];
  /** The language Google read the text as, or `null` if it did not say. */
  language: string | null;
}

export interface ContentCategory {
  /** A path in Google's category tree, e.g. `/Computers & Electronics/Software`. */
  name: string;
  /** 0–1: how certain the classifier is. */
  confidence: number;
}

/** Billing units for one request of this text: 1,000 characters each, rounded up. */
export function billingUnits(text: string): number {
  return Math.ceil(characterCount(text) / CHARACTERS_PER_UNIT);
}

/** Unicode characters — code points — which is what Google counts. */
export function characterCount(text: string): number {
  return [...text].length;
}

/** The first `max` characters of `text`, cut on a code point, never inside one. */
export function truncateCharacters(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** Whether the V2 classifier reads a language, by its base code. */
export function isClassifiable(language: string | null): boolean {
  if (!language) return false;
  return CLASSIFIABLE_LANGUAGES.has(language.toLowerCase().split("-")[0] ?? "");
}

async function post(endpoint: string, json: unknown): Promise<unknown> {
  const { body } = await callApi(NATURAL_LANGUAGE, { url: endpoint, json });
  return body;
}

/**
 * `documents:analyzeEntities` on plain text.
 *
 * Plain text rather than HTML because the caller has already extracted the
 * visible copy, and because Google bills markup characters too.
 *
 * @throws {MissingConfigError} before any request, when no key is configured.
 * @throws {UpstreamApiError} when the API answers with anything but entities.
 */
export async function analyzeEntities(text: string): Promise<EntityAnalysis> {
  const payload = await post(ENTITIES_ENDPOINT, {
    document: { type: "PLAIN_TEXT", content: text },
    encodingType: "UTF8",
  });
  return readEntities(payload);
}

/**
 * `documents:classifyText` with the V2 model and category tree.
 *
 * @param language passed through so Google does not detect it a second time
 *        and possibly differently from the entity call.
 */
export async function classifyText(text: string, language: string | null): Promise<ContentCategory[]> {
  const payload = await post(CLASSIFY_ENDPOINT, {
    document: { type: "PLAIN_TEXT", content: text, ...(language ? { language } : {}) },
    classificationModelOptions: { v2Model: { contentCategoriesVersion: "V2" } },
  });
  return readCategories(payload);
}

/**
 * The entities response, read defensively. Exported for its test.
 *
 * An entity without a name or a finite salience is dropped: the ranking is the
 * point, and an entity that cannot be placed in it would be printed as ranked
 * zero — "the page barely mentions this" — when nothing was said either way.
 */
export function readEntities(payload: unknown): EntityAnalysis {
  const data = isRecord(payload) ? payload : {};
  const raw = Array.isArray(data.entities) ? data.entities : [];
  const entities: PageEntity[] = [];

  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== "string" || item.name.trim() === "") continue;
    const salience = typeof item.salience === "number" && Number.isFinite(item.salience)
      ? item.salience
      : null;
    if (salience === null) continue;

    const metadata = isRecord(item.metadata) ? item.metadata : {};
    const mentions = Array.isArray(item.mentions) ? item.mentions.filter(isRecord) : [];
    const mentionTexts = [
      ...new Set(
        mentions
          .map((m) => (isRecord(m.text) && typeof m.text.content === "string" ? m.text.content : null))
          .filter((t): t is string => t !== null && t.trim() !== ""),
      ),
    ];

    entities.push({
      name: item.name.trim(),
      type: typeof item.type === "string" && ENTITY_TYPES.has(item.type)
        ? (item.type as EntityType)
        : "UNKNOWN",
      salience,
      wikipediaUrl: httpUrl(metadata.wikipedia_url),
      mid: typeof metadata.mid === "string" && metadata.mid.startsWith("/") ? metadata.mid : null,
      mentionCount: mentions.length,
      properName: mentions.some((m) => m.type === "PROPER"),
      mentionTexts,
    });
  }

  entities.sort((a, b) => b.salience - a.salience);
  return { entities, language: typeof data.language === "string" ? data.language : null };
}

/** The categories response, read defensively, most confident first. Exported for its test. */
export function readCategories(payload: unknown): ContentCategory[] {
  const data = isRecord(payload) ? payload : {};
  const raw = Array.isArray(data.categories) ? data.categories : [];
  const categories: ContentCategory[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    if (typeof item.confidence !== "number" || !Number.isFinite(item.confidence)) continue;
    categories.push({ name: item.name, confidence: item.confidence });
  }
  return categories.sort((a, b) => b.confidence - a.confidence);
}

/** A link we are willing to print: http(s) only, since it is remote text. */
function httpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
