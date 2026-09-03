/**
 * Generates `public/home.html`, the page served at `http://127.0.0.1:3737/`.
 *
 * ── Why `public/` and not `src/` ──
 *
 * `xmcp dev` watches `src/`. A `homePage` inside it makes the watcher fire a
 * second compile as soon as the first finishes; that pass races the entry write
 * and fails with `Can't resolve .xmcp/http.js`, and then the dev server starts
 * before `dist/http.js` exists and dies with `MODULE_NOT_FOUND`. It recovers on
 * the retry, which is what makes it read as noise rather than as a bug. Keeping
 * the generated file outside the watched tree avoids all of it.
 *
 * ── Why this is a script and not part of the config ──
 *
 * `xmcp.config.ts` is compiled in a sandbox with no `node:fs` — importing it
 * fails the build with `Cannot resolve module: node:fs`. So the config can only
 * name a path, and something else has to write the file. This runs from
 * `scripts/build.mjs` before the bundler, and the result is committed the same
 * way `drizzle/` is: generated, checked in, and pinned by a test that fails if
 * the committed copy has gone stale.
 *
 * ── What it can say, and what it cannot ──
 *
 * Everything here is baked at build time, so the page cannot report anything
 * live: not whether Google is connected, not how many Sites are registered.
 * What it *can* do is count what this build actually contains, which is the one
 * set of numbers most likely to rot in hand-written HTML. A Tool added tomorrow
 * is counted without anybody remembering to edit a paragraph.
 *
 * ── The design ──
 *
 * The warm-paper instrument register from the product's design system, carried
 * across because it is the same product. `#F8F5F1` ground, warm
 * near-black ink, hairline rules doing all the structural work, zero corner
 * radius, monospace labels, and Deep Ōtan Red as the single accent. The three
 * rules easiest to break by accident:
 *
 * - **One lamp.** `#C4331A` is the only saturated colour and stays well under a
 *   tenth of the page. Its rarity is what makes it read as emphasis.
 * - **Depth from rules, never shadow.** A cell lifts by going white against the
 *   paper with a `#E7E0D8` hairline. There is not one `box-shadow` in the file.
 * - **Contrast is verified against the ground.** Every ink tier below is one of
 *   the AA-checked values; the vivid `#FF4E20` appears only in the logo mark,
 *   where it is not text.
 *
 * ── No network and no assets ──
 *
 * xmcp serves no static files — `/logo.svg` is a 404 — so the mark is inlined as
 * SVG and the favicon as a data URI. The fonts are named and never fetched: a
 * loopback page on somebody's own machine has no business calling a font CDN,
 * and the instrument look survives the fallback because its signature is the
 * monospace label and the hairline rather than the face.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The one source of the listening address, shared with the server itself. */
const address = JSON.parse(readFileSync(path.join(root, "src/lib/server-address.json"), "utf8"));
const MCP_URL = `http://${address.host}:${address.port}${address.endpoint}`;

/** The palette, exactly as the product's design system records it. */
const PAPER = "#F8F5F1";
const SURFACE = "#FFFFFF";
const RAISED = "#F1ECE3";
const RULE = "#E7E0D8";
const RULE_STRONG = "#D6CCC0";
const INK_DISPLAY = "#1C1815";
const INK_PRIMARY = "#2E2822";
const INK_SECONDARY = "#5F564E";
const INK_QUIET = "#736A5F";
/** The workhorse accent. 5.0:1 on paper, so it clears AA as small text. */
const LAMP = "#C4331A";
/** The vivid brand red. Too luminous for small text; the mark only. */
const LAMP_VIVID = "#FF4E20";

/**
 * The mark: a robot's face, flush to a square of vivid red.
 *
 * Inlined at its published geometry. The one thing not to "tidy" is the flush
 * edge — the square bleeds to its own bounds with no padding, which is what makes
 * it legible at favicon size.
 */
const MARK_BODY = `<rect width="56" height="56" fill="${LAMP_VIVID}"/><g transform="translate(13 13) scale(1.25)" fill="none" stroke="${PAPER}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M12 8V4H8"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></g>`;

const MARK = `<svg width="44" height="44" viewBox="0 0 56 56" fill="none" role="img" aria-label="That SEO Agent">${MARK_BODY}</svg>`;

