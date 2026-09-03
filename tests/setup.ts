import { beforeEach, vi } from "vitest";

// The SSRF guard resolves a hostname via DNS before fetching and refuses private
// and reserved addresses. Tests stub `fetch` but use example hostnames that do
// not resolve on a real resolver, which would make the guard throw before the
// stub is ever reached — every Tool test would fail for a reason unrelated to
// what it asserts.
//
// Resolving every hostname to a benign public address by default lets Tool tests
// exercise their own stubbed fetch. The guard's own test defines its own mock,
// which wins over this one.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

// Pacing and the robots ruleset are process-wide by design — one Operator, one
// process — which makes them the two pieces of state a test can leak into the
// next. Left alone, a suite's hundredth fetch at `example.com` would wait on a
// gap earned by the first one, and its three-hundred-and-first would be refused
// outright for a budget the tests themselves spent.
//
// Imported inside the hook rather than at the top of this file, and that is not
// a style choice. A static import here would load `ssrf-guard` — via the robots
// gate — into the module registry before any test file's own `vi.mock` was
// registered, so `tests/lib/ssrf-guard.test.ts` would silently get this file's
// DNS stub instead of its own and stop testing what it claims to.
//
// Every single-flight cache belongs on the same list. They hold a page's markup
// for sixty seconds, so a test that serves different HTML at the same URL as the
// previous one is answered with the previous one's body — and the assertion that
// fails is about rendering, three layers away from the cause.
//
// `resetAllSingleFlightCaches()` covers all six, because each registers itself
// at creation. This used to name three of them and the other three were cleared
// by hand in whichever files happened to notice, so a cache added later inherited
// the leak and produced its failure somewhere else.
beforeEach(async () => {
  const [{ resetCrawlPacing }, { resetAllSingleFlightCaches }] = await Promise.all([
    import("@/lib/crawl-pacing"),
    import("@/lib/single-flight"),
  ]);
  // Not a single-flight cache: the pacing ledger is a budget, not an answer.
  resetCrawlPacing();
  resetAllSingleFlightCaches();
});

// The unit suite runs with no database, and that is a correctness requirement
// rather than a speed one.
//
// Left unset, `TSA_DB_PATH` resolves to the real file under `db/` — so the whole
// suite would share one Tool cache. A Tool asserted twice in two cases would be
// answered from the first case's result on the second, and the case that
// stubbed a *different* `fetch` would silently never call it. That is not a
// hypothetical: it broke sixty-three assertions the moment the cache was wired
// into the Tools.
//
// A test that wants persistence opts in with `useTempDatabase()`, which points
// this variable at a temporary file and resets the connection.
// A developer with real credentials in `.env` would otherwise have them leak into
// tests that assert a variable is *not* set — those pass on CI and fail on the one
// machine that has the file. The suite configures its own environment explicitly.
process.env.TSA_ENV_FILE = "off";

beforeEach(async () => {
  process.env.TSA_DB_PATH = "off";
  const { resetPersistence } = await import("@/lib/db/runtime");
  resetPersistence();
});
