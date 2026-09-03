import { describe, it, expect } from "vitest";
import { load } from "cheerio";
import {
  hasLocalizedLink as hasLink,
  schemasIndicate,
  detectLocalizedPage as detectPage,
} from "@/lib/localized-page-detection";
import type { LocalizedPageKind } from "@/lib/localized-page-detection";
import { readableDocument } from "@/lib/visible-text";

/** The detectors read the parsed document plus its visible text; tests pass HTML. */
function hasLocalizedLink(html: string, kind: LocalizedPageKind): boolean {
  const $ = load(html);
  return hasLink($, readableDocument($).allText(), kind);
}

function detectLocalizedPage(
  html: string,
  schemas: unknown[],
  kind: LocalizedPageKind
): boolean {
  const $ = load(html);
  return detectPage($, readableDocument($).allText(), schemas, kind);
}

describe("hasLocalizedLink — about", () => {
  it("matches English slugs (regression: the original behavior)", () => {
    expect(hasLocalizedLink(`<a href="/about">About</a>`, "about")).toBe(true);
    expect(hasLocalizedLink(`<a href="/about-us">About us</a>`, "about")).toBe(true);
  });

  it("matches Spanish slugs the old English-only check missed", () => {
    expect(hasLocalizedLink(`<a href="/acerca-de-mi">Sobre mí</a>`, "about")).toBe(true);
    expect(hasLocalizedLink(`<a href="/quienes-somos">Info</a>`, "about")).toBe(true);
    expect(hasLocalizedLink(`<a href="/nuestro-equipo">Equipo</a>`, "about")).toBe(true);
  });

  it("matches FR/DE/PT/IT slugs", () => {
    expect(hasLocalizedLink(`<a href="/qui-sommes-nous">x</a>`, "about")).toBe(true);
    expect(hasLocalizedLink(`<a href="/uber-uns">x</a>`, "about")).toBe(true);
    expect(hasLocalizedLink(`<a href="/impressum">x</a>`, "about")).toBe(true);
    expect(hasLocalizedLink(`<a href="/quem-somos">x</a>`, "about")).toBe(true);
    expect(hasLocalizedLink(`<a href="/chi-siamo">x</a>`, "about")).toBe(true);
  });

  it("matches by visible link text when the slug is opaque", () => {
    expect(hasLocalizedLink(`<a href="/p/12">Quiénes somos</a>`, "about")).toBe(true);
    expect(hasLocalizedLink(`<a href="/x">Über uns</a>`, "about")).toBe(true);
  });

  it("does not false-positive when no about page exists", () => {
    expect(hasLocalizedLink(`<a href="/blog">Blog</a><a href="/pricing">Precios</a>`, "about")).toBe(false);
  });

  it("does not treat an absolute URL to another site's /about as the site's own (still counts — link is present)", () => {
    // Intentional: any about link in the DOM is a positive signal, matching prior behavior.
    expect(hasLocalizedLink(`<a href="https://other.com/about">x</a>`, "about")).toBe(true);
  });
});

describe("hasLocalizedLink — privacy & contact", () => {
  it("matches Spanish privacy variants", () => {
    expect(hasLocalizedLink(`<a href="/privacidad">Privacidad</a>`, "privacy")).toBe(true);
    expect(hasLocalizedLink(`<a href="/aviso-de-privacidad">x</a>`, "privacy")).toBe(true);
    expect(hasLocalizedLink(`<footer>Política de privacidad</footer>`, "privacy")).toBe(true);
  });

  it("matches DE/FR privacy variants", () => {
    expect(hasLocalizedLink(`<a href="/datenschutz">x</a>`, "privacy")).toBe(true);
    expect(hasLocalizedLink(`<a href="/politique-de-confidentialite">x</a>`, "privacy")).toBe(true);
  });

  it("matches Spanish contact variants", () => {
    expect(hasLocalizedLink(`<a href="/contacto">Contacto</a>`, "contact")).toBe(true);
    expect(hasLocalizedLink(`<a href="/contactanos">x</a>`, "contact")).toBe(true);
  });
});