const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56" fill="none">${MARK_BODY}</svg>`,
)}`;

/**
 * How many `.ts` modules live under a directory, recursively.
 *
 * Recursive because resources nest: xmcp reads a URI scheme from a `(scheme)`
 * directory, so a playbook sits at `(seo)/playbooks/name.ts` and a top-level
 * count would report zero.
 */
function countModules(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countModules(path.join(dir, entry.name));
    else if (entry.name.endsWith(".ts")) total += 1;
  }
  return total;
}

/** One instrument cell: a mono label over a large monospace readout. */
function readout(label, value, note) {
  return `<div class="readout">
        <span class="label">${label}</span>
        <span class="stat">${value}</span>
        <span class="note">${note}</span>
      </div>`;
}

export function buildHomePage(counts = surfaceCounts()) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>That SEO Agent — MCP server</title>
<meta name="description" content="A local, read-only MCP server exposing SEO analysis Tools over loopback.">
<link rel="icon" href="${FAVICON}">
<style>
  /* The type stack names the brand faces and never fetches them. */
  :root {
    --paper: ${PAPER};
    --surface: ${SURFACE};
    --raised: ${RAISED};
    --rule: ${RULE};
    --rule-strong: ${RULE_STRONG};
    --display: ${INK_DISPLAY};
    --primary: ${INK_PRIMARY};
    --secondary: ${INK_SECONDARY};
    --quiet: ${INK_QUIET};
    --lamp: ${LAMP};
    --sans: "Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "Space Mono", ui-monospace, "SFMono-Regular", Consolas, monospace;
  }

  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--paper);
    color: var(--primary);
    font-family: var(--sans);
    font-size: 15px;
    font-weight: 300;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }

  .sheet { max-width: 1080px; margin: 0 auto; padding: 0 24px 96px; }

  /* Every label on the page: mono, uppercase, letter-spaced. */
  .label {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    line-height: 1;
    color: var(--quiet);
  }

  header {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 32px 0;
    border-bottom: 1px solid var(--rule);
  }
  header .wordmark {
    font-size: 24px;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--display);
    line-height: 1.1;
  }
  header .role { display: block; margin-top: 6px; }

  /* An editorial split, not a centred hero. */
  .hero {
    display: grid;
    grid-template-columns: 3fr 1fr;
    border-bottom: 1px solid var(--rule);
  }
  .hero .lead { padding: 56px 40px 56px 0; }
  .hero .rail {
    border-left: 1px solid var(--rule);
    display: flex;
    flex-direction: column;
  }

  h1 {
    font-size: clamp(40px, 6vw, 76px);
    font-weight: 700;
    line-height: 0.96;
    letter-spacing: -0.04em;
    color: var(--display);
    margin: 16px 0 24px;
  }
  /* The one lamp: a single word, at display scale, where AA-large applies. */
  h1 em { font-style: normal; color: var(--lamp); }

  .lede { max-width: 54ch; color: var(--secondary); margin: 0; }

  /* Depth is a whiter surface plus a hairline. No shadow anywhere on this page. */
  .cell {
    background: var(--surface);
    border: 1px solid var(--rule);
    padding: 24px;
  }
  .readout {
    border-bottom: 1px solid var(--rule);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 24px 0 24px 24px;
    flex: 1;
    justify-content: center;
  }
  .readout:last-child { border-bottom: 0; }
  .stat {
    font-family: var(--mono);
    font-size: clamp(32px, 4vw, 52px);
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.02em;
    color: var(--display);
  }
  .note { font-size: 13px; color: var(--quiet); line-height: 1.4; }

  section { padding: 56px 0; border-bottom: 1px solid var(--rule); }
  h2 {
    font-size: 24px;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--display);
    margin: 12px 0 24px;
  }
  h3 { font-size: 15px; font-weight: 500; color: var(--display); margin: 0 0 8px; }
  p { margin: 0 0 16px; max-width: 68ch; }
  p:last-child { margin-bottom: 0; }

  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }

  code, pre { font-family: var(--mono); font-size: 13px; }
  code { background: var(--raised); padding: 2px 5px; color: var(--display); }
  pre {
    background: var(--surface);
    border: 1px solid var(--rule);
    padding: 20px 24px;
    overflow-x: auto;
    margin: 0;
    line-height: 1.6;
    color: var(--display);
  }
  pre code { background: none; padding: 0; }

  ul { margin: 0; padding-left: 18px; color: var(--secondary); }
  li { margin-bottom: 6px; }

  a { color: var(--lamp); text-decoration: underline; text-underline-offset: 3px; }
  a:hover { text-decoration-thickness: 2px; }
  /* Never removed without a replacement. */
  a:focus-visible { outline: 2px solid var(--lamp); outline-offset: 2px; }

  .endpoint {
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
    padding-top: 24px;
    border-top: 1px solid var(--rule-strong);
    margin-top: 32px;
  }
  .endpoint .url { font-family: var(--mono); font-size: 17px; color: var(--display); }

  footer { padding: 40px 0; display: flex; gap: 32px; flex-wrap: wrap; align-items: center; }
  footer .label { color: var(--secondary); }

  @media (max-width: 780px) {
    .hero { grid-template-columns: 1fr; }
    .hero .lead { padding: 40px 0; }
    .hero .rail { border-left: 0; border-top: 1px solid var(--rule); }
    .readout { padding-left: 0; }
    .split { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="sheet">

  <header>
    ${MARK}
    <div>
      <div class="wordmark">That SEO Agent</div>
      <span class="label role">MCP server &middot; running locally</span>
    </div>
  </header>

  <div class="hero">
    <div class="lead">
      <span class="label">Read-only SEO analysis</span>
      <h1>An instrument, not a <em>dashboard</em>.</h1>
      <p class="lede">
        This server is running on your machine and listening on loopback. Point an MCP
        client at the endpoint below and its Tools become available to your agent.
        Nothing here writes to a site, a sitemap, or a Google property.
      </p>
      <div class="endpoint">
        <span class="label">Endpoint</span>
        <span class="url">${MCP_URL}</span>
      </div>
    </div>
    <div class="rail">
      ${readout("Tools", String(counts.tools), "SEO analysis capabilities")}
      ${readout("Prompts", String(counts.prompts), "Workflows that chain them")}
      ${readout("Playbooks", String(counts.resources), "Readable under seo://")}
    </div>
  </div>

  <section>
    <span class="label">Two halves</span>
    <h2>What works right now, and what needs a login</h2>
    <div class="split">
      <div class="cell">
        <h3>No credentials at all</h3>
        <p>
          Everything named <code>seo_*</code>, plus <code>crawl_site</code>. These read a
          site's public surface and work on any domain, including ones you do not own.
          They need no account, no key and no database.
        </p>
      </div>
      <div class="cell">
        <h3>Your own Google data</h3>
        <p>
          <code>gsc_*</code>, <code>ga4_*</code> and <code>run_site_audit</code> read your
          Search Console and Analytics through an OAuth client you create. Until you log
          in they stay listed and say so, rather than disappearing.
        </p>
      </div>
    </div>
  </section>

  <section>
    <span class="label">Connecting</span>
    <h2>Point a client at it</h2>
    <pre><code>{
  "mcpServers": {
    "thatseoagent": {
      "url": "${MCP_URL}"
    }
  }
}</code></pre>
    <p style="margin-top:16px">
      There is no key and no token. The server binds loopback only and refuses
      cross-origin requests, so a web page cannot drive your Tools.
    </p>
  </section>

  <section>
    <span class="label">How it reports</span>
    <h2>What this server will not do</h2>
    <ul>
      <li>A check that could not run is never reported as a check that passed.</li>
      <li>An absence of findings is an absence in the rows read, not a fact about the site.</li>
      <li>A threshold that is ours is named as ours where it is applied.</li>
      <li>A Tool that cannot do its whole job refuses and says what to configure, rather than returning a smaller result that looks complete.</li>
      <li>The AI-visibility and GEO scores are directional readings of visible signals, never measurements of how any AI system behaves.</li>
    </ul>
  </section>

  <footer>
    <span class="label">MIT licensed</span>
    <a href="https://github.com/thatseoagent/mcp">Source</a>
    <a href="https://github.com/thatseoagent/mcp/blob/master/docs/setup.md">Setup guide</a>
    <a href="https://github.com/thatseoagent/mcp/tree/master/docs/adr">Decisions</a>
  </footer>

</div>
</body>
</html>
`;
}

/** What this build contains. */
export function surfaceCounts() {
  return {
    tools: countModules(path.join(root, "src/tools")),
    prompts: countModules(path.join(root, "src/prompts")),
    resources: countModules(path.join(root, "src/resources")),
  };
}

export const HOME_PAGE_PATH = path.join(root, "public/home.html");

/** Write the page. Returns whether the file on disk changed. */
export function writeHomePage() {
  const html = buildHomePage();
  let existing = null;
  try {
    existing = readFileSync(HOME_PAGE_PATH, "utf8");
  } catch {
    // Not written yet, which is the first-run case.
  }
  if (existing === html) return false;
  writeFileSync(HOME_PAGE_PATH, html);
  return true;
}

// Run directly (`node scripts/build-home-page.mjs`) as well as being imported by
// the build, so the page can be regenerated on its own while iterating on it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(writeHomePage() ? "Wrote public/home.html\n" : "public/home.html was already current\n");
}
