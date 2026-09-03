# Checks that cannot run: auditing the class #337 names, not the two known instances

> **This is a research note for issue #337.** It validates or refutes every factual claim the issue
> makes against the code and against the specs that own each behaviour, and it answers the one
> question the issue explicitly left open — *which checks in `ai-visibility-analyzer`,
> `eeat-analyzer` and `security-analyzer` are structurally inapplicable to some inputs?*
> **It fixes nothing and decides nothing.** Every claim about this codebase cites the file and line
> it was read from; every external claim cites a URL. Where the code could not settle something, it
> says so instead of filling the gap.
>
> **Status, added after the fact.** The audit was acted on in four commits on
> `fix/issue-337-checks-that-cannot-run`: the primitive (§1–§3, §5, §7), the external lookups
> (§6.3, §8.2), page identity in `eeat` and `ai-visibility` (§6.2 and §6.3's freshness check), and
> the HSTS transport gate (§6.1). Everything below describes the code **as it was audited**, which
> is what makes the citations checkable; read #337 and its spin-offs for what changed. Four findings
> were deliberately left in place and tracked instead: `eeat`'s four site-level indicators (#340),
> the points awarded on evidence that proves nothing (#341), the checks a Spanish page cannot pass
> (#342), and `entity_mentions`' six platform lookups (#343).

Read dates: repository read **2026-08-17** on branch `master` at `cb57123`. (An earlier draft of this
header claimed `7d245a2` on `feature-redesign`; `git diff --stat cb57123 7d245a2` over `lib/analyzers`,
`lib/tools`, `tests/lib/analyzers` and every doc cited here is empty, so the two commits are identical
for this note's purposes and every line number below holds on `master`.) RFC Editor, MDN, W3C,
schema.org and Google Search Central read **2026-08-17**; URLs at the foot.

Labels used throughout: **VERIFIED** = read from the cited line or compiled. **INFERRED** = a
conclusion drawn from verified facts, marked as such. **UNSETTLED** = the code does not determine it.

---

## Summary: the issue is right about the class and wrong about the mechanism

#337's central claim — *"a check that could not be evaluated, reported as if it had been"* — is
**confirmed as a live class, and it is much wider than the issue estimates.** Of 40 scored checks in
the three `na`-less modules, **32 can be made unanswerable by legitimate input and print a penalty
anyway**, and 9 of those additionally have a path that prints an unearned pass. Three of them state
their own inability in the text they print while still charging points, which is the purest form of
the bug:

- `ai-visibility-analyzer.ts:326-342` prints *"Could not compare"* and docks 6 points.
- `ai-visibility-analyzer.ts:604-614` prints *"robots.txt not accessible"* and docks 8 points.
- `geo-analyzer.ts:422-449` prints *"No sitemap available to check"* and docks 5 points — inside the
  module #288 already fixed.

But the issue's stated **mechanism** for "why a third is likely" does not hold. It says the moment
anyone adds `na: true` to a check in `ai-visibility`, `eeat` or `security`, "that check silently
earns full marks". In two of those three, and in the third at check level, **that line does not
compile**: `na` is not a member of `AiVisibilityCheck`, `EeatIndicator` or `SecurityCheck`, so TypeScript
rejects it as an excess property (probed, §3.2). The unsafe path is real but lives in exactly one
place the issue does not name — `security-analyzer`'s award ladders, which are typed `Scorable[]`.

And "the arithmetic is sound today" is **false for a different reason than `na`**: `ai_visibility_score`
prints `X/100` and grades against a fixed denominator of 100 while the checks it sums total **91**
(96 with a Knowledge Graph key). That is the same `const MAX = 40` drift `scored-checks.ts:21-23`
was written to make impossible, resurrected one layer above it (§4).

---

## 1. Verdict table on #337's claims

| # | #337 says | Verdict | Decided by |
|---|---|---|---|
| 1 | `earnedBy` returns `check.points` in full when `na` is true | **CONFIRMED** | `lib/analyzers/scored-checks.ts:79-82` — `if (check.na) return check.points;` |
| 2 | The "subtract from both sides" requirement is documented only in a doc comment (~62-69) | **CONFIRMED** | `scored-checks.ts:62-69` (`Scorable.na`) and `:97-102` (`notApplicablePoints`) are the only statements of it. No runtime assertion, no type constraint, no test. |
| 3 | The requirement is enforced nowhere | **CONFIRMED** | Only caller that subtracts: `geo-analyzer.ts:168,171-172`. Nothing forces it. |
| 4 | Four modules call `tally()` | **CONFIRMED at module level, PARTLY at call-site level** | 4 modules, **10 call sites**: `geo-analyzer.ts:74`; `ai-visibility-analyzer.ts:392` (via `totals()`, reached from `:382` and `:635`); `eeat-analyzer.ts:278,365,443,536`; `security-analyzer.ts:169,208,375`. Repo-wide grep for `tally(`/`earnedBy(`/`notApplicablePoints` returns no other production caller. **No callers in `lib/mcp/tools/**` or elsewhere in `lib/tools/**`** — the issue's list is complete. |
| 5 | `geo-analyzer`: calls tally / sets `na` / subtracts | **CONFIRMED** | `:74` / `:127,318` / `:168` |
| 6 | `ai-visibility-analyzer`: calls tally / no `na` / no subtraction | **CONFIRMED** | `:392` / no `na` anywhere / no `notApplicablePoints` import |
| 7 | `eeat-analyzer`: same | **CONFIRMED** | `:278,365,443,536` / no `na` / no subtraction |
| 8 | `security-analyzer`: same | **CONFIRMED, with a correction of granularity** | `:169,208,375` — but these tally **award ladders inside three of seven checks**, not the check list. The module's own total is a hand-written reduce at `:69-70`. See §2. |
| 9 | "The arithmetic is **sound today**" | **PARTLY — no `na` path exists, but the score is still wrong** | No `na` is set in the three modules (VERIFIED, §3.1). But `ai-visibility-tools.ts:234,260` grades and prints against 100 while `l1.max + l4.max` = **91** (96 with `GOOGLE_KG_API_KEY`). §4. |
| 10 | "only because three of the four modules never load the gun" | **REFUTED as stated** | It is not restraint, it is the type system. `na: true` on an `AiVisibilityCheck`, `EeatIndicator` or `SecurityCheck` literal is `TS2353` (compiled, §3.2). The gun **is** loaded in `security-analyzer`'s `awards: Scorable[]` (`:163,201,368`), where `na` is legal and would silently credit. |
| 11 | "There is no test that would fail" | **CONFIRMED** | No test in `tests/` asserts that a `tally()` caller normalizes. §7. |
| 12 | `CROSS_PAGE_NA` exists at `crawler-tools.ts:19-33` | **CONFIRMED** (constant is `:30-33`, doc comment `:20-29`) | `lib/tools/crawler-tools.ts:20-33` |
| 13 | It covers all four cross-page sections | **CONFIRMED** | One string naming all four, emitted once at `:161-162`. Broken links deliberately not rendered (`:155-160`), and `docs/site-crawler.md:118` records why. |
| 14 | No fifth cross-page section was missed | **CONFIRMED** | The only remaining page-comparing artefact is `report.brokenLinks`, explicitly excluded (`:155-160`). `SHORTEST PAGES` and `ISSUE SUMMARY` are per-page and still render (`:164-177`). |
| 15 | `MAX_PAGES = 1` | **CONFIRMED** | `crawler-tools.ts:18`. Not per plan: **"Access is binary (active/inactive); there are no plan tiers"** (`docs/site-crawler.md:124-125`). |
| 16 | (implied) the BFS engine is capped at 1 everywhere | **REFUTED** | `crawlSite` is also called with a sample size up to **200** by `gsc_index_coverage_analysis` (`lib/google/index-coverage.ts:105`). The cap is one tool's constant, not the crawler's. |
| 17 | The #288 fix excludes N/A from both numerator and denominator | **CONFIRMED, arithmetic correct** | `geo-analyzer.ts:162-174`. Division guarded (`applicableMax > 0 ? … : 0`, `:173`), clamped `[0,100]` (`:174`). |
| 18 | (not claimed) the #288 fix is complete | **REFUTED — the class survives inside it** | Category headers still print `na` credits: `category()` uses raw `tally` (`geo-analyzer.ts:74-75`), so `geo-tools.ts:227` prints **"CONTENT FRESHNESS: 15 / 15"** for a homepage where both checks are `na`. And the all-`na` edge case grades **"Low"**, not "not assessable" (§5). |
| 19 | `tests/lib/analyzers/scored-checks.test.ts` tests the primitives but asserts nothing about callers | **CONFIRMED** | §7 lists what it covers. |
| 20 | `security-analyzer` candidate: header ladders on `http://` where some headers are inert | **CONFIRMED for HSTS only, at MUST level; REFUTED for CSP / X-Frame-Options / Referrer-Policy; PARTLY for Permissions-Policy; MOOT for cookies** | §6.1 |
| 21 | `eeat-analyzer` candidate: author/credential signals on page types with no author | **CONFIRMED, and sharper than the issue puts it** | The repo already owns the predicate (`page-identity.ts:231-233`) and `geo-analyzer` already uses it (`:592-594,614-616`). `eeat-analyzer` never calls it. §6.2 |
| 22 | `ai-visibility-analyzer` candidate: checks presupposing a page type or absent schema | **CONFIRMED, and the worse problem is adjacent** | Page-type presupposition is real (§6.3), but the bigger defect is **failed external lookups reported as negative findings** (Wikidata, Knowledge Graph, robots.txt). §6.3 |

---

## 2. The corrected caller table

Every module that touches `scored-checks`, with line numbers. **VERIFIED** by repo-wide grep for
`tally(`, `earnedBy(`, `notApplicablePoints`, `Scorable`, `\.na\b`.

| Module | `tally()` call sites | Granularity of what it tallies | Sets `na`? | Subtracts `notApplicablePoints`? | Can `na` be written without a compile error? |
|---|---|---|---|---|---|
| `lib/analyzers/geo-analyzer.ts` | `:74` (inside `category()`) | the category's `GeoCheck[]` | **yes** — `naCheck()` at `:126-128`, called from `:242,251,379,380,594,616,710,761,793,810,836,873,921,1095`; plus one literal at `:316-324` (Speakable) | **yes**, `:168` → `:171-172` | yes — `GeoCheck` declares `na` (`:30-45` region, used at `:127`) |
| `lib/analyzers/ai-visibility-analyzer.ts` | `:392` (inside `totals()`), reached from `:382` (`scoreL1`) and `:635` (`scoreL4`) | the layer's `AiVisibilityCheck[]` | no | no — does not import it | **no** — `TS2353` (§3.2) |
| `lib/analyzers/eeat-analyzer.ts` | `:278`, `:365`, `:443`, `:536` | each category's `EeatIndicator[]` | no | no — does not import it | **no** — `TS2353` (§3.2) |
| `lib/analyzers/security-analyzer.ts` | `:169`, `:208`, `:375` | **an award ladder inside one check**, not the check list | no | no — does not import it | **at check level: no** (`TS2353`). **At award level: YES** — `awards` is `Scorable[]` at `:163,201,368` |

Three corrections to the issue's table:

1. **`security-analyzer` does not tally its checks.** Its own total is `checks.reduce(...)` by hand
   at `:69-70`, and the grade comes from that percentage at `:73-74`. `tally` is used three levels
   down, on the partial-credit ladders of HSTS (`:163-169`), CSP (`:201-208`) and Permissions-Policy
   (`:368-375`). The remaining four checks (`checkXFrameOptions:233`, `checkXContentTypeOptions:270`,
   `checkReferrerPolicy:303`, `checkXXssProtection:393`) compute a score arithmetically and never
   touch `scored-checks` at all.
2. **This is where the unsafe path actually is.** Because `awards` is typed as the shared `Scorable[]`,
   `{ points: 5, earned: 0, na: true }` compiles (VERIFIED, §3.2), and `earnedBy` (`:79-82`) would
   return 5 while `tally`'s `max` also counts 5 — so the check's `maxScore` (`:176,222,382`) would
   include it and `analyzeSecurityHeaders`'s denominator (`:70`) would too. The result is a silent
   inflation of exactly the #288 shape. This is the one place in the three modules where #337's
   feared scenario is representable.
3. **`ai-visibility` and `eeat` tally sub-lists too**, not one list per module: `ai-visibility` twice
   (L1, L4 — L2's four signals at `:401-451` are **unscored**, carrying `found` and no `points`), and
   `eeat` four times, once per E-E-A-T category.

Consumers of `na` outside the analyzers, for completeness: `geo-analyzer.ts:1079` (recommendations
skip `na` checks), `geo-tools.ts:229` (renders `–`), `geo-tools.ts:277` (persists `na` on the stored
section), `components/report/sections/GeoSection.tsx:89` (renders it in the dashboard). No other
surface reads it — which is why `eeat` and `ai-visibility` have no `–` icon to reach for
(`eeat-tools.ts:47,57,67,77` and `ai-visibility-tools.ts` render a binary `✓`/`✗` only).

---

## 3. Is any `na` check inflating a score today?

### 3.1 No — VERIFIED by exhaustion

Repo-wide, `na` is written in production code at only these places, all inside `geo-analyzer`:
`:127` (the `naCheck` factory) and `:318` (the Speakable literal). Nothing in
`ai-visibility-analyzer.ts`, `eeat-analyzer.ts` or `security-analyzer.ts` sets it, spreads a check
from another module, or shares a check builder with `geo-analyzer` — the three modules import from
`scored-checks` and nothing else that produces checks (`ai-visibility-analyzer.ts:8-12`,
`eeat-analyzer.ts:6-13`, `security-analyzer.ts:6-8`). There is no transitive path.

### 3.2 The reason is the type system, not caller discipline — VERIFIED by compiling

I compiled a probe against the real declarations (`tsc` 
from `node_modules/.bin`, `--strict`):

```
na-probe.ts:8:62 - error TS2353: Object literal may only specify known properties,
  and 'na' does not exist in type 'AiVisibilityCheck'.
na-probe.ts:4:59 - error TS2353: … does not exist in type 'EeatIndicator'.
na-probe.ts:6:96 - error TS2353: … does not exist in type 'SecurityCheck'.
```

while `const awards: Scorable[] = []; awards.push({ points: 5, earned: 0, na: true });` compiled
clean. So:

- `AiVisibilityCheck` (`ai-visibility-analyzer.ts:22-39`), `EeatIndicator`
  (`eeat-analyzer.ts:29-44`) and `SecurityCheck` (`security-analyzer.ts:20-27`) each declare their
  own field set without `na`, and none carries an index signature. Excess-property checking on the
  object literals these modules push therefore rejects `na` at compile time. #337's scenario — *"the
  moment anyone adds `na: true`"* — fails `pnpm exec tsc --noEmit` in all three at check level.
- The exception is `security-analyzer`'s three `awards: Scorable[]` arrays. **INFERRED consequence:**
  a future partial-credit ladder that wanted to say "this rung does not apply to this site" would
  reach for `na`, get no complaint from the compiler, and inflate both the check's `maxScore` and the
  module's denominator.

This is a **stronger** finding than the issue's, not a weaker one: the invariant is currently held by
three independent type declarations that were written for unrelated reasons (each module keeps its own
field names, `scored-checks.ts:32-36`), and nothing records that they are load-bearing. Widening any
of them to `Scorable` — the obvious "cleanup" — would silently arm the bug.

### 3.3 But a score *is* inflated today, by the sibling mechanism

See §4. `na` is not the only way a denominator can lie.

---

## 4. `ai_visibility_score` grades against a maximum it cannot reach

**VERIFIED by summing the literals.** `scoreL1` pushes checks worth
7 (`:270`) + 7 (`:289`) + 7 (`:303`) + 6 (`:313`) + 6 (`:340`) + 0 (`:356`) = **33**, plus 5
(`:367`) only when `GOOGLE_KG_API_KEY` is set (`:363`). `scoreL4` pushes
10 (`:490`) + 8 (`:509`) + 6 (`:522`) + 6 (`:536`) + 6 (`:547`) + 3 (`:562`) + 3 (`:580`) + 3
(`:595`) + 8 (`:612`) + 5 (`:629`) = **58**. Total reachable: **91**, or **96** with a KG key.

`ai-visibility-tools.ts:233-234` then does:

```ts
const totalScore = l1.score + l4.score;
const grade = toGrade(totalScore, 100);
```

and `:260` prints `Score: ${totalScore}/100`. So a site that passes every single check is reported as
**91/100** (or 96/100), and `toGrade` (`ai-visibility-analyzer.ts:244-250`) divides by 100 rather than
by `l1.max + l4.max`. Two consequences:

- A flawless site cannot be shown a perfect score, and the band boundaries (0.85 / 0.60 / 0.35) are
  each effectively 9% stricter than they read.
- **The denominator changes with deployment configuration.** With a KG key the reachable maximum is
  96 and without it 91, while the printed denominator stays 100 — so the same site scores differently
  on two deployments and neither number is out of what it says.

This is precisely the failure `scored-checks.ts:21-23` and `tests/lib/analyzers/google-conformance.test.ts:275-288`
were written to prevent (`scoreL1` keeping `const MAX = 40` after a check dropped to 0 points). The
per-layer maxima were fixed and are tested (`google-conformance.test.ts:286`); the **aggregate** was
not, and there is no test covering `l1.max + l4.max` against the 100 in `toGrade`. `geo-tools.ts:180`
sets `const maxScore = 100` too, but legitimately: `computeGeoScore` already normalized to a
percentage (`geo-analyzer.ts:173`).

**INFERRED, flagged as such:** this is the same reasoning error as #337's class one level up —
a denominator asserted rather than derived. It belongs in the same fix.

---

## 5. The #288 fix: correct arithmetic, surviving instances of the class

### 5.1 The arithmetic is right

`computeGeoScore` (`geo-analyzer.ts:155-182`), VERIFIED line by line:

- `:165-169` accumulates `rawEarned` (which *includes* `na` credits, because `category()` used raw
  `tally` at `:74`), `nominalMax`, and `naPoints`.
- `:171-172` subtracts `naPoints` from both sides and adds the KG bonus to both.
- `:173` guards division: `applicableMax > 0 ? Math.round((earned / applicableMax) * 100) : 0`. **No
  division by zero is possible.**
- `:174` clamps to `[0,100]`.
- `:176-179` bands: ≥85 Excellent, ≥70 Good, ≥50 Moderate, else Low.

### 5.2 Edge case: every check `na` → the page is graded **"Low"**

**VERIFIED.** If every check on every category is `na`, then `rawEarned === nominalMax === naPoints`,
so `earned = kgEarned` and `applicableMax = kgApplicable`. Without a KG key both are 0, `:173` takes
the `: 0` branch, and `:176-179` assigns **"Low"**. With a key and no KG entity: `earned = 0`,
`applicableMax = 5`, score 0, again **"Low"**.

So the one input for which nothing could be assessed produces the report's worst grade. `naPoints > 0`
does print the qualifier at `geo-tools.ts:216-218`, and `Applicable: 0 / 0 raw points earned` at
`:215` is at least not a lie — but `Grade: Low` at `:213` is the #337 bug in the module that fixed
#288. **UNSETTLED:** whether this state is reachable in practice. It needs a `PageKind` for which
every gated check is `na`; the gates are `isUndatedPage` (6 kinds) and `isUnauthoredPage` (4 kinds),
`page-identity.ts:220-233`, and several categories (`TECHNICAL`, `AI CRAWLER ACCESS`,
`CONTENT STRUCTURE`) contain no gated checks at all, so probably not. I did not construct an input to
prove it either way.

### 5.3 Reachable today: category headers print `na` credits as earned points

**VERIFIED, and this is a live instance of #337's class.** `category()` (`geo-analyzer.ts:70-76`)
stores the raw `tally` — which credits `na` in full — as the category's `score`, and `geo-tools.ts:227`
prints it verbatim:

```ts
lines.push(`\n${cat.name}: ${cat.score} / ${cat.maxScore}`);
```

For a `homepage` (an `isUndatedPage` kind, `page-identity.ts:220-223`):

- **CONTENT FRESHNESS** consists of exactly two checks, both `na` (`:379-380`), and the `else` branch
  that would add real ones is skipped (`:381-450`). The category prints **`CONTENT FRESHNESS: 15 / 15`**,
  with two `–` rows beneath it. A reader — or a model summarizing the report — sees a category at 100%.
- **FRESHNESS SIGNALS** has 7 `na` (`:836`) + 4 real (`:859-868`) + 4 `na` (`:873`). A homepage with no
  `Last-Modified`/`ETag` prints **`FRESHNESS SIGNALS: 11 / 15`** — 73% while earning 0 of the 4 points
  it could actually earn.

The same numbers are persisted (`geo-tools.ts:271-272`) and rendered in the dashboard
(`GeoSection.tsx:89` renders the rows with `na`, but the category header takes `score`/`max`). The
top-line score is correct; every intermediate figure a reader actually reads is not.

**And it has a colour.** `GeoSection.tsx:83` derives the category badge's colour from the same pair:
`scoreColor(Math.round((cat.score / cat.max) * 100))`. So `CONTENT FRESHNESS: 15 / 15` on a homepage
is not merely a wrong number in a text report — it is a **green** card in the dashboard, which is the
strongest "you are fine here" signal the UI has. VERIFIED at `components/report/sections/GeoSection.tsx:82-85`.

### 5.4 Also in geo: checks that could not run, penalized

`scoreFreshness`'s sitemap-consistency check (`:418-449`) awards `passed: sitemapConsistent`, which is
`false` for four distinct "could not evaluate" states, each with its own honest detail string and each
costing the same 5 points: *"No sitemap available to check"* (`:423`), *"No page URL supplied, cannot
match a sitemap entry"* (`:425`), *"Page is not listed in the sitemap"* (`:429`), *"Sitemap lists this
page but publishes no lastmod for it"* (`:431`). The comment at `:427-428` explicitly notes the third
is a different finding — and then scores it identically.

---

## 6. The open question: per-check audit of the three `na`-less modules

Method, as #337 asks: for each check, *can the input make this question unanswerable, and what does it
print then?* Classification: **(a)** always answerable; **(b)** inapplicable for some inputs → prints
a false pass / unearned credit; **(c)** inapplicable for some inputs → prints an unearned penalty.
Checks marked **(b)+(c)** have both paths.

Counts: **40 scored checks** audited (`security` 7, `eeat` 16, `ai-visibility` 17 including the
conditional KG check), plus **4 unscored L2 signals**.

- **(a) always answerable: 8**
- **(b) false pass path: 9** — every one of which is also (c)
- **(c) unearned penalty: 32**

> **Correction, added after the first draft.** This note originally counted 8 in bucket (b) and put
> `ai-visibility`'s "AI crawlers allowed" in (c) only. A follow-up trace of `checkAiBotAccess`
> (`ai-visibility-tools.ts:105-117`) found it also has a false-pass path — `:109` tests `status === 0`
> and never the status *range*, so a **500 with a response body** yields `"ok"` and prints 8/8 "all
> crawlers allowed" about a server that never answered correctly. See §6.3 and §8.2.

### 6.1 `security-analyzer.ts` — 7 checks

The URL's scheme is available to `analyzeSecurityHeaders` (`:47`, it builds nothing from it) but
**not** to the checks: `performSecurityChecks(headers: SecurityHeaders)` (`:105`) receives only the
seven header strings (`:10-18`). `fetchHeaders` discards `safeFetch`'s `finalUrl`
(`lib/utils/http-client.ts:137` returns `response.headers` only, though `ssrf-guard.ts:236,292`
computes and returns it). And `validateUrl` admits `http://` — `parsed.protocol.startsWith("http")`
(`http-client.ts:194`), and `ssrf-guard.ts:181` allows both schemes. So an `http://` URL that does
not redirect is scored with the same seven-header ladder as an HTTPS one, and **the checks cannot
know**. This is a structural blocker, not an oversight to patch in a branch.

| Check | Lines | What it asserts | Unanswerable when… | Prints today | Class |
|---|---|---|---|---|---|
| Strict-Transport-Security | `:135-182` | site enforces HTTPS via HSTS | the response is served over plain `http://` | `✗ Missing (0/20)` + `🔴 CRITICAL: Add HSTS header` (`:445-449`, `security-tools.ts:44,65`) | **(c)** — 20 of 94 points, ~21% of the grade |
| Content-Security-Policy | `:187-228` | a policy exists and is not permissive | never — CSP enforces over http | `✗ Missing (0/25)` | **(a)** |
| X-Frame-Options | `:233-265` | framing is restricted | never | `✗ Missing (0/15)` | **(a)** |
| X-Content-Type-Options | `:270-298` | MIME sniffing off | never | `✗ Missing (0/10)` | **(a)** |
| Referrer-Policy | `:303-336` | a strict policy is set | never — the header is honoured over http | `✗ Missing (0/10)` | **(a)** |
| Permissions-Policy | `:341-388` | 4 named features restricted | over `http://`, all four are already unavailable | `✗ Missing (0/9)` + *"Restrict more features"* | **(c), weak** |
| X-XSS-Protection | `:393-421` | a deprecated header is set | never | `✗ Missing (0/5)` | **(a)** |

Total denominator: 20+25+15+10+10+9+5 = **94** (`:69-70`).

**Normative grounding.** RFC 6797 is the only source in this set with MUST-level language, and it
runs both ways:

- §7.2: *"An HSTS Host MUST NOT include the STS header field in HTTP responses conveyed over
  non-secure transport."*
- §8.1: *"If an HTTP response is received over insecure transport, the UA MUST ignore any present STS
  header field(s)."*
  — https://www.rfc-editor.org/rfc/rfc6797

So on a plain-`http://` URL our report demands a header the site is **forbidden to send** and that
every browser is **required to ignore**, and prices the refusal at 20 points and a `🔴 CRITICAL`. The
implementation guide already knows this — `security-tools.ts:65` prints *"Add HSTS (requires HTTPS)"* —
so the fact is in the file, just not in the arithmetic. **This is the single clearest confirmation of
#337's `security-analyzer` candidate.**

The rest of the candidate is **refuted by its own sources**:

- **CSP.** CSP3 states no secure-transport precondition, and matches insecure schemes to secure ones
  deliberately: *"the source expression `http://example.com:80` will match both
  `http://example.com:80` and `https://example.com:443`"* — https://www.w3.org/TR/CSP3/. Only two
  directives are transport-bound, and we score neither: `block-all-mixed-content` (deprecated;
  *"Prevents loading any assets using HTTP when the page is loaded using HTTPS"*) and
  `upgrade-insecure-requests`, which *works* on an http document but *"does not replace the
  Strict-Transport-Security (HSTS) header"* —
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/upgrade-insecure-requests.
  Our five awards (`:201-207`) test `default-src`, `script-src`, `object-src 'none'`, `base-uri` —
  all fully enforced over http. **(a).**
- **X-Frame-Options.** No transport precondition; MDN's only caveat is the obsolete `ALLOW-FROM`
  value, which we do not accept anyway (`:250` accepts only DENY/SAMEORIGIN at full marks) —
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options. **(a).**
- **Referrer-Policy.** No transport precondition. The *default* policy's protective half
  (*"Don't send the `Referer` header to less secure destinations (HTTPS→HTTP)"*) cannot fire from an
  http origin, but our check only asks whether a strict value is set (`:318-323`), which is fully
  answerable — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy. **(a).**
- **Permissions-Policy** is the one genuine partial. MDN states no HTTPS requirement for the header,
  but the four features we score — `geolocation`, `camera`, `microphone`, `payment` (`:357-362`) — are
  all on MDN's secure-contexts list, so on an insecure origin the browser already refuses them and
  restricting them adds nothing —
  https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts/features_restricted_to_secure_contexts.
  The header itself still does real work over http for features *not* on that list (`fullscreen`,
  `autoplay`), which we do not check. Classified **(c) weak**: the question is answerable, the
  finding is moot.
- **Cookies are out of scope entirely.** `SecurityHeaders` (`:10-18`) has no `Set-Cookie` field and
  nothing in the module reads one, so the issue's cookie `Secure`/`SameSite` candidate is **moot**.
  For the record, both would have qualified: *"Insecure sites (`http:`) cannot set cookies with the
  `Secure` attribute"*, and `SameSite=None` *"…the `Secure` attribute must also be set when using this
  value"* — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie. If cookie auditing
  is ever added, these two are `na`-by-definition over http.

### 6.2 `eeat-analyzer.ts` — 16 indicators

The decisive fact: **this module knows nothing about page type.** `analyzeEeat` (`:71-145`) passes
only `$`, the text bundle and `isHttps` into the four category functions. It does not import
`page-identity`, while `geo-analyzer` does (`:118`) and uses `isUnauthoredPage`/`isUndatedPage` to
mark the *same signals* `na` (`:592-594`, `:614-616`, `:379-380`, `:836`, `:873`). The concept the
issue asks for already exists in this repo, one file away, and is not called here.

| Indicator | Lines | What it asserts | Unanswerable when… | Prints today | Class |
|---|---|---|---|---|---|
| First-person narrative (5) | `:212-220` | author narrates from experience | page type has no narrator (product spec, legal, category, pricing) | `✗ No first-person perspective detected`, 0/5 | **(c)** |
| Case studies / examples (7) | `:231-241` | page shows worked examples | page type has nothing to exemplify | `✗`/partial. **3 free points from any `<ol>` in the document** — `$("ol")` at `:229` reads the whole DOM, not `readable`, so a nav list scores | **(b)+(c)** |
| Before/after evidence (5) | `:252-258` | a transformation is shown | page type has no before/after | 3 or 5 points for any two of `before, after, result(s), outcome, antes, después, resultado(s)` (`:244-247`) appearing anywhere in the copy | **(b)+(c)** |
| Specific details / statistics (8) | `:270-276` | claims are quantified | contact, legal, about pages have no statistics | partial credit; `hasDates` awards 2 for any bare `19xx`/`20xx` (`:267`) — a copyright year in copy | **(b)+(c)** |
| **Author bio / credentials (10)** | `:305-315` | the content has a credited author | **the page type has no author** | `✗ No author information detected`, 0/10 — the largest single indicator in the module | **(b)+(c)** |
| Professional certifications (5) | `:325-333` | the author holds credentials | no author; or the field has no certifications | `✗ No certifications mentioned`, 0/5 | **(c)** |
| Detailed technical content (6) | `:343-349` | depth via length + code + diagrams | a landing/contact page cannot be 1500 words | partial; 1 point for `$("img").length > 5` (`:340`) — nav logos and icons | **(b)+(c)** |
| Industry terminology (4) | `:355-363` | vocabulary signals expertise | short pages; and Spanish morphology yields 12+-letter words far more often than English (`:352`) | `✗ Limited technical vocabulary`, 0/4 | **(c)** |
| Citations / references (10) | `:388-394` | claims are sourced | page type has nothing to cite | 5 points for `externalLinks > 5` where `externalLinks = $('a[href^="http"]').length` (`:386`) — footer social icons qualify | **(b)+(c)** |
| **Author published elsewhere (8)** | `:412-422` | the author has an off-site footprint | **there is no author** | 5 points for any `linkedin`/`twitter`/`github` anchor (`:407-410`) — a site-wide footer scores "author published elsewhere" on an authorless page; otherwise `✗`, 0/8 | **(b)+(c)** |
| Social proof / testimonials (7) | `:435-441` | third parties vouch | a doc page, a blog post, a legal page | `[class*="review"]` (`:427`) matches any class containing "review"; otherwise `✗` | **(b)+(c)** |
| HTTPS encryption (5) | `:462-468` | transport is secure | never — read from the URL (`:80`) | `✓`/`✗` correctly | **(a)** |
| Privacy policy (5) | `:473-479` | the **site** has one | the site has one but this page does not link it | `✗ No privacy policy link`, 0/5 — a site-level fact judged from one page | **(c)** |
| About page (5) | `:485-491` | the **site** has one | same | `✗ No about page link`, 0/5 | **(c)** |
| Contact information (5) | `:502-510` | the **site** publishes contact | same | `✗ No contact information found`, 0/5 | **(c)** |
| **Last updated date (5)** | `:524-534` | content freshness is disclosed | **the page type is legitimately undated** | 3 points for the bare word `published`/`updated`/`publicado` anywhere in `text.all` including chrome (`:519-522`); otherwise `✗ No update date visible` | **(b)+(c)** |

The four site-level indicators (privacy, about, contact, last-updated) are a variant worth naming
separately from #337's framing: they are not *inapplicable*, they are **answered at the wrong scope** —
a fact about the site, decided from whatever one page happens to link. The failure mode is the same
(a confident answer to a question that was not asked), which is why they belong in this audit.

Two adjacent observations, VERIFIED but outside the class:

- The renderer's icon is `indicator.found`, not `earned` (`eeat-tools.ts:47,57,67,77`). "Before/after
  evidence" sets `found` at ≥2 keywords but `earned = 3` at 1 (`:251,254`), so a page can print
  `✗ Before/after evidence (3/5 pts)` — a red cross above a majority score.
- `hasAuthorSchema` (`:290-299`) returns true for `json["@type"] === "Person"` **or** any `json.author`
  on any top-level JSON-LD node, so a `Person` node describing a testimonial's author awards the full
  10 points for "Author bio / credentials".

**Normative grounding for the author candidate.** Google's own wording makes the byline expectation
*conditional*, not universal — the self-assessment asks **"Do pages carry a byline, where one might be
expected?"** — https://developers.google.com/search/docs/fundamentals/creating-helpful-content. The
`Article` type is scoped to *"your news, blog, and sports article pages"* and states **"There are no
required properties; instead, add the properties that apply to your content"**, with `author` listed
under *Recommended* — https://developers.google.com/search/docs/appearance/structured-data/article.
And Google says of the framework itself: **"While E-E-A-T itself isn't a specific ranking factor, using
a mix of factors that can identify content with good E-E-A-T is useful"**, plus *"Rater data is not
used directly in our ranking algorithms"* (same helpful-content page). No Google page states that a
product, category, home, legal or tool page should carry an author.

Our own conformance record says the same in its own terms: `docs/google-search-central-conformance.md:9-12`
(*"If Google does not say it, we do not report it as a problem… If it is our own judgement, we label
it as our own judgement"*), `:538-540` (the E-E-A-T score is our model and must carry Google's
"isn't a specific ranking factor" sentence), and `:138-154` (§1.7) — which is the precedent that
matters here: **blanket "Missing X schema" checks were already retired in favour of deriving
expectations from page identity, with each exemption explained.** `eeat-analyzer`'s author indicators
are the same blanket check, unretired. The header note at `eeat-tools.ts:30-33` hedges the score's
meaning but not any individual indicator's applicability.

### 6.3 `ai-visibility-analyzer.ts` — 17 scored checks + 4 unscored signals

Two failure families here. The first is the one #337 predicts (page type / absent schema). The second
is worse and the issue does not mention it: **three checks are fed by external lookups whose failure
is collapsed into `false`**, so "the lookup did not run" and "the answer is no" print identically.

**L1 — entity (`scoreL1`, `:252-383`)**

| Check | Lines | What it asserts | Unanswerable when… | Prints today | Class |
|---|---|---|---|---|---|
| Organization schema with name + url (7) | `:267-276` | the site is a resolvable org | a personal site/portfolio has `Person`, not `Organization`; an inner article page rarely repeats org markup | `✗ No Organization/LocalBusiness schema found`, 0/7 | **(c)** |
| Organization `sameAs` ≥2 identity URLs (7) | `:286-293` | identity is cross-linked | read off `orgSchema` (`:279`), so **absent Organization ⇒ automatic fail** — one absence charged twice | `✗ No sameAs in Organization schema`, 0/7 | **(c)** |
| Listed in *vertical* directories (7) | `:300-307` | the brand is listed on G2/Clutch/Yelp… | **always** — the evidence is only *outbound links from this page* (`:173-176`, `extractOutboundLinks` capped at the first 80KB, `:122-130`). A site listed on G2 that does not link to G2 fails. | `✗ No links to g2.com, capterra.com… found`, 0/7 | **(c)** — the name asserts listing; the method measures linking |
| Wikidata entity (6) | `:310-317` | a Wikidata item exists | **the API call failed** — `lookupWikidata` returns `{found:false}` on `!res.ok` and on throw (`lib/tools/shared/wikidata-check.ts:30,41-43`), and `Promise.allSettled` maps a rejection to `false` (`ai-visibility-tools.ts:212`). Also `language: "en"` (`wikidata-check.ts:19`), so a Spanish-only item is invisible; and the query is the **hostname's first label** (`ai-visibility-tools.ts:178-180`), not `Organization.name` | `✗ No Wikidata entry — submit at wikidata.org/…`, 0/6 | **(c)** |
| Entity name consistency (6) | `:319-342` | one canonical brand name | **zero sources** (no `og:site_name`, no `Organization.name`) — the detail literally says *"Could not compare"* (`:326`) and `nameConsistent` stays `false` (`:325`) → 0/6. **One source** → `nameConsistent = true` (`:334`) → **full 6 points for a comparison that was not made** | either *"Could not compare — add og:site_name and Organization.name"* at 0/6, or *"only one source found"* at 6/6 | **(b)+(c)** — both halves in one check |
| llms.txt (0) | `:353-360` | informational only | n/a — cannot fail, `passed: true`, `points: 0` | acknowledged and priced at zero | **(a)** — and the model for how to retire a check honestly |
| Google Knowledge Graph (5, conditional) | `:363-372` | a KG entity exists | **the API call failed** — `checkKnowledgeGraph` returns `false` on `!res.ok` and on throw (`ai-visibility-tools.ts:71,74-76`). Omitted entirely without a key (`:363`), which is the *correct* handling — by omission | `✗ Not found in Google Knowledge Graph`, 0/5 | **(c)** |

The KG check is worth calling out as the module's own best precedent: `:378-381` explains that a fixed
maximum *"charged every site for a check it was never given"*, and the fix was to **not push the check
at all**. That is a working "did not run" convention, already in this file, that reaches only the
API-key case and not the API-failure case.

**L4 — retrievability (`scoreL4`, `:461-636`)**

| Check | Lines | What it asserts | Unanswerable when… | Prints today | Class |
|---|---|---|---|---|---|
| Key answer/data in first 30% (10) | `:487-494` | the page front-loads an answer | the patterns are **English-only** — `is a/an/the`, `refers to`, `means`, `defined as`, `helps you\|businesses\|teams` (`:480`). A correct Spanish page can only pass via the statistic half | `✗ No definition or data point in first 30%`, 0/10 | **(c)** |
| Content length 800–1500 (8) | `:505-515` | length sits where grounding coverage peaked | a homepage/pricing/contact page is short by design | the detail is carefully hedged (`:510-514`) and the 8 points are still lost | **(c)** |
| Definition patterns (6) | `:519-528` | definitional phrasing present | English-only (same regex); and a transactional page defines nothing | `✗ No definition patterns`, 0/6 | **(c)** |
| 2+ question H2/H3 (6) | `:533-538` | Q&A structure | a product page has no questions; and the regex `<h[2-3][^>]*>[^<]*\?[^<]*</h[2-3]>` (`:531`) cannot match a heading containing any nested tag | `0 question headings found — add headings like…`, 0/6 | **(c)** |
| Data density ≥3/1k words (6) | `:544-549` | claims are quantified | page type has no statistics | `✗`, 0/6 | **(c)** |
| Visible Q&A pattern (3) | `:559-570` | `details`/`dl`/FAQPage present | a contact page has no Q&A | `✗ No Q&A pattern detected`, 0/3 | **(c)** |
| Named-entity density (3) | `:577-584` | text names specific entities | `entityDensity` (`:139-151`) tests `/^[A-Z][a-zA-Z]/` — **ASCII-only**, so `Ángel`, `México`, `Öhlins` do not count, and sentence splitting on `[.!?]` breaks on abbreviations | `✗ … named-entity density`, 0/3 | **(c)** |
| Core content in static HTML (3) | `:593-600` | server HTML carries the content | never | `✓`/`✗` correctly | **(a)** |
| **AI crawlers allowed (8)** | `:609-614` | GPTBot et al. are not blocked | **either way** — see the state table in §8.2. Unreachable: `aiBotsPassed = aiBotAccess.status === "ok"` (`:603`) and `"unknown"` is not `"ok"`. Vacuously true: a **5xx with a body** returns `"ok"` | `✗ "robots.txt not accessible"` (`:604-605`) at **0/8** for our own timeout, or **8/8 "all allowed"** for a 500 | **(b)+(c)** — the only check in the module that both announces it did not run and charges for it, *and* passes on no evidence |
| **Content freshness (5)** | `:626-633` | the page discloses a recent update | **the page type is legitimately undated** — `checkContentFreshness` returns `"unknown"` (`:241`) and `freshnessPoints = 0` (`:617`) | `✗ No dateModified found — add dateModified to your JSON-LD…`, 0/5 | **(c)** |

The freshness check is the sharpest confirmation of #337's premise. It is **the same signal** that
`geo-analyzer` marks `na` for undated page kinds at `:377-380`, `:836` and `:873` — with a comment at
`:831-834` explaining that leaving one of the three ungated meant *"a homepage was N/A for both of the
others and then lost 7 points for the third."* #288's original complaint was that `geo_score` and
`ai_visibility_score` contradict each other on the same homepage. **The fix landed in one of the two
contradicting modules.** The other still docks a homepage for not being an article.

**L2 — brand depth (`analyzeL2`, `:396-459`): 4 signals, unscored.** No `points`, so no arithmetic
harm. They do drive the summary line (`:452-456`) and one recommendation (`:696-699`).

| Signal | Lines | Unanswerable when… | Prints today | Class |
|---|---|---|---|---|
| Person schema with `sameAs` | `:406-412` | the page has no author | *"No Person schema with sameAs — add author profiles…"* | (c), narrative only |
| Press/newsroom page exists | `:417-422` | a solo consultant or a small site has no press to aggregate | *"create /press or /newsroom"*, and this is the one L2 signal that emits a top action (`:697-698`) | (c), narrative only |
| 2+ authoritative outbound links | `:433-439` | a transactional page cites nothing | *"cite credible sources (.edu, .gov, major press)"* | (c), narrative only |
| About or team page | `:444-450` | the site has one, this page does not link it | *"create one with brand narrative…"* — wrong scope, as in §6.2 | (c), narrative only |

**Normative grounding for the schema-presupposition candidate.** Structured data is optional and its
absence is never a penalty: *"Using structured data **enables** a feature to be present, it does not
**guarantee** that it will be present"*, and *"A structured data manual action means that a page loses
eligibility for appearance as a rich result; it doesn't affect how the page ranks in Google web
search"* — https://developers.google.com/search/docs/appearance/structured-data/sd-policies.
Consequences attach only to markup that is wrong, never to markup that is missing. Vocabulary-wise
the types we key on are all live at schema.org — `Organization`
(https://schema.org/Organization), `Person` (https://schema.org/Person), `Article`
(https://schema.org/Article), `FAQPage` (https://schema.org/FAQPage). Deprecation is Google-side
only, and the Q&A check's own comment (`:551-554`) already reflects that correctly.

One thing #337 does **not** claim but this audit turned up, recorded for whoever picks it up: the
top-action branch at `:682` is dead. It fires on `c.name.includes("800–1500") && c.detail.includes("below")`,
and the detail strings at `:510-514` contain no *"below"* — the short-page string reads *"…words.
Grounding coverage was measured at roughly 50%…"*. **VERIFIED** by reading both. So the
expand-your-page action can never be emitted.

---

## 7. What `tests/lib/analyzers/scored-checks.test.ts` covers

**CONFIRMED**, the issue is right. 134 lines, three describes on the primitives plus one on
`security-analyzer`:

| Test | Line | Asserts |
|---|---|---|
| gives a passing all-or-nothing check its full points | `:6-8` | `earnedBy({passed:true, points:7}) === 7` |
| gives a failing one nothing | `:10-12` | `=== 0` |
| prefers an explicit partial award over pass or fail | `:14-17` | `earned` wins over `passed`, both directions |
| **credits an inapplicable check in full** | `:24-26` | `earnedBy({passed:false, points:5, na:true}) === 5` — with a doc comment at `:19-23` restating that *"callers subtract it from both sides of the fraction"* |
| takes the maximum from the same list as the score | `:36-44` | the `MAX = 40` regression |
| cannot report a score above its own maximum | `:46-53` | `score <= max` |
| counts partial credit in the score and the full award in the maximum | `:55-57` | `{score:4, max:10}` |
| is zero for no checks | `:59-61` | `tally([]) === {0,0}` |
| **reports their points so a caller can take them off both sides** | `:65-78` | performs the subtraction **itself, in the test body** (`:76-77`) — it proves the arithmetic works, not that anybody does it |
| every security check has one maximum (3 cases) | `:93-133` | present/absent ceilings agree; PERFECT reaches every ceiling; ABSENT scores 0 everywhere |

So the two `na` tests are the ones that most look like enforcement and are the furthest from it: `:24-26`
pins the behaviour that makes forgetting silent, and `:65-78` demonstrates the remedy in test code that
no production caller is required to mirror. The security block (`:93-133`) is the only test in the file
that touches a caller, and it asserts ceilings, not normalization. Elsewhere,
`geo-analyzer.test.ts:82-86,213,272,302-337,353,388-448,465,480,528,602-618` covers `geo`'s `na`
behaviour thoroughly — the *one* caller that already normalizes. Nothing covers the three that do not.

---

## 8. Open questions the code could not settle

1. **Is the all-`na` GEO state reachable?** §5.2 shows it grades "Low". I did not construct a
   `PageKind` + HTML pair that makes every check on all ten categories `na`, and several categories
   contain no gated check at all (`geo-analyzer.ts:462-511`, `:514-556`, `:661-693`). **UNSETTLED.**
2. ~~**Does a 404 `robots.txt` reach the `"unknown"` branch?**~~ **SETTLED** by a follow-up trace, and
   the answer is worse than the question assumed. `checkAiBotAccess` (`ai-visibility-tools.ts:105-117`)
   has three outcomes and cannot distinguish "this site has no robots.txt", which is a definite *all
   allowed*, from "our fetch failed", which is *we did not look*:

   | Input | Returns | Report prints | Correct? |
   |---|---|---|---|
   | 200, no AI blocks | `ok` | pass 8/8 | yes |
   | 200, blocks GPTBot | `blocked` | fail 0/8, names the bots | yes |
   | 404 with an HTML error body | `ok` | pass 8/8 | right answer, wrong reason |
   | 404 or 5xx with an **empty** body | `unknown` | fail 0/8, *"not accessible"* | **no** — a 404 means all allowed |
   | **500 with a body** | **`ok`** | **pass 8/8 "all allowed"** | **no** — nothing was evaluated |
   | timeout / DNS / refused / SSRF | `unknown` | fail 0/8 | **no** — charges the site for our failure |

   The status code *is* carried faithfully (`fetchPage:54`), but `:109` tests only `status === 0` and
   never the range; the error *kind* is destroyed at `:55-56`, where every throw collapses to
   `status: 0`. Upstream the information exists and is discarded — `fetchWithTimeout` already throws
   `PageFetchError.fromResponse(status)` versus `PageFetchError.timeout(ms)`
   (`lib/utils/http-client.ts:73,81`), the same shape as the `finalUrl` loss in §6.1.
   `parseRobots` compounds it: it always returns `exists: true` (`lib/analyzers/robots-ruleset.ts:313`),
   so an HTML error page parses to zero rules and therefore "everything allowed"
   (`robots-ruleset.ts:143-144`), and `checkAiBotAccess` never reads `.exists`. **No test anywhere
   exercises this** — `tests/lib/analyzers/ai-visibility-analyzer.test.ts` only passes literal
   `BOTS_OK` fixtures.

   **The repo already has the convention this note was going to have to invent.**
   `isCrawlAllowed` (`lib/analyzers/crawlability-analyzer.ts:301-333`) returns `boolean | null` and
   splits the cases at `:330` — `/HTTP 40[34]\b/.test(message) ? true : null` — under a doc comment
   that states the whole of #337 in two sentences: *"an unreachable robots.txt means we do not know,
   and reporting 'not blocked' from ignorance is how a tool tells a confident lie."* Second-best
   precedent is the `{ok,status,reason}` union of `lib/utils/page-reachability.ts:36-50`, which
   `ai-visibility-tools.ts:33` **already imports** and does not use for this. `robots-analyzer.ts:87-92`
   also gets it right by rethrowing non-404s, and is the one path with a test
   (`tests/lib/tools/robots-tools.test.ts:123-135`).
3. **Would scheme-awareness in `security-analyzer` require changing `fetchHeaders`?** `safeFetch`
   computes `finalUrl` (`ssrf-guard.ts:236,292`) and `fetchHeaders` drops it
   (`http-client.ts:137`). Whether to thread it through, or to have `analyzeSecurityHeaders` pass the
   requested URL's scheme and accept that a http→https redirect makes it wrong, is a design decision
   this note does not take.
4. **What should a reader see?** #337 asks for one convention. The repo currently has four: `➖ n/a` +
   a sentence (`crawler-tools.ts:30-33`), a `–` icon + `N/A for {pageType} pages` (`geo-tools.ts:229`,
   `geo-analyzer.ts:127`), a zero-point check that always passes (`ai-visibility-analyzer.ts:353-360`,
   the llms.txt retirement), and omitting the check entirely (`:363`, the KG key gate). The last two
   are both defensible and mutually exclusive; picking between them is a product call.
5. **Is `docs/google-search-central-conformance.md` the right home for the authorship exemptions?**
   §1.7 (`:138-154`) already records that blanket "Missing X schema" checks were retired in favour of
   page-identity-derived expectations. Whether `eeat`'s author indicators belong under that section or
   a new one is an editorial decision, not a code fact.
6. **Not audited here:** whether `seo_schema_generator` / `seo_schema_detection` still emit or reward
   `FAQPage`/`HowTo`. Google removed FAQ rich results on **2026-05-07** and retired the HowTo docs in
   Sept 2023 (*"Removed the How-to structured data documentation, as this rich result is no longer
   shown in search results"*,
   https://developers.google.com/search/docs/appearance/structured-data/how-to), and neither appears in
   the current search gallery
   (https://developers.google.com/search/docs/appearance/structured-data/search-gallery). Out of scope
   for #337, flagged because it surfaced while grounding §6.3.

### 8.1 Two constraints that turned out not to exist

Both were checked because a scoring change would normally have to respect them. Neither binds.

- **No migration or backfill is needed.** Analyzer sections are written as whole objects to two places
  and compared across runs by nobody. `tool_cache` is a cache: one row per `(user_id, cache_key)`
  (`lib/server/schema.ts:292-310`, unique at `:306`), `structured_json` overwritten on conflict
  (`lib/mcp/tool-cache.ts:194`) under a per-tool TTL (`:165-166`). `site_refreshes.context_json` is one
  row per run (`schema.ts:98-115`), but the retention sweep keeps only the latest completed per site
  plus whatever backs a live shared report (`lib/server/sites.ts:534-548`), so there is no durable
  series. A per-run score series *does* exist (`lib/server/refreshes.ts:62-95`, exposed at
  `app/api/sites/[id]/refreshes/route.ts:14`) and **no UI consumes it**
  — *[update, #380: it no longer exists. Because nothing consumed it, both the route and*
  *`lib/server/refreshes.ts` were deleted. A scores-over-time series is now a feature to*
  *build, not an unused endpoint to wire up.]* — ; alerts compare against
  absolute thresholds, never a prior run (`lib/server/alerts.ts:144-183`). The one genuinely frozen
  surface is `shared_reports.snapshot_json`, a deliberate point-in-time copy with `expires_at` nullable
  (`schema.ts:280-285`) — already-published reports keep the old arithmetic **by design**, and are not
  a backfill target.
- **Analyzer output is not internationalized, anywhere.** No `getTranslations`/`useTranslations` under
  `lib/analyzers/**`, `lib/tools/**` or `components/report/**` (grep, zero matches); `GeoSection.tsx:86,95`
  prints the stored `name`/`detail`/`recommendations` verbatim. `messages/{en,es}.json` carry marketing
  namespaces only — no `report`, `geo`, `eeat`, `security`, `aiVisibility`, `na` or `pageType` keys. So a
  new "not evaluated" reason string is an English literal in the analyzer and needs no key in either
  file. **No doc states this policy**, which is why an AFK agent could reasonably "fix" the
  inconsistency by adding `next-intl` to the analyzers.

### 8.2 Where the decisions went

This note deliberately decides nothing. The open questions above were settled in a design session on
**2026-08-17**; the outcomes live in #337 and in the five spin-off issues it links, and the vocabulary
lands in `docs/domain/analyzer-and-testing-architecture.md`. Read those for what we chose; read this
for what is true.

---

## Sources

Repository, read 2026-08-17 at `7d245a2`: `lib/analyzers/scored-checks.ts`,
`lib/analyzers/geo-analyzer.ts`, `lib/analyzers/ai-visibility-analyzer.ts`,
`lib/analyzers/eeat-analyzer.ts`, `lib/analyzers/security-analyzer.ts`,
`lib/analyzers/page-identity.ts`, `lib/analyzers/crawlability-analyzer.ts`,
`lib/analyzers/robots-ruleset.ts`, `lib/analyzers/robots-analyzer.ts`, `lib/tools/crawler-tools.ts`,
`lib/tools/geo-tools.ts`, `lib/tools/eeat-tools.ts`, `lib/tools/security-tools.ts`,
`lib/tools/ai-visibility-tools.ts`, `lib/tools/shared/wikidata-check.ts`, `lib/utils/http-client.ts`,
`lib/utils/ssrf-guard.ts`, `lib/utils/page-reachability.ts`, `lib/crawlers/site-crawler.ts`,
`lib/google/index-coverage.ts`, `lib/mcp/with-cache.ts`, `lib/mcp/tool-cache.ts`,
`lib/server/schema.ts`, `lib/server/sites.ts`, `lib/server/refreshes.ts`, `lib/server/alerts.ts`,
`lib/server/site-refresh-runner.ts`, `tests/lib/analyzers/scored-checks.test.ts`,
`tests/lib/analyzers/geo-analyzer.test.ts`, `tests/lib/analyzers/google-conformance.test.ts`,
`tests/lib/analyzers/ai-visibility-analyzer.test.ts`, `tests/lib/tools/robots-tools.test.ts`,
`docs/site-crawler.md`, `docs/google-search-central-conformance.md`, `docs/database.md`,
`docs/domain/geo-sub-signals.md`, `components/report/sections/GeoSection.tsx`.
Commit `5da93ca` (the #304 fix). Issues #337, #288 read via `gh issue view`; #304 was unavailable
(GitHub GraphQL 503 on two attempts) and is cited only through `5da93ca`'s message and
`docs/site-crawler.md`.

External, all read 2026-08-17:

- RFC 6797, HTTP Strict Transport Security — https://www.rfc-editor.org/rfc/rfc6797
- W3C Content Security Policy Level 3 — https://www.w3.org/TR/CSP3/
- MDN `Content-Security-Policy` — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy
- MDN `upgrade-insecure-requests` — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/upgrade-insecure-requests
- MDN `X-Frame-Options` — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options
- MDN `Referrer-Policy` — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy
- MDN `Permissions-Policy` — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Permissions-Policy
- MDN Features restricted to secure contexts — https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts/features_restricted_to_secure_contexts
- MDN `Set-Cookie` — https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Set-Cookie
- Google Search Central, Creating helpful, reliable, people-first content — https://developers.google.com/search/docs/fundamentals/creating-helpful-content
- Google Search Central, Article structured data — https://developers.google.com/search/docs/appearance/structured-data/article
- Google Search Central, Structured data general guidelines — https://developers.google.com/search/docs/appearance/structured-data/sd-policies
- Google Search Central, Search gallery — https://developers.google.com/search/docs/appearance/structured-data/search-gallery
- Google Search Central, How-to (documentation removal changelog) — https://developers.google.com/search/docs/appearance/structured-data/how-to
- schema.org: https://schema.org/Organization · https://schema.org/Person · https://schema.org/Article · https://schema.org/FAQPage · https://schema.org/HowTo · https://schema.org/BreadcrumbList