describe("hasLocalizedLink — press", () => {
  it("matches English press slugs", () => {
    expect(hasLocalizedLink(`<a href="/press">Press</a>`, "press")).toBe(true);
    expect(hasLocalizedLink(`<a href="/newsroom">Newsroom</a>`, "press")).toBe(true);
  });

  it("matches Spanish/FR/DE/PT/IT press slugs", () => {
    expect(hasLocalizedLink(`<a href="/prensa">Prensa</a>`, "press")).toBe(true);
    expect(hasLocalizedLink(`<a href="/sala-de-prensa">x</a>`, "press")).toBe(true);
    expect(hasLocalizedLink(`<a href="/salle-de-presse">x</a>`, "press")).toBe(true);
    expect(hasLocalizedLink(`<a href="/pressemitteilungen">x</a>`, "press")).toBe(true);
    expect(hasLocalizedLink(`<a href="/sala-de-imprensa">x</a>`, "press")).toBe(true);
    expect(hasLocalizedLink(`<a href="/sala-stampa">x</a>`, "press")).toBe(true);
  });

  it("matches by distinctive link text", () => {
    expect(hasLocalizedLink(`<a href="/x">Sala de prensa</a>`, "press")).toBe(true);
  });

  it("does not false-positive on 'WordPress' / 'compress' in the DOM", () => {
    expect(hasLocalizedLink(`<footer>Built with WordPress. Images compress fast.</footer>`, "press")).toBe(false);
  });
});

describe("schemasIndicate", () => {
  it("detects AboutPage / ProfilePage", () => {
    expect(schemasIndicate([{ "@type": "AboutPage" }], "about")).toBe(true);
    expect(schemasIndicate([{ "@type": "ProfilePage" }], "about")).toBe(true);
  });

  it("detects ContactPage and Organization.contactPoint", () => {
    expect(schemasIndicate([{ "@type": "ContactPage" }], "contact")).toBe(true);
    expect(
      schemasIndicate([{ "@type": "Organization", contactPoint: { "@type": "ContactPoint" } }], "contact")
    ).toBe(true);
  });

  it("walks one level into @graph", () => {
    expect(schemasIndicate([{ "@graph": [{ "@type": "AboutPage" }] }], "about")).toBe(true);
  });

  it("returns false for unrelated schema", () => {
    expect(schemasIndicate([{ "@type": "WebPage" }], "about")).toBe(false);
    expect(schemasIndicate([], "about")).toBe(false);
  });
});

describe("detectLocalizedPage — schema first, link fallback", () => {
  it("passes on schema alone with no matching link", () => {
    expect(detectLocalizedPage(`<p>contenido</p>`, [{ "@type": "AboutPage" }], "about")).toBe(true);
  });

  it("passes on a localized link with no schema", () => {
    expect(detectLocalizedPage(`<a href="/acerca-de">x</a>`, [], "about")).toBe(true);
  });

  it("fails with neither", () => {
    expect(detectLocalizedPage(`<a href="/blog">x</a>`, [], "about")).toBe(false);
  });
});

describe("hasLocalizedLink ignores markup that is not visible text", () => {
  it("does not match a phrase in an aria-label", () => {
    expect(
      hasLocalizedLink(`<a href="/x" aria-label="Privacy policy">Legal</a>`, "privacy")
    ).toBe(false);
  });

  it("does not match a phrase in an alt attribute", () => {
    expect(
      hasLocalizedLink(`<img src="/a.png" alt="Contact us today" />`, "contact")
    ).toBe(false);
  });

  it("does not match a phrase inside a script", () => {
    expect(
      hasLocalizedLink(`<script>var t = "Política de privacidad";</script>`, "privacy")
    ).toBe(false);
  });

  it("does not match a phrase inside an HTML comment", () => {
    expect(hasLocalizedLink(`<!-- about us section -->`, "about")).toBe(false);
  });

  it("does not match a slug that only appears inside a script", () => {
    expect(
      hasLocalizedLink(`<script>var routes = ['href="/about"'];</script>`, "about")
    ).toBe(false);
  });

  it("does not match a slug in a non-link attribute", () => {
    // Vacuous before the change (the old regex required a literal `href=`), kept
    // as a regression guard for the anchor-based lookup.
    expect(hasLocalizedLink(`<div data-url="/acerca-de">x</div>`, "about")).toBe(false);
  });

  it("matches an <area> href in an image map", () => {
    expect(
      hasLocalizedLink(`<map><area href="/acerca-de" alt="x" /></map>`, "about")
    ).toBe(true);
  });

  it("matches a <link rel> pointing at the page", () => {
    expect(hasLocalizedLink(`<link rel="author" href="/about" />`, "about")).toBe(true);
  });

  it("does not match a <base href>, which is not a link to anywhere", () => {
    expect(hasLocalizedLink(`<base href="/about/" />`, "about")).toBe(false);
  });

  it("still matches the href of a real link", () => {
    expect(hasLocalizedLink(`<a href="/acerca-de">Info</a>`, "about")).toBe(true);
  });

  it("still matches visible link text", () => {
    expect(hasLocalizedLink(`<a href="/p/12">Quiénes somos</a>`, "about")).toBe(true);
  });
});
