# UI Auditor: Requirements Design

## 1. Product summary

UI Auditor takes **one URL**, explores the site the way three experts would, and produces a single report of what is broken, what is confusing, and what to build instead.

| Persona | What it looks for |
|---|---|
| **UX Designer** | Visual hierarchy, consistency, readability, clarity of calls to action, Nielsen heuristics, mobile layout, empty/error states |
| **Senior Software Engineer** | Console errors, failed network calls, slow pages (Core Web Vitals), semantic HTML, SEO basics, security headers, broken assets |
| **SDET** | Broken links, dead buttons, forms that don't validate, navigation dead ends, responsive breakage, repeatable test cases |
| **Domain Expert** (auto-detected) | Industry patterns the site is missing, e.g. for real estate: listing filters, map search, photo gallery, mortgage calculator, "contact agent" CTA |

For the top issues it also produces **"Good" and "Better" design alternatives**, rendered as real HTML mockups with screenshots beside the original.

## 2. Users and use cases

- A QA or UX person auditing a client or competitor site before a meeting.
- A dev team running it in CI against a staging URL on every PR.
- A designer wanting quick, evidence-backed redesign ideas.

## 3. How people use it

Three ways in, one shared audit engine:

1. **Web UI (primary)**: a local web app (`npm start`, opens `http://localhost:3000`). Paste a URL, set options, watch live progress per agent, browse past reports, approve issue exports.
2. **GitHub Action**: `workflow_dispatch` with a URL input (or on PR against a staging URL); uploads the report as a build artifact.
3. **Claude Code `/audit`**: `.claude/agents/` and `.claude/commands/audit.md` so the audit can be run interactively inside Claude Code.

There is no public CLI. A small internal script (`npm run audit -- <url>`) exists only so the GitHub Action and Claude Code can drive the engine headlessly.

### Inputs (same options in all three)

| Option | Default | Notes |
|---|---|---|
| URL | required | The site to audit |
| Depth / max pages | 2 / 15 | Same-origin only |
| Domain | auto | `real-estate`, `ecommerce`, `saas`, `healthcare`, `banking`, `travel`, `education`, `generic` |
| Viewports | desktop, tablet, mobile | |
| Competitor URLs | none | Up to 2, see section 7a |
| Login | off | See section 7b |
| Allow forms | off | Read-only unless turned on |

Safe defaults: read-only, same-origin crawl, respects robots.txt, rate limited.

## 4. Architecture: evidence first, judgement second

Deterministic tools collect hard evidence; Claude agents interpret it. **Every finding must cite evidence** (screenshot region, CSS selector, axe rule ID, console line, network request, metric). Findings without evidence are dropped. This is the main guard against made-up issues.

```
URL
 └─ 1. Crawler (Playwright)
      pages, nav map, screenshots x 3 viewports, DOM snapshots,
      console + network logs, link status, axe-core, Lighthouse
 └─ 2. Specialist agents (run in parallel on the evidence bundle)
      ├─ UX Designer agent        (vision on screenshots + DOM)
      ├─ Senior Engineer agent    (logs, metrics, HTML, headers)
      ├─ SDET agent               (links, forms, nav flows, generates Playwright tests)
      ├─ Accessibility agent      (axe results + WCAG 2.2 AA review)
      └─ Domain Expert agent      (detects industry, checks domain patterns)
 └─ 3. Design Recommender agent
      top 3-5 issues → "Good" fix and "Better" redesign as HTML/Tailwind → screenshot
 └─ 4. Reporter
      dedupe, score, rank → report.html + report.json + report.md + generated tests
```

## 5. Finding format (every issue)

| Field | Example |
|---|---|
| ID | `UIA-012` |
| Title | Primary "Search Homes" button invisible on mobile |
| Category | UX / Navigation / Functional / Accessibility / Performance / SEO / Security / Domain |
| Severity | Critical / High / Medium / Low |
| Found by | UX Designer, SDET, ... |
| Page + viewport | `/listings` @ mobile 375px |
| Evidence | Annotated screenshot crop, selector `button.search-cta`, rule or log line |
| Steps to reproduce | Numbered |
| Expected vs actual | One line each |
| Recommendation | Concrete fix |
| Design alternative | Link to Good/Better mockup (top issues only) |

## 6. Report

- **Executive summary**: overall score (0-100) and per-category scores, top 5 issues.
- **Navigation map**: visual site tree with dead ends and orphan pages highlighted.
- **Issues table**: filterable by severity, category, page, persona.
- **Design alternatives**: Original / Good / Better side by side.
- **Domain insights**: "What leading real-estate sites do that this one doesn't."
- **Comparison** (when competitor URLs are given): side-by-side scores and patterns worth copying.
- **Generated test suite**: Playwright specs for found defects (regression-ready).
- Outputs: `report.html` (self-contained), `report.json` (machine-readable), `report.md` (pasteable into GitHub issues/Jira).

## 7. Domain packs

