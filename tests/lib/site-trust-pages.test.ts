import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTrustPages, showsTrustPage } from "@/lib/site-trust-pages";
import { readPage } from "@/lib/analyzers/parsed-page";
import { serveHtml, restoreFetch } from "../helpers/serve-html";
import { resetAllSingleFlightCaches } from "@/lib/single-flight";

/**
 * #340: four E-E-A-T indicators asked a question about the site and answered it from
 * whatever the one analyzed page linked. The evidence is asymmetric — a link here
 * proves the site has the page, its absence proves nothing — so only a negative sends
 * us to the home.
 */

/**
 * `showsTrustPage` takes a **Parsed Page** since ADR-0022, so synthetic schemas
 * go into the document as the `<script>` a real page would carry rather than
 * beside it as a fourth argument. Closer to the real input, and it stops this
 * helper from being the only place that can assemble the three values the
 * function used to ask for separately.
 */
const shows = (html: string, kind: "privacy" | "about" | "contact", schemas: unknown[] = []) => {
  const withSchemas = schemas.length
    ? html.replace("<body>", `<body><script type="application/ld+json">${JSON.stringify(schemas)}</script>`)
    : html;
  return showsTrustPage(readPage("https://example.com/page", withSchemas), kind);
};

afterEach(() => {
  restoreFetch();
  resetAllSingleFlightCaches();
});

describe("showsTrustPage reads one document by one rule", () => {
  it("finds a Spanish about page by localized slug, not just an English one", () => {
    expect(shows(`<html><body><nav><a href="/nuestro-equipo">Nuestro equipo</a></nav></body></html>`, "about")).toBe(true);
  });

  it("finds an about page from AboutPage schema with no matching link", () => {
    expect(shows(`<html><body><p>contenido</p></body></html>`, "about", [{ "@type": "AboutPage" }])).toBe(true);
  });

  it("counts a mailto as contact information, which the localized detector alone does not", () => {
    // The reason the contact rule lives in this module: applying a narrower rule to
    // the home than to the page would let a home with an email and no /contact link
    // overturn nothing.
    expect(shows(`<html><body><a href="mailto:hi@example.com">Write</a></body></html>`, "contact")).toBe(true);
  });

  it("does not invent a privacy policy where there is none", () => {
    expect(shows(`<html><body><p>just words</p></body></html>`, "privacy")).toBe(false);
  });
});

describe("resolveTrustPages", () => {
  it("spends no request when the page already answers every kind", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const found = await resolveTrustPages("https://example.com/deep/article", {
      privacy: true,
      about: true,
    });

    expect(found.privacy).toEqual({ answer: "present", where: "page" });
    expect(found.about).toEqual({ answer: "present", where: "page" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("spends no request when the analyzed page IS the home", async () => {
    // The site-refresh path: `url` is the domain root, so there is no second room to
    // look in and the negative is already settled.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const found = await resolveTrustPages("https://example.com", { about: false });

    expect(found.about).toEqual({ answer: "absent" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers a deep page's negative from the site home", async () => {
    serveHtml({
      "https://example.com/": `<html><body><footer><a href="/privacy">Privacy</a><a href="/about">About</a></footer></body></html>`,
    });

    const found = await resolveTrustPages("https://example.com/blog/how-we-migrated", {
      privacy: false,
      about: false,
      contact: false,
    });

    // This is the bug the issue names: an ordinary deep article on a site with a full
    // footer scored 0/5 three times over.
    expect(found.privacy).toEqual({ answer: "present", where: "home" });
    expect(found.about).toEqual({ answer: "present", where: "home" });
    // And a site that genuinely publishes no contact details still says so.
    expect(found.contact).toEqual({ answer: "absent" });
  });

  it("keeps a positive found on the page as a page answer, even while reading the home", async () => {
    serveHtml({ "https://example.com/": `<html><body><a href="/about">About</a></body></html>` });

    const found = await resolveTrustPages("https://example.com/blog/post", {
      about: true,
      privacy: false,
    });

    expect(found.about).toEqual({ answer: "present", where: "page" });
    expect(found.privacy).toEqual({ answer: "absent" });
  });

  it("says it does not know when the home cannot be read", async () => {
    // A 5xx on the home is not evidence about a privacy policy. Scoring it as one is
    // the bug #337 is named after, so the answer has a third state.
    serveHtml({});

    const found = await resolveTrustPages("https://example.com/blog/post", { privacy: false });

    expect(found.privacy.answer).toBe("unknown");
    if (found.privacy.answer === "unknown") {
      expect(found.privacy.reason).toMatch(/home could not be read/);
    }
  });
});
