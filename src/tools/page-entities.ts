import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import {
  analyzeEntities,
  billingUnits,
  characterCount,
  classifyText,
  isClassifiable,
  truncateCharacters,
  NATURAL_LANGUAGE_KEY_REQUIREMENT,
  type ContentCategory,
  type PageEntity,
} from "../lib/natural-language";
import { fetchHtml, validateUrl } from "../lib/http-client";
import { readPage } from "../lib/analyzers/parsed-page";
import { requireConfig } from "../lib/required-config";
import { defineCachedTool } from "../lib/define-tool";
import { domainFromUrl, refreshable } from "../lib/with-cache";
import { toolError, toolText } from "../lib/tool-result";
import { withheld } from "../lib/render-list";

export const schema = {
  ...refreshable,
  url: z.string().url().describe("The page to read"),
  targetEntity: z
    .string()
    .min(2)
    .max(200)
    .optional()
    .describe(
      "The entity the page is meant to be about — a brand, product, person or topic. " +
        "Default: whatever the page's H1 names, or its title when it has no H1",
    ),
};

export const metadata: ToolMetadata = {
  name: "page_entities",
  description:
    "Read a page's visible text with Google Cloud Natural Language: the entities it is " +
    "about, ranked by salience, with their type and Wikipedia / Knowledge Graph identity " +
    "where Google resolved one; whether the page's own subject (its H1, or a targetEntity " +
    "you name) is the most salient; and its content categories with confidence. The page's " +
    "text is sent to Google Cloud, capped at 10,000 characters, and the output says how much " +
    "was sent and roughly how many billing units it used. " +
    `Needs ${NATURAL_LANGUAGE_KEY_REQUIREMENT.variable} with the Cloud Natural Language API ` +
    "enabled on a Google Cloud project that has billing (5,000 entity units a month are free); " +
    "without it this Tool returns an error saying so.",
  annotations: {
    title: "Read a page's entities and categories",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read the entities on this page";

/**
 * How much of the page is sent. Each call is billed in 1,000-character units,
 * twice over — once for entities, once for classification — so this is ten
 * units of each at most, and the 5,000 free entity units a month cover five
 * hundred pages. About 1,500 words of English: the whole of most pages, and the
 * opening of a long article, which the output says when it happens.
 */
const MAX_CHARACTERS = 10_000;

/** Entities printed. The rest are counted, not dropped silently. */
const MAX_ENTITIES = 15;

/** Categories printed. Google rarely returns more than a handful. */
const MAX_CATEGORIES = 10;

/**
 * A day. Every uncached call spends billing units on the Operator's project,
 * and a page's copy rarely changes by the hour; `force_refresh` is there for
 * the edit they want to see reflected.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Lower-case, accents stripped, punctuation to spaces: "Café-Bar" → "cafe bar". */
function normalise(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether `needle` appears in `haystack` as whole words. */
function containsPhrase(haystack: string, needle: string): boolean {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

/** The names an entity goes by: its canonical name and every surface form. */
function formsOf(entity: PageEntity): string[] {
  return [entity.name, ...entity.mentionTexts].map(normalise).filter((form) => form.length >= 2);
}

type Subject = { text: string; source: "targetEntity" | "H1" | "title" };

/**
 * The entity that best stands for the stated subject, or `null`.
 *
 * A named target matches an entity whose name or a mention equals it, or
 * contains it, or is contained in it — "Acme" and "Acme Corp" are the same
 * brand for this purpose. An H1 or title is a sentence, not a name, so an entity
 * matches it when one of its names appears in it; among several, the most
 * salient is taken as the one the heading is about. The list is sorted by
 * salience already, so the first match is that one.
 */
function subjectEntity(subject: Subject, entities: PageEntity[]): PageEntity | null {
  const wanted = normalise(subject.text);
  if (!wanted) return null;
  return (
    entities.find((entity) =>
      formsOf(entity).some((form) =>
        subject.source === "targetEntity"
          ? form === wanted || containsPhrase(form, wanted) || containsPhrase(wanted, form)
          : containsPhrase(wanted, form),
      ),
    ) ?? null
  );
}

function typeLabel(type: string): string {
  return type.toLowerCase().replace(/_/g, " ");
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function renderMainEntity(subject: Subject | null, entities: PageEntity[]): string[] {
  const top = entities[0];
  if (!top) return ["Not checked: Google found no entities in the text, so there is nothing to rank."];
  if (!subject) {
    return [
      "Not checked: the page has no H1 and no title to take its subject from. Pass targetEntity",
      `to name it. The most salient entity is ${top.name} (${top.salience.toFixed(3)}).`,
    ];
  }

  const from = subject.source === "targetEntity" ? "the targetEntity you named" : `the page's ${subject.source}`;
  const lines = [`Stated subject: "${subject.text}" (${from})`];
  const match = subjectEntity(subject, entities);

  if (!match) {
    lines.push(
      subject.source === "targetEntity"
        ? `No: Google found no entity matching it in the text. The most salient is ${top.name}`
        : `Not found: the ${subject.source} names none of the entities Google found. The most salient is ${top.name}`,
      `(${typeLabel(top.type)}, ${top.salience.toFixed(3)}).` +
        (subject.source === "targetEntity" ? "" : " Pass targetEntity to name the subject directly."),
    );
    return lines;
  }

  const rank = entities.indexOf(match) + 1;
  if (rank === 1) {
    lines.push(
      `Yes: ${match.name} is the most salient entity on the page (${match.salience.toFixed(3)}).`,
    );
  } else {
    lines.push(
      `No: ${match.name} ranks #${rank} (${match.salience.toFixed(3)}); the most salient is ` +
        `${top.name} (${typeLabel(top.type)}, ${top.salience.toFixed(3)}).`,
    );
  }
  if (subject.source !== "targetEntity") {
    lines.push(
      `Inference: which entity the ${subject.source} is about was read off the names it contains;`,
      "pass targetEntity to name it yourself.",
    );
  }
  return lines;
}

function renderEntity(entity: PageEntity, index: number): string[] {
  const mentions = `${entity.mentionCount} mention${entity.mentionCount === 1 ? "" : "s"}`;
  const kind = entity.properName ? ", named" : "";
  const lines = [
    `  ${String(index + 1).padStart(2)}. ${entity.name} — ${typeLabel(entity.type)}, salience ` +
      `${entity.salience.toFixed(3)}, ${mentions}${kind}`,
  ];
  const identity = [
    entity.wikipediaUrl ? `Wikipedia: ${entity.wikipediaUrl}` : null,
    entity.mid ? `Knowledge Graph id: ${entity.mid}` : null,
  ].filter((part): part is string => part !== null);
  if (identity.length > 0) lines.push(`      ${identity.join("  ")}`);
  return lines;
}

function renderCategories(categories: ContentCategory[] | null, language: string | null): string[] {
  if (categories === null) {
    return [
      `Not checked: Google's content classifier does not read ${language ? `"${language}"` : "a language it could not detect"},`,
      "so no classification request was sent and no units were spent on it.",
    ];
  }
  if (categories.length === 0) {
    return ["None: Google returned no category it was confident enough to report for this text."];
  }
  return [
    ...categories
      .slice(0, MAX_CATEGORIES)
      .map((category) => `  ${category.name} — confidence ${category.confidence.toFixed(2)}`),
    ...withheld(categories.length, MAX_CATEGORIES, { noun: "categories" }),
  ];
}

export async function handler({ url, targetEntity }: InferSchema<typeof schema>) {
  validateUrl(url);
  // Before the page is fetched: an Operator without the key should not have
  // spent a request to their site on an answer this Tool was never going to give.
  requireConfig(NATURAL_LANGUAGE_KEY_REQUIREMENT);

  // Through the shared fetcher, which obeys the site's robots.txt and our pace,
  // and shares the request with any other Tool reading this page in the turn.
  const page = readPage(url, await fetchHtml(url));
  const visible = page.readable.mainContent();
  const totalCharacters = characterCount(visible);

  if (totalCharacters === 0) {
    return toolError(
      "Could not read the entities on this page: the page returned no visible text, so there " +
        "was nothing to send. This usually means the content is rendered by JavaScript and the " +
        "raw HTML we fetch is an empty shell. Nothing was sent to Google and no units were spent.",
    );
  }

  const sent = truncateCharacters(visible, MAX_CHARACTERS);
  const sentCharacters = characterCount(sent);
  const units = billingUnits(sent);

  const analysis = await analyzeEntities(sent);
  const categories = isClassifiable(analysis.language)
    ? await classifyText(sent, analysis.language)
    : null;

  const h1 = page.readable.texts("h1")[0]?.trim();
  const title = page.$("title").first().text().replace(/\s+/g, " ").trim();
  const subject: Subject | null = targetEntity?.trim()
    ? { text: targetEntity.trim(), source: "targetEntity" }
    : h1
      ? { text: h1, source: "H1" }
      : title
        ? { text: title, source: "title" }
        : null;

  const entities = analysis.entities;
  const lines = [
    "=== PAGE ENTITIES (Google Cloud Natural Language) ===",
    "",
    `URL: ${url}`,
    `Language, as Google read it: ${analysis.language ?? "not reported"}`,
    "",
    "The page's visible text was sent to Google Cloud Natural Language and billed to your",
    "Google Cloud project.",
    sentCharacters < totalCharacters
      ? `Sent: the first ${count(sentCharacters)} of ${count(totalCharacters)} characters of the page's main text ` +
        `(the cap is ${count(MAX_CHARACTERS)}), so entities that appear only later in the page are not weighed.`
      : `Sent: all ${count(sentCharacters)} characters of the page's main text.`,
    `Billing: about ${units} entity-analysis unit${units === 1 ? "" : "s"}` +
      (categories === null ? "" : ` and ${units} classification unit${units === 1 ? "" : "s"}`) +
      " (one unit per 1,000 characters, rounded up, per request).",
    "",
    "=== IS THE PAGE ABOUT ITS OWN SUBJECT? ===",
    "",
    ...renderMainEntity(subject, entities),
    "",
    `=== TOP ENTITIES BY SALIENCE (${entities.length} found) ===`,
    "",
  ];

  if (entities.length === 0) {
    lines.push("  None: Google found no entities in the text.");
  } else {
    entities.slice(0, MAX_ENTITIES).forEach((entity, i) => lines.push(...renderEntity(entity, i)));
    lines.push(...withheld(entities.length, MAX_ENTITIES, { noun: "entities" }));
  }

  lines.push(
    "",
    "=== CONTENT CATEGORIES ===",
    "",
    ...renderCategories(categories, analysis.language),
    "",
    "=== HOW TO READ THIS ===",
    "",
    "- Salience (0–1) is the Natural Language model's reading of how central an entity is to",
    "  this text. It is not a measurement of how Google Search understands or ranks the page.",
    "- A Wikipedia link or Knowledge Graph id means the model resolved the mention to a known",
    "  entity. No link is not proof that the entity has no entry.",
    "- Categories come from Google's V2 content category tree; confidence is how certain the",
    "  classifier is, 0–1.",
  );

  return toolText(lines.join("\n"));
}

export default defineCachedTool(
  FAILURE_CONTEXT,
  { toolName: "page_entities", domainOf: domainFromUrl, ttlMs: TTL_MS },
  handler,
);
