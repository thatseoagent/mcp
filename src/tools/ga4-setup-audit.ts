import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { defineGoogleTool } from "../lib/define-tool";
import { notCheckedSection } from "../lib/render-basis";
import { toolText } from "../lib/tool-result";
import { UpstreamApiError } from "../lib/upstream-api-error";
import { ga4Property, ga4PropertySchema } from "../lib/google/ga4-tool-shape";
import type { Ga4DataStream, Ga4PropertyDetails, GoogleReader } from "../lib/google/reader";
import { hostKey } from "../lib/url-match";

/**
 * "Is this Analytics property set up to measure what an SEO needs?"
 *
 * ── What this reads, and what it deliberately does not ──
 *
 * Configuration, through the Admin API: how the property keeps, counts,
 * attributes and labels what it collects. Not traffic — every other `ga4_*`
 * Tool answers that. Each finding is a fact Google reported plus the sentence
 * saying why it changes what an SEO can conclude from this property. There is
 * no score: "site search is off" is not worth a number of points, and adding
 * them up would be a measurement of nothing.
 *
 * Never read: Measurement Protocol secrets. Google returns the secret value
 * itself under the read-only scope, so the reader has no method for them, and
 * that absence is the guarantee none gets printed.
 *
 * ── When one read fails (ADR-0003) ──
 *
 * `getProperty` is read first and alone, and its failure propagates. It is the
 * read that answers "can this Google account read this property at all?", and
 * a property the account cannot read is a Tool that cannot do its job — the
 * seam words that refusal, and this file must not replace it with a page of
 * "not checked".
 *
 * After it, every section is its own read, and seven of them are v1alpha
 * endpoints Google publishes as alpha and may change or withdraw. One of those
 * failing while the property is demonstrably readable is not "the Tool cannot
 * run": the retention, streams and key events it did read are still true, and
 * throwing them away over the attribution endpoint would be refusing a whole
 * answer for want of a paragraph. So a section whose read fails with an
 * `UpstreamApiError` is printed as "Not checked" with Google's status, the
 * report opens by saying it is incomplete and which sections are missing, and
 * nothing about a missing section is reported as a pass or a fail. That is
 * ADR-0003's rule for the partial case — a partial answer is allowed to exist
 * only if it says it is partial, first. Anything that is not an
 * `UpstreamApiError` (no login, a bug) still propagates.
 */

export const schema = {
  ...ga4PropertySchema,
  domain: z
    .string()
    .optional()
    .describe(
      "The site this property should be measuring, e.g. 'example.com'. When given, a web " +
        "stream whose default URL is on another host is flagged.",
    ),
};

