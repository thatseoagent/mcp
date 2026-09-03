import { readPage, type ParsedPage } from "@/lib/analyzers/parsed-page";

/**
 * A **Parsed Page** from an HTML fixture, for analyzers that take one since
 * ADR-0022.
 *
 * The URL is a stand-in: these tests are about what the markup says, and the
 * only things that read it are `isRoot` and the path heuristics, which the page
 * identity tests cover directly.
 */
export function page(html: string, url = "https://example.com/page"): ParsedPage {
  return readPage(url, html);
}