Pluggable checklists in `domains/*.yaml`. Domain is detected from page content and can be overridden in the options.

| Pack | Example checks |
|---|---|
| real-estate | Price/beds/baths/area filters, map + list view, sort by price/newest, photo gallery, virtual tour, mortgage calculator, neighbourhood/school info, save/favourite, agent contact CTA above the fold, short enquiry form |
| ecommerce | Search + filters, product images/zoom, reviews, clear price and shipping, cart visibility, guest checkout, trust badges |
| saas | Clear value proposition, pricing page, free trial/demo CTA, feature comparison, docs link, social proof |
| healthcare | Find a doctor/location, appointment booking, emergency info visibility, insurance accepted, plain-language content, privacy notice |
| banking | Login prominence, security messaging, rates/fees transparency, branch/ATM locator, calculators, regulatory disclosures |
| travel | Date/destination search, flexible dates, price calendar, filters, total price incl. fees, cancellation policy, booking summary |
| education | Course search/catalogue, admissions steps, fees, application CTA, calendar/deadlines, contact/counselling |
| generic | Fallback heuristics only |

Adding a pack = adding one YAML file; documented in the README.

## 7a. Competitor comparison

- The user can add up to 2 competitor URLs.
- Each competitor is crawled with a lighter budget (home page + up to 5 key pages) and scored with the same categories and domain pack.
- The report gets a **Comparison** section: score table side by side, "what they do better" with screenshots, "where you win", and which competitor patterns are worth copying.
- Competitor findings are never exported as defects.

## 7b. Logged-in pages

- Optional login config: login URL, username/password field selectors (auto-detected if possible), success check (URL or element).
- Credentials come only from environment variables or GitHub secrets (`UIA_LOGIN_USER`, `UIA_LOGIN_PASSWORD`); the Web UI can pass them for a single run but never stores or logs them, and they never appear in reports or screenshots (password fields masked).
- After login, the session is saved as a Playwright storage state for the run only and deleted afterwards.
- Intended for test or staging accounts; the README says so. No MFA/CAPTCHA support in v1.
- Logout links are excluded from the crawl so the session survives.

## 7c. Issue export (Jira and GitHub)

- From the report in the Web UI, the user selects findings and clicks **Export**.
- A **preview step** shows exactly what will be created (title, description, severity/priority, labels, attached screenshots) and nothing is sent until the user confirms. Never automatic.
- Targets: **GitHub Issues** (token + repo) and **Jira** (base URL, email, API token, project key, issue type). Config via `.env`.
- Duplicate guard: each finding carries a stable fingerprint; already-exported findings are marked and skipped on re-export.
- The GitHub Action and `/audit` never export; they only produce the report and the Markdown.

## 8. Tech stack

- TypeScript (Node 22.19+), Playwright, axe-core, Lighthouse
- Anthropic SDK (Claude) with vision; model configurable via env, structured JSON output validated with zod
- Web UI: small Node server (Fastify or Express) + a lightweight frontend (Vite + React), live progress over server-sent events; past runs stored as folders under `reports/`
- HTML report: single self-contained file that also opens without the server
- Vitest for unit tests, Playwright for end-to-end tests of the Web UI; a local **fixture site with seeded defects** (including a login-protected page) to prove detection works

## 9. GitHub readiness

- README with GIF/screenshot, quick start, sample report
- MIT LICENSE, CONTRIBUTING.md, SECURITY.md (how credentials and tokens are handled), `.env.example`, `.gitignore`
- GitHub Actions: lint + typecheck + test on PR; reusable `ui-audit.yml` workflow (`workflow_dispatch` with URL input) that uploads the report as an artifact
- `.claude/agents/` definitions and an `/audit` command so it can also be run interactively inside Claude Code

## 10. Non-goals (v1)

- No public CLI (internal script only)
- No MFA/CAPTCHA login, no SSO
- No penetration/security testing beyond passive header checks
- No crawling across domains (competitors are separate, limited crawls); no hosted multi-user SaaS
- No automatic issue creation without user confirmation

## 11. Acceptance criteria

1. From the Web UI, auditing a 15-page site finishes in under 10 minutes, shows live progress, and writes `report.html`, `report.json` and `report.md`.
2. On the fixture site, at least 90% of the seeded defects are detected; zero findings lack evidence.
3. Every finding has severity, evidence, repro steps and a recommendation.
4. At least 3 Good/Better design alternatives are rendered with screenshots.
5. Domain is auto-detected correctly for the real-estate fixture and the domain section is populated; all 8 domain packs load and validate.
6. With a login config, the login-protected fixture page is audited; credentials appear nowhere in reports, logs or screenshots.
7. With a competitor URL, the Comparison section is populated with side-by-side scores.
8. Issue export shows a preview and sends nothing until confirmed; re-exporting skips already-exported findings (verified against mocked Jira and GitHub APIs).
9. The GitHub Action produces the report artifact; `/audit` runs inside Claude Code.
10. CI passes on a fresh clone with `npm ci && npm test`.