export const metadata: ToolMetadata = {
  name: "ga4_setup_audit",
  description:
    "Is this Analytics property set up to measure what an SEO needs? Reads the property's " +
    "configuration — data retention, web streams, enhanced measurement, key events and how " +
    "they are counted, attribution, Google Signals, reporting identity, channel groups, and " +
    "whether Google Ads and BigQuery are linked — and states each setting with why it " +
    "matters for SEO analysis. No score. Several settings come from Google's v1alpha Admin " +
    "API; a section that cannot be read is reported as not checked. Needs the Google login; " +
    "without it this Tool says so.",
  annotations: {
    title: "Audit an Analytics property's setup",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/** Completes the sentence "Could not …" for every failure this Tool can return. */
const FAILURE_CONTEXT = "audit this Analytics property's setup";

/** One stated fact, and why it matters when it is not obvious. */
interface Finding {
  fact: string;
  why?: string;
  /** Worth an SEO's attention: listed again at the end. */
  attention?: boolean;
}

interface Section {
  title: string;
  /** Published only in Google's v1alpha Admin API. */
  alpha: boolean;
  findings: Finding[];
  /** Why this section, or a part of it, could not be read. */
  notChecked: string[];
}

/**
 * Run one read, turning Google's refusal into a "not checked" line.
 *
 * Only `UpstreamApiError`: see the file header for why that one, and only here.
 */
async function attempt<T>(read: () => Promise<T>): Promise<{ value: T } | { reason: string }> {
  try {
    return { value: await read() };
  } catch (error) {
    if (error instanceof UpstreamApiError) return { reason: error.message };
    throw error;
  }
}

export async function handler({ propertyId, domain }: InferSchema<typeof schema>, google: GoogleReader) {
  const { property, header } = ga4Property(propertyId, { title: "ANALYTICS SETUP AUDIT" });
  const admin = google.analyticsAdmin;

  // First and alone, and not through `attempt`: see the file header.
  const details = await admin.getProperty(property);

  const sections = await Promise.all([
    retentionSection(google, property),
    streamsSection(google, property, domain),
    keyEventsSection(google, property),
    attributionSection(google, property),
    signalsSection(google, property),
    identitySection(google, property),
    channelGroupsSection(google, property),
    linksSection(google, property),
  ]);
  sections.unshift(propertySection(details));

  const lines: string[] = [...header];
  if (details.displayName) lines.push(`Name: ${details.displayName}`);
  lines.push("Read: the property's configuration as it stands now, through Google's Analytics Admin API.");
  lines.push("This is set-up, not traffic: nothing below is a count, and nothing is scored.");

  const incomplete = sections.filter((section) => section.notChecked.length > 0);
  if (incomplete.length > 0) {
    lines.push("");
    lines.push(
      `Note: this audit is incomplete. Google refused ${incomplete.length === 1 ? "one read" : "some reads"}, ` +
        `so ${incomplete.map((section) => section.title.toLowerCase()).join(", ")} ` +
        `${incomplete.length === 1 ? "is" : "are"} marked "Not checked" below. Nothing in a section that was ` +
        "not checked is a pass or a fail; it is unknown.",
    );
  }

  for (const section of sections) {
    lines.push("");
    lines.push(`=== ${section.title.toUpperCase()} ===`);
    if (section.alpha) lines.push("(v1alpha Admin API: Google may change this endpoint without notice.)");
    if (section.notChecked.length > 0) lines.push("  Not checked — the reason is under NOT CHECKED below.");
    for (const finding of section.findings) {
      lines.push(`  - ${finding.attention ? "Attention: " : ""}${finding.fact}`);
      if (finding.why) lines.push(`    Why it matters: ${finding.why}`);
    }
  }

  const attention = sections.flatMap((section) => section.findings.filter((finding) => finding.attention));
  lines.push("");
  lines.push("=== WORTH ATTENTION ===");
  if (attention.length === 0) {
    lines.push(
      incomplete.length > 0
        ? "  Nothing in the sections that were read. The ones not checked may still hold something."
        : "  Nothing. Every setting read is one that leaves SEO analysis on this property intact.",
    );
  } else {
    for (const finding of attention) lines.push(`  - ${finding.fact}`);
  }

  // Everything this audit did not read, in one list: the reads Google refused
  // on this run, which are also said in their own section above, and the
  // settings Google publishes no API for. Those are said every time, because a
  // clean audit otherwise reads as covering them. Research, VERIFIED against
  // the Admin API reference: none of them has a resource, in v1beta or v1alpha.
  lines.push(
    ...notCheckedSection(
      [
        ...sections.flatMap((section) =>
          section.notChecked.map((reason) => ({ subject: section.title, reason })),
        ),
        {
          subject: "Whether Search Console is linked",
          reason:
            "Google publishes no API for this. There is no Search Console link resource, so whether " +
            "the organicGoogleSearch* metrics and the Search Console reports work here cannot be " +
            "read. Check Admin > Product links > Search Console links.",
        },
        {
          subject:
            "Data filters and internal traffic rules, cross-domain measurement, unwanted referrals " +
            "and consent settings",
          reason: "Google publishes no API for these. Each changes what is counted; none is readable.",
        },
      ],
      // Listed in full: a refused read cut short would be the one a reader never learns of.
      { cap: Number.POSITIVE_INFINITY },
    ),
  );

  return toolText(lines.join("\n"));
}

// ── Sections ─────────────────────────────────────────────────────────────────

function propertySection(details: Ga4PropertyDetails): Section {
  const findings: Finding[] = [];

  if (details.propertyType === "PROPERTY_TYPE_SUBPROPERTY") {
    findings.push({
      fact: "This is a subproperty.",
      why:
        "A subproperty sees only the part of its source property's data that its filter lets " +
        "through, so its totals are the site's totals only if that filter covers the whole site.",
      attention: true,
    });
  } else if (details.propertyType === "PROPERTY_TYPE_ROLLUP") {
    findings.push({
      fact: "This is a roll-up property.",
      why:
        "A roll-up combines several source properties, so its organic figures can cover more " +
        "than one site and will not match any one site's Search Console.",
      attention: true,
    });
  } else if (details.propertyType) {
    findings.push({ fact: `Property type: ${humanize(details.propertyType, "PROPERTY_TYPE_")}.` });
  }

  if (details.serviceLevel) {
    findings.push({
      fact: `Service level: ${details.serviceLevel === "GOOGLE_ANALYTICS_360" ? "Analytics 360" : details.serviceLevel === "GOOGLE_ANALYTICS_STANDARD" ? "standard" : humanize(details.serviceLevel)}.`,
      why: "It sets the retention periods on offer and the Data API quota every report here draws on.",
    });
  }

  findings.push(
    details.timeZone
      ? {
          fact: `Reporting time zone: ${details.timeZone}.`,
          why:
            "GA4 cuts its days at midnight in this zone and Search Console at midnight Pacific " +
            "Time, so a day-by-day comparison of the two is offset" +
            (details.timeZone === "America/Los_Angeles" ? " — except here, where they agree." : " by the difference."),
        }
      : { fact: "Reporting time zone: Google did not report one." },
  );
  if (details.currencyCode) findings.push({ fact: `Currency: ${details.currencyCode}.` });
  if (details.industryCategory) findings.push({ fact: `Industry: ${humanize(details.industryCategory)}.` });
  if (details.createTime) findings.push({ fact: `Created: ${details.createTime.slice(0, 10)}. Nothing before that date exists here.` });

  return { title: "Property", alpha: false, findings, notChecked: [] };
}

/**
 * Retention, with its consequence in Google's words.
 *
 * Verified against https://support.google.com/analytics/answer/7667196 on
 * 2026-09-24, which says, verbatim: "The data retention setting does not affect
 * standard aggregated reports (including primary and secondary dimensions)" and
 * "The data retention setting only affects explorations and funnel reports",
 * and "When data reaches the end of the retention period, it is deleted
 * automatically on a monthly basis." So the two-month setting does *not* make
 * the standard reports — or `ga4_run_report` — forget; it takes explorations and
 * funnels back two months at most. Stating the narrower consequence is the
 * point: the broader one is the common misreading.
 */
async function retentionSection(google: GoogleReader, property: string): Promise<Section> {
  const section: Section = { title: "Data retention", alpha: false, findings: [], notChecked: [] };
  const read = await attempt(() => google.analyticsAdmin.getDataRetention(property));
  if ("reason" in read) {
    section.notChecked.push(read.reason);
    return section;
  }
  const retention = read.value;

  if (retention.eventDataRetention === "TWO_MONTHS") {
    section.findings.push({
      fact: "Event data is kept for two months.",
      why:
        "Google: the retention setting \"only affects explorations and funnel reports\" and \"does not " +
        "affect standard aggregated reports\". So standard reports and ga4_run_report still reach back, " +
        "but an exploration or funnel (ga4_funnel_report included) cannot look further than two months: " +
        "no year-over-year funnel for organic landing pages, and no user-level detail for a drop found " +
        "late. Expired data is deleted monthly, so lengthening the period later does not bring it back. " +
        "A standard property can keep it for 14 months.",
      attention: true,
    });
  } else if (retention.eventDataRetention) {
    section.findings.push({
      fact: `Event data is kept for ${humanize(retention.eventDataRetention)}.`,
      why: "Explorations and funnel reports can reach back this far; standard reports are not limited by it.",
    });
  } else {
    section.findings.push({ fact: "Event data retention: Google did not report it." });
  }

  if (retention.userDataRetention) {
    section.findings.push({ fact: `User data is kept for ${humanize(retention.userDataRetention)}.` });
  }
  if (retention.resetUserDataOnNewActivity !== undefined) {
    section.findings.push({
      fact: `Reset user data on new activity: ${retention.resetUserDataOnNewActivity ? "on" : "off"}.`,
      why: retention.resetUserDataOnNewActivity
        ? "Each new visit restarts that user's retention clock, so returning visitors keep their history."
        : "A user's data expires on schedule even if they keep coming back.",
    });
  }

  return section;
}

async function streamsSection(
  google: GoogleReader,
  property: string,
  domain: string | undefined,
): Promise<Section> {
  const section: Section = { title: "Web data streams", alpha: false, findings: [], notChecked: [] };
  const read = await attempt(() => google.analyticsAdmin.listDataStreams(property));
  if ("reason" in read) {
    section.notChecked.push(read.reason);
    return section;
  }

  const web = read.value.filter((stream) => stream.type === "WEB_DATA_STREAM");
  const other = read.value.filter((stream) => stream.type !== "WEB_DATA_STREAM");

  if (web.length === 0) {
    section.findings.push({
      fact: `This property has no web data stream${other.length > 0 ? ` (only ${other.length} app stream${other.length === 1 ? "" : "s"})` : ""}.`,
      why:
        "Without one it collects nothing from a website, so there are no organic landing pages, " +
        "no website sessions and nothing to set against Search Console.",
      attention: true,
    });
    return section;
  }

  const expected = domain ? hostKey(domain) : null;

  for (const stream of web) {
    const measurementId = stream.webStreamData?.measurementId ?? "no measurement id reported";
    const uri = stream.webStreamData?.defaultUri;
    section.findings.push({
      fact: `${stream.displayName || stream.name} — ${measurementId}, default URL ${uri || "not set"}.`,
    });

    const host = uri ? hostKey(uri) : null;
    if (expected && host && !sameSite(host, expected)) {
      section.findings.push({
        fact: `The stream ${stream.displayName || stream.name} names ${host}, not ${expected}.`,
        why:
          "The default URL is a label set when the stream was created and does not restrict where the " +
          "tag runs, so this may be harmless — or this may be another site's property, whose traffic " +
          "would be read as this site's. Confirm before comparing it with Search Console.",
        attention: true,
      });
    }

    await streamSettings(google, stream, section);
  }

  if (other.length > 0) {
    section.findings.push({
      fact: `Also ${other.length} app stream${other.length === 1 ? "" : "s"}; property-wide totals include app activity.`,
    });
  }

  return section;
}

/**
 * Enhanced measurement and redaction, per web stream. Both v1alpha, so each
 * one's failure is its own "not checked" rather than the stream's.
 */
async function streamSettings(google: GoogleReader, stream: Ga4DataStream, section: Section): Promise<void> {
  const label = stream.displayName || stream.name;
  const [measurement, redaction] = await Promise.all([
    attempt(() => google.analyticsAdmin.getEnhancedMeasurement(stream.name)),
    attempt(() => google.analyticsAdmin.getDataRedaction(stream.name)),
  ]);

  if ("reason" in measurement) {
    section.notChecked.push(`enhanced measurement for ${label} (v1alpha): ${measurement.reason}`);
  } else {
    const settings = measurement.value;
    if (settings.streamEnabled === false) {
      section.findings.push({
        fact: `Enhanced measurement is off for ${label}.`,
        why:
          "None of GA4's automatic events — scrolls, outbound clicks, site search, forms, file " +
          "downloads, video — is collected, unless the site sends them itself.",
        attention: true,
      });
    } else {
      const off: Array<[boolean | undefined, string, string]> = [
        [
          settings.siteSearchEnabled,
          "site search",
          "what visitors search for on the site — the content they came for and did not find — is not recorded",
        ],
        [
          settings.scrollsEnabled,
          "scrolls",
          "there is no 90%-depth scroll event, one of the few engagement signals for an organic landing page",
        ],
        [
          settings.outboundClicksEnabled,
          "outbound clicks",
          "which pages send visitors off the site, and where, is not recorded",
        ],
        [
          settings.formInteractionsEnabled,
          "form interactions",
          "form starts and submits are not recorded, so a lead-generation page reached from search has no outcome",
        ],
      ];
      for (const [enabled, name, consequence] of off) {
        if (enabled === false) {
          section.findings.push({
            fact: `Enhanced measurement of ${name} is off for ${label}.`,
            why: `${capitalise(consequence)}. (Inference: the site may send the same event through Tag Manager or its own code; off here only means GA4 is not collecting it automatically.)`,
            attention: true,
          });
        }
      }
      if (settings.siteSearchEnabled && settings.searchQueryParameter) {
        section.findings.push({ fact: `Site search reads the query from: ${settings.searchQueryParameter}.` });
      }
    }

    if (!("reason" in redaction)) {
      const keys = redaction.value.queryParameterKeys ?? [];
      const searchKeys = (settings.searchQueryParameter ?? "").split(",").map((key) => key.trim()).filter(Boolean);
      const lost = redaction.value.queryParameterRedactionEnabled
        ? searchKeys.filter((key) => keys.includes(key))
        : [];
      if (lost.length > 0) {
        section.findings.push({
          fact: `Data redaction removes ${lost.join(", ")}, which site search reads its query from, on ${label}.`,
          why: "The site search terms are redacted before collection, so they never reach reports.",
          attention: true,
        });
      }
    }
  }

  if ("reason" in redaction) {
    section.notChecked.push(`data redaction for ${label} (v1alpha): ${redaction.reason}`);
  } else {
    const settings = redaction.value;
    const parts = [`email redaction ${settings.emailRedactionEnabled ? "on" : "off"}`];
    if (settings.queryParameterRedactionEnabled) {
      const keys = settings.queryParameterKeys ?? [];
      parts.push(`query parameters redacted: ${keys.length > 0 ? keys.join(", ") : "none listed"}`);
    } else {
      parts.push("query parameter redaction off");
    }
    section.findings.push({ fact: `Data redaction on ${label}: ${parts.join("; ")}.` });
  }
}

async function keyEventsSection(google: GoogleReader, property: string): Promise<Section> {
  const section: Section = { title: "Key events", alpha: false, findings: [], notChecked: [] };
  const read = await attempt(() => google.analyticsAdmin.listKeyEvents(property));
  if ("reason" in read) {
    section.notChecked.push(read.reason);
    return section;
  }

  if (read.value.length === 0) {
    section.findings.push({
      fact: "No event on this property is marked as a key event.",
      why:
        "Every conversion figure — keyEvents, session key event rate — reads zero, so organic " +
        "search cannot be tied to any outcome here. Marking an event is a toggle in Admin > Events; " +
        "the events are still being collected.",
      attention: true,
    });
    return section;
  }

  section.findings.push({ fact: `${read.value.length} key event${read.value.length === 1 ? "" : "s"}:` });
  for (const event of read.value) {
    const counting =
      event.countingMethod === "ONCE_PER_SESSION"
        ? "once per session"
        : event.countingMethod === "ONCE_PER_EVENT"
          ? "once per event"
          : "counting method not reported";
    section.findings.push({
      fact: `${event.eventName ?? "(unnamed)"} — counted ${counting}${event.custom === false ? ", one of GA4's predefined events" : ""}.`,
    });
  }
  // Said once for the section rather than per event.
  section.findings.push({
    fact: "How counting works: once per event counts every time the event fires; once per session counts it at most once per session.",
    why:
      "A once-per-event key event can exceed the sessions it came from, so a key event rate built on " +
      "it is not a share of sessions. Two events counted differently do not add up to a meaningful total.",
  });

  return section;
}

async function attributionSection(google: GoogleReader, property: string): Promise<Section> {
  const section: Section = { title: "Attribution", alpha: true, findings: [], notChecked: [] };
  const read = await attempt(() => google.analyticsAdmin.getAttributionSettings(property));
  if ("reason" in read) {
    section.notChecked.push(read.reason);
    return section;
  }
  const settings = read.value;

  const model = settings.reportingAttributionModel;
  if (model === "GOOGLE_PAID_CHANNELS_LAST_CLICK") {
    section.findings.push({
      fact: "Reporting attribution model: Ads-preferred last click.",
      why:
        "A key event is credited to Google Ads whenever an Ads click is in the path, so organic " +
        "search is credited only with conversions no ad touched: its share is understated by design.",
      attention: true,
    });
  } else if (model) {
    section.findings.push({
      fact: `Reporting attribution model: ${ATTRIBUTION_MODELS[model] ?? humanize(model)}.`,
      why:
        model === "PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN"
          ? "Where GA4 credits key events to channels by attribution, organic search's share is modelled, not counted."
          : "It decides which channel gets the credit for a key event where GA4 credits by attribution.",
    });
  }

  const windows = [
    lookback("Lookback for acquisition key events (first_open, first_visit)", settings.acquisitionConversionEventLookbackWindow),
    lookback("Lookback for other key events", settings.otherConversionEventLookbackWindow),
  ].filter((line): line is string => line !== null);
  for (const line of windows) section.findings.push({ fact: line });
  if (windows.length > 0) {
    section.findings.push({
      fact: "A search visit older than the lookback window gets no credit for a later key event.",
      why: "For content that is read long before anyone converts, a short window understates organic search.",
    });
  }

  return section;
}

const ATTRIBUTION_MODELS: Record<string, string> = {
  PAID_AND_ORGANIC_CHANNELS_DATA_DRIVEN: "data-driven, across paid and organic channels",
  PAID_AND_ORGANIC_CHANNELS_LAST_CLICK: "last click, across paid and organic channels",
};

function lookback(label: string, value: string | undefined): string | null {
  if (!value) return null;
  const days = /(\d+)_DAYS$/.exec(value)?.[1];
  return `${label}: ${days ? `${days} days` : humanize(value)}.`;
}

async function signalsSection(google: GoogleReader, property: string): Promise<Section> {
  const section: Section = { title: "Google Signals", alpha: true, findings: [], notChecked: [] };
  const read = await attempt(() => google.analyticsAdmin.getGoogleSignals(property));
  if ("reason" in read) {
    section.notChecked.push(read.reason);
    return section;
  }

  const state = read.value.state;
  if (state === "GOOGLE_SIGNALS_ENABLED") {
    section.findings.push({
      fact: "Google Signals is on.",
      why:
        "GA4 can then withhold rows that might identify someone (data thresholding), most often on " +
        "small segments and demographics. A report from this server says so when Google marks it, and " +
        "its numbers are then lower bounds — a long-tail landing page can disappear from one.",
      attention: true,
    });
  } else if (state === "GOOGLE_SIGNALS_DISABLED") {
    section.findings.push({
      fact: "Google Signals is off.",
      why: "Reports are less exposed to data thresholding, the rows GA4 withholds when they might identify someone.",
    });
  } else {
    section.findings.push({ fact: `Google Signals: ${state ? humanize(state, "GOOGLE_SIGNALS_") : "state not reported"}.` });
  }
  return section;
}

async function identitySection(google: GoogleReader, property: string): Promise<Section> {
  const section: Section = { title: "Reporting identity", alpha: true, findings: [], notChecked: [] };
  const read = await attempt(() => google.analyticsAdmin.getReportingIdentity(property));
  if ("reason" in read) {
    section.notChecked.push(read.reason);
    return section;
  }

  const identity = read.value.reportingIdentity;
  const meaning: Record<string, string> = {
    BLENDED: "user ID, then device ID, then modelling for users who declined consent",
    OBSERVED: "user ID, then device ID; no modelling",
    DEVICE_BASED: "device ID only",
  };
  section.findings.push({
    fact: `Reporting identity: ${identity ? `${humanize(identity)} (${meaning[identity] ?? "not a value this Tool knows"})` : "not reported"}.`,
    why:
      identity === "BLENDED"
        ? "User counts can include modelled users, so they will not reconcile with a tool that only counts what it saw."
        : "It decides how users are told apart, so user counts here will differ from another tool's.",
  });
  return section;
}

async function channelGroupsSection(google: GoogleReader, property: string): Promise<Section> {
  const section: Section = { title: "Channel groups", alpha: true, findings: [], notChecked: [] };
  const read = await attempt(() => google.analyticsAdmin.listChannelGroups(property));
  if ("reason" in read) {
    section.notChecked.push(read.reason);
  } else {
    const custom = read.value.filter((group) => group.systemDefined !== true);
    if (custom.length === 0) {
      section.findings.push({ fact: "No custom channel groups: only GA4's default one." });
    } else {
      section.findings.push({ fact: `${custom.length} custom channel group${custom.length === 1 ? "" : "s"}:` });
      for (const group of custom) {
        section.findings.push({ fact: `${group.displayName || group.name}${group.primary ? " (primary)" : ""}` });
      }
      if (custom.some((group) => group.primary)) {
        section.findings.push({
          fact: "The primary channel group is a custom one.",
          why:
            "Reports on the primary channel group — including its Organic Search — follow this property's " +
            "own rules, not Google's default definitions. This server's Tools read the default channel group.",
          attention: true,
        });
      }
    }
  }

  // Said whether or not the list was readable: it is a fact about GA4, not
  // about this property's configuration.
  section.findings.push({
    fact: "GA4's default channel group has had an AI Assistant channel since 2026-05-13 (medium ai-assistant).",
    why:
      "Visits from AI assistants before that date sit in Referral or elsewhere; third-party reports say the " +
      "change was not applied retroactively (inference, not a Google statement), so a comparison across that " +
      "date shows AI Assistant appearing from nothing. ga4_ai_traffic reads it.",
  });
  return section;
}

async function linksSection(google: GoogleReader, property: string): Promise<Section> {
  const section: Section = { title: "Links", alpha: false, findings: [], notChecked: [] };
  const [ads, bigQuery] = await Promise.all([
    attempt(() => google.analyticsAdmin.listGoogleAdsLinks(property)),
    attempt(() => google.analyticsAdmin.listBigQueryLinks(property)),
  ]);

  // Presence only: which Ads account or BigQuery project it is is somebody's
  // billing detail, and nothing here needs it.
  if ("reason" in ads) {
    section.notChecked.push(`Google Ads links: ${ads.reason}`);
  } else {
    section.findings.push({
      fact: ads.value.length > 0 ? `Google Ads: linked (${ads.value.length}).` : "Google Ads: not linked.",
      why:
        ads.value.length > 0
          ? "Paid search clicks and cost reach this property, so paid and organic can be compared in one place."
          : "No paid search data here; comparing paid and organic needs another source.",
    });
  }

  if ("reason" in bigQuery) {
    section.notChecked.push(`BigQuery links (v1alpha): ${bigQuery.reason}`);
  } else {
    section.findings.push({
      fact: bigQuery.value.length > 0 ? `BigQuery export: linked (${bigQuery.value.length}).` : "BigQuery export: not linked.",
      why:
        bigQuery.value.length > 0
          ? "Raw event data is exported outside GA4, where the retention setting and thresholding do not reach."
          : "There is no raw event copy, so what the retention setting deletes is gone.",
    });
  }

  return section;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** `FOURTEEN_MONTHS` → `fourteen months`. */
function humanize(value: string, prefix = ""): string {
  return value.replace(prefix, "").toLowerCase().replace(/_/g, " ");
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The same site, or one a subdomain of the other: `blog.example.com` measures `example.com`. */
function sameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export default defineGoogleTool(
  FAILURE_CONTEXT,
  { toolName: "ga4_setup_audit", domainOf: () => null },
  handler,
);
