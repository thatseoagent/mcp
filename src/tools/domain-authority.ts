import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { getDomain } from "tldts";
import {
  OPEN_PAGERANK_REQUIREMENT,
  readOpenPageRank,
  type DomainScore,
  type ScorePoint,
} from "../lib/open-pagerank";
import { InvalidInputError } from "../lib/invalid-input-error";
import { hostKey } from "../lib/url-match";
import { defineCachedTool } from "../lib/define-tool";
import { refreshable } from "../lib/with-cache";
import { toolText } from "../lib/tool-result";

/**
 * Ten, so a site and its competitors fit in one call. The API takes a hundred;
 * past ten a comparison is a table nobody reads, and each domain spends one of
 * the Operator's 30,000 free lookups a month.
 */
const MAX_DOMAINS = 10;

export const schema = {
  ...refreshable,
  domains: z
    .array(z.string().min(1).max(253))
    .min(1)
    .max(MAX_DOMAINS)
    .describe(
      `Up to ${MAX_DOMAINS} domains, hostnames or URLs — a site and its competitors. A subdomain ` +
        "is also scored on its own",
    ),
};

export const metadata: ToolMetadata = {
  name: "domain_authority",
  description:
    "Link authority for up to ten domains side by side — a site and its competitors — from " +
    "Open PageRank: a 0–10 score, the global rank, referring domains and the change over a year. " +
    "It is Open PageRank's own estimate from the Common Crawl link graph, not a Google metric. A " +
    "domain outside their dataset is reported as not ranked, not as zero. " +
    `Needs ${OPEN_PAGERANK_REQUIREMENT.variable}; without it this Tool returns an error saying so.`,
  annotations: {
    title: "Compare domain authority (Open PageRank)",
    readOnlyHint: true,
    destructiveHint: false,
    // Scores change once a month, with each Common Crawl release.
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "read Open PageRank scores for these domains";

/** Said before any number, because a 0–10 authority score invites one misreading above all. */
const HOW_TO_READ = [
  "Open PageRank is a third party's estimate of link authority: PageRank run over the",
  "Common Crawl web graph, combined with a weighted count of referring domains, on a",
  "logarithmic 0–10 scale. It is not a Google metric and not something Google reports,",
  "and it measures links, not traffic or rankings. Coverage follows Common Crawl, so a",
  "new site, or one that blocks crawlers, reads low. Use it to compare these domains on",
  "one yardstick, not as a verdict on any of them.",
  "Their own guide to the scale: 8–10 the most-linked sites on the web, 5–8 well",
  "established, 2–5 the broad middle, 0–2 new, small or lightly linked.",
];

interface Asked {
  /** What the Operator typed, for the output. */
  input: string;
  host: string;
  domain: string;
}

/**
 * A hostname out of whatever was given, and the registered domain it belongs to.
 *
 * `hostKey`, refused with a sentence rather than `null`, because the Operator
 * typed it and is who can correct it.
 */
function parse(input: string): Asked {
  const trimmed = input.trim();
  const host = hostKey(trimmed);
  if (host === null) {
    throw new InvalidInputError(`"${trimmed}" is not a domain, hostname or URL.`);
  }
  const domain = getDomain(host);
  if (!domain) {
    throw new InvalidInputError(`"${trimmed}" does not name a registrable domain (e.g. example.com).`);
  }
  return { input: trimmed, host, domain };
}

/** The history point closest to a year before the release, not after it. */
function yearAgo(history: ScorePoint[], asOf: string | null): ScorePoint | null {
  const latest = asOf ?? history.at(-1)?.date;
  if (!latest) return null;
  const [y, m] = latest.split("-").map(Number) as [number, number];
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  const target = `${y - 1}-${String(m).padStart(2, "0")}-01`;
  const earlier = history.filter((p) => p.date <= target);
  return earlier.at(-1) ?? null;
}

function signed(delta: number): string {
  const rounded = Math.round(delta * 100) / 100;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}`;
}

function describe(asked: Asked, result: DomainScore | undefined, asOf: string | null): string[] {
  const label = asked.domain === asked.host ? asked.domain : `${asked.host} (on ${asked.domain})`;
  const lines: string[] = [];

  if (!result?.found || result.score === null) {
    lines.push(
      `${label}: not ranked — ${asked.domain} is not in Open PageRank's dataset. That is an absence`,
      "  from their Common Crawl link graph, not a score of zero.",
    );
  } else {
    const rank = result.rank === null ? "" : `, global rank #${result.rank.toLocaleString("en-US")}`;
    const referring =
      result.referringDomains === null
        ? ""
        : `, ${result.referringDomains.toLocaleString("en-US")} referring domains (authority-weighted)`;
    lines.push(`${label}: ${result.score.toFixed(2)} / 10${rank}${referring}`);
    const before = yearAgo(result.history, asOf);
    if (before) {
      lines.push(
        `  A year earlier (${before.date}): ${before.score.toFixed(2)}, ${signed(result.score - before.score)}` +
          (before.estimated ? " — that month is interpolated by Open PageRank, not measured" : ""),
      );
    }
  }

  // A subdomain asked for by name is scored on its own too; it never scores
  // above its root, and a site on a shared platform (a blogspot.com blog) has
  // only this.
  if (asked.host !== asked.domain) {
    const host = result?.hosts.find((h) => h.host === asked.host);
    lines.push(
      host?.found && host.score !== null
        ? `  ${asked.host} itself: ${host.score.toFixed(2)} / 10` +
            (host.rank === null ? "" : `, rank #${host.rank.toLocaleString("en-US")} among hosts`)
        : `  ${asked.host} itself: not ranked as a host.`,
    );
  }
  return lines;
}

export async function handler({ domains }: InferSchema<typeof schema>) {
  const asked: Asked[] = [];
  for (const input of domains) {
    const parsed = parse(input);
    if (!asked.some((a) => a.host === parsed.host)) asked.push(parsed);
  }

  const read = await readOpenPageRank(asked.map((a) => a.host));
  const byDomain = new Map(read.results.map((r) => [r.domain, r]));
  const scored = asked.map((a) => ({ asked: a, result: byDomain.get(a.domain) }));
  // Highest first, so the comparison reads as one; not-ranked last, in the
  // order given, rather than sorted as if they were zeros.
  scored.sort((a, b) => (b.result?.found ? (b.result.score ?? -1) : -1) - (a.result?.found ? (a.result.score ?? -1) : -1));

  const lines = [
    "=== DOMAIN AUTHORITY (Open PageRank) ===",
    "",
    `Data release: ${read.asOf ?? "not stated in the response"}`,
    `Domains: ${asked.length}`,
    "",
    ...HOW_TO_READ,
    "",
    "=== SCORES (highest first) ===",
    "",
  ];
  for (const { asked: one, result } of scored) {
    lines.push(...describe(one, result, read.asOf));
  }
  return toolText(lines.join("\n"));
}

export default defineCachedTool(
  FAILURE_CONTEXT,
  {
    toolName: "domain_authority",
    domainOf: ({ domains }) => (domains[0] ? (getDomain(domains[0]) ?? null) : null),
  },
  handler,
);
