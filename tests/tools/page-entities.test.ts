import { describe, it, expect, afterEach, vi } from "vitest";
import pageEntities from "@/tools/page-entities";
import { billingUnits, characterCount, readEntities, truncateCharacters } from "@/lib/natural-language";
import { requestsOf, serve, type FetchMock, type Route } from "../helpers/serve";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const textOf = (result: Awaited<ReturnType<typeof pageEntities>>): string =>
  result.content.map((part) => part.text).join("\n");

const run = (args: { url: string; targetEntity?: string }) =>
  pageEntities({ targetEntity: undefined, ...args });

const PAGE_URL = "https://acme.test/widgets";

const page = (body: string, title = "Acme Widgets | Acme Corp") =>
  `<!DOCTYPE html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;

const A_PAGE = page(
  "<nav>Home About</nav><main><h1>Acme Widgets for industrial kitchens</h1>" +
    "<p>Acme Corp has built widgets in Ohio since 1990. Our widgets fit every kitchen.</p></main>",
);

/** An entities answer in v1's documented shape. */
const ENTITIES = {
  language: "en",
  entities: [
    {
      name: "widgets",
      type: "CONSUMER_GOOD",
      salience: 0.21,
      metadata: {},
      mentions: [{ text: { content: "widgets" }, type: "COMMON" }, { text: { content: "Widgets" }, type: "COMMON" }],
    },
    {
      name: "Acme Corp",
      type: "ORGANIZATION",
      salience: 0.52,
      metadata: { mid: "/m/0acme", wikipedia_url: "https://en.wikipedia.org/wiki/Acme_Corporation" },
      mentions: [{ text: { content: "Acme Corp" }, type: "PROPER" }, { text: { content: "Acme" }, type: "PROPER" }],
    },
    {
      name: "Ohio",
      type: "LOCATION",
      salience: 0.09,
      metadata: { mid: "/m/05kkh" },
      mentions: [{ text: { content: "Ohio" }, type: "PROPER" }],
    },
    // No salience: dropped, never ranked as zero.
    { name: "kitchens", type: "OTHER", mentions: [] },
  ],
};

const CATEGORIES = {
  categories: [
    { name: "/Business & Industrial/Food Service", confidence: 0.61 },
    { name: "/Home & Garden/Kitchen & Dining", confidence: 0.83 },
  ],
};

function answer(overrides: Record<string, Route> = {}): FetchMock {
  return serve({
    "acme.test/widgets": { body: A_PAGE, headers: { "content-type": "text/html" } },
    "documents:analyzeEntities": { body: JSON.stringify(ENTITIES) },
    "documents:classifyText": { body: JSON.stringify(CATEGORIES) },
    ...overrides,
  });
}

const calledWith = (mock: FetchMock, fragment: string) =>
  requestsOf(mock).find((request) => request.url.includes(fragment));

describe("page_entities without the key configured", () => {
  it("refuses naming the variable and billing, before reading the page", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", undefined);
    vi.stubEnv("PAGESPEED_API_KEY", "a-free-key");
    const mock = answer();

    const result = await run({ url: PAGE_URL });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("GOOGLE_CLOUD_API_KEY is not set");
    expect(textOf(result)).toContain("Cloud Natural Language API");
    expect(textOf(result)).toContain("billing");
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("page_entities with the key configured", () => {
  it("sends the page's visible main text, as plain text, with the key in a header", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    const mock = answer();

    await run({ url: PAGE_URL });

    const entitiesCall = calledWith(mock, "documents:analyzeEntities");
    expect(entitiesCall).toBeDefined();
    expect(entitiesCall?.url).toBe("https://language.googleapis.com/v1/documents:analyzeEntities");
    expect(entitiesCall?.headers["x-goog-api-key"]).toBe("test-key");
    const body = entitiesCall?.json as { document: { type: string; content: string } };
    expect(body.document.type).toBe("PLAIN_TEXT");
    expect(body.document.content).toContain("Acme Corp has built widgets in Ohio");
    // The nav is chrome, not the page's copy.
    expect(body.document.content).not.toContain("Home About");

    const classify = calledWith(mock, "documents:classifyText")?.json as { classificationModelOptions: unknown };
    expect(classify.classificationModelOptions).toEqual({
      v2Model: { contentCategoriesVersion: "V2" },
    });
  });

  it("ranks entities by salience with their identity, and says the text left the machine", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    answer();

    const result = await run({ url: PAGE_URL });
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain("sent to Google Cloud Natural Language");
    expect(text).toMatch(/Sent: all \d+ characters/);
    expect(text).toContain("Billing: about 1 entity-analysis unit and 1 classification unit");
    expect(text).toContain(" 1. Acme Corp — organization, salience 0.520, 2 mentions, named");
    expect(text).toContain("Wikipedia: https://en.wikipedia.org/wiki/Acme_Corporation  Knowledge Graph id: /m/0acme");
    expect(text).toContain(" 2. widgets — consumer good, salience 0.210");
    expect(text).toContain("(3 found)");
    expect(text).not.toContain("kitchens —");
    expect(text).not.toMatch(/NaN|undefined|Infinity|\[object Object\]/);
  });

  it("says whether the H1's subject is the most salient entity, as an inference", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    answer();

    const text = textOf(await run({ url: PAGE_URL }));

    expect(text).toContain('Stated subject: "Acme Widgets for industrial kitchens" (the page\'s H1)');
    // "Acme" and "widgets" both appear in the H1; Acme Corp is the more salient.
    expect(text).toContain("Yes: Acme Corp is the most salient entity on the page (0.520).");
    expect(text).toContain("Inference:");
  });

  it("names a targetEntity's rank when it is not the most salient", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    answer();

    const text = textOf(await run({ url: PAGE_URL, targetEntity: "Widgets" }));

    expect(text).toContain("No: widgets ranks #2 (0.210); the most salient is Acme Corp");
    expect(text).not.toContain("Inference:");
  });

  it("reports categories most confident first", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    answer();

    const text = textOf(await run({ url: PAGE_URL }));

    const kitchen = text.indexOf("/Home & Garden/Kitchen & Dining — confidence 0.83");
    const food = text.indexOf("/Business & Industrial/Food Service — confidence 0.61");
    expect(kitchen).toBeGreaterThan(-1);
    expect(food).toBeGreaterThan(kitchen);
  });

  it("does not classify a language the classifier cannot read, and spends nothing on it", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    const mock = answer({
      "documents:analyzeEntities": { body: JSON.stringify({ ...ENTITIES, language: "ar" }) },
    });

    const text = textOf(await run({ url: PAGE_URL }));

    expect(calledWith(mock, "documents:classifyText")).toBeUndefined();
    expect(text).toContain('Not checked: Google\'s content classifier does not read "ar"');
    expect(text).toContain("Billing: about 1 entity-analysis unit (");
  });

  it("caps what it sends and says so", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    const long = "<p>" + "Acme widgets are sturdy. ".repeat(800) + "</p>";
    const mock = answer({
      "acme.test/widgets": { body: page(`<main><h1>Acme</h1>${long}</main>`), headers: { "content-type": "text/html" } },
    });

    const text = textOf(await run({ url: PAGE_URL }));

    const sent = calledWith(mock, "documents:analyzeEntities")?.json as { document: { content: string } };
    expect(sent.document.content).toHaveLength(10_000);
    expect(text).toMatch(/Sent: the first 10,000 of [\d,]+ characters/);
    expect(text).toContain("Billing: about 10 entity-analysis units and 10 classification units");
  });

  it("refuses a page with no visible text without calling Google", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    const mock = answer({
      "acme.test/widgets": { body: page('<div id="root"></div><script>app()</script>'), headers: { "content-type": "text/html" } },
    });

    const result = await run({ url: PAGE_URL });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no visible text");
    expect(calledWith(mock, "language.googleapis.com")).toBeUndefined();
  });

  it("fails rather than answering half when Google refuses", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    answer({
      "documents:classifyText": {
        status: 403,
        body: JSON.stringify({ error: { code: 403, message: "secret remote words" } }),
      },
    });

    const result = await run({ url: PAGE_URL });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Google's Cloud Natural Language API returned HTTP 403");
    expect(textOf(result)).not.toContain("secret remote words");
    expect(textOf(result)).not.toContain("TOP ENTITIES");
  });

  it("honours the site's robots.txt", async () => {
    vi.stubEnv("GOOGLE_CLOUD_API_KEY", "test-key");
    const mock = answer({ "acme.test/robots.txt": { body: "User-agent: *\nDisallow: /" } });

    const result = await run({ url: PAGE_URL });

    expect(result.isError).toBe(true);
    expect(calledWith(mock, "language.googleapis.com")).toBeUndefined();
  });
});

describe("counting what is billed", () => {
  it("counts code points, not UTF-16 units, and rounds units up", () => {
    expect(characterCount("😀a")).toBe(2);
    expect(billingUnits("a".repeat(1_000))).toBe(1);
    expect(billingUnits("a".repeat(1_001))).toBe(2);
    expect(truncateCharacters("😀😀😀", 2)).toBe("😀😀");
  });

  it("drops an entity whose salience is not a number", () => {
    const { entities } = readEntities({ entities: [{ name: "x", salience: "high" }] });
    expect(entities).toEqual([]);
  });
});
