I'm building an open-source tool called **UI Auditor** for QA engineers, UX designers and dev teams. They need to paste one URL and get back an evidence-backed audit of the site, written from the point of view of a UX designer, a senior software engineer, an SDET, and a domain expert, plus concrete "Good" and "Better" redesigns for the worst problems. It will be published on GitHub, so it must work from a fresh clone. The full requirements are in `REQUIREMENTS.md` in this folder; read it first and treat it as the spec. With that in mind: build the complete project in this folder.

## What to build

TypeScript (Node 20+). One shared audit engine with three ways in:

1. **Web UI (primary)**: `npm start` serves a local app on `http://localhost:3000` (Fastify or Express backend, Vite + React frontend). Paste a URL, set options (depth, max pages, domain, viewports, up to 2 competitor URLs, optional login, allow forms), watch live per-agent progress via server-sent events, browse past runs from `reports/`, open reports, and export selected findings.
2. **GitHub Action**: `.github/workflows/ui-audit.yml` with `workflow_dispatch` inputs (url, optional competitor URLs); login credentials from repo secrets; uploads the report folder as an artifact. Never exports issues.
3. **Claude Code**: `.claude/agents/` (one Markdown definition per specialist agent) and `.claude/commands/audit.md`. Never exports issues.

No public CLI. Add only an internal `npm run audit -- <url> [options]` script so the Action and `/audit` can drive the engine headlessly.

### Engine pipeline (evidence first, judgement second)

1. **Crawler** (Playwright, deterministic, no LLM): same-origin crawl within depth/page limits, respect robots.txt, rate limit, skip logout links. Per page and viewport: full-page screenshot, DOM snapshot, console errors, failed network requests, link status codes, axe-core results, Lighthouse metrics (one desktop run per page). Build a navigation graph (dead ends, orphan pages, broken links). Read-only unless "allow forms" is on.
2. **Login (optional)**: login URL, field selectors (auto-detect if not given), success check. Credentials only from env vars / secrets (`UIA_LOGIN_USER`, `UIA_LOGIN_PASSWORD`) or passed for one Web UI run in memory. Save Playwright storage state for the run only, delete it afterwards. Mask password fields in screenshots. Credentials must never appear in logs, reports, JSON or screenshots.
3. **Specialist agents** (Anthropic SDK, in parallel on the evidence bundle, system prompts in `src/agents/prompts/`):
   - UX Designer: vision on screenshots + DOM; hierarchy, consistency, CTA clarity, readability, Nielsen heuristics, mobile layout.
   - Senior Engineer: console/network errors, Core Web Vitals, semantic HTML, SEO basics, security headers, broken assets.
   - SDET: links, buttons, forms, navigation flows, responsive breakage; generates Playwright regression specs for each functional defect.
   - Accessibility: axe results plus WCAG 2.2 AA review.
   - Domain Expert: detect the industry, load `domains/<name>.yaml`, report missing or weak domain patterns. Ship 8 packs: `real-estate`, `ecommerce`, `saas`, `healthcare`, `banking`, `travel`, `education`, `generic` (contents in REQUIREMENTS.md section 7). Validate packs with a zod schema.
4. **Competitor comparison (optional)**: crawl each competitor lightly (home + up to 5 key pages), score with the same categories and domain pack, and produce a Comparison section: side-by-side scores, what they do better (with screenshots), where the audited site wins, patterns worth copying. Competitor findings are never exportable.
5. **Design Recommender**: for the top 3-5 issues, produce a "Good" (minimal fix) and a "Better" (redesign) as standalone HTML + Tailwind CDN, render with Playwright, save screenshots next to a crop of the original.
6. **Reporter**: dedupe across agents, assign IDs (`UIA-001`) and a stable fingerprint, severity (Critical/High/Medium/Low), category, scores (overall + per category, 0-100). Write `report.html` (self-contained; opens without the server: executive summary, nav map, filterable issues table with annotated screenshot crops, Original/Good/Better comparisons, domain insights, comparison), `report.json`, `report.md`, and `tests/generated/*.spec.ts`.

### Issue export (Web UI only)

- User selects findings in the report view and clicks Export, choosing **GitHub Issues** or **Jira**.
- A preview shows exactly what will be created (title, description with repro steps/expected/actual/evidence, priority mapped from severity, labels, screenshot attachments). Nothing is sent until the user confirms.
- Config in `.env`: `GITHUB_TOKEN`, `GITHUB_REPO`; `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `JIRA_ISSUE_TYPE`.
- Record exported fingerprints per run; mark them in the UI and skip them on re-export.

### Hard rules

- Every finding must cite evidence (screenshot region, selector, axe rule ID, console line, request URL, or metric). Validate agent output with zod; drop findings without evidence and log how many were dropped.
- Finding fields: id, fingerprint, title, category, severity, foundBy, page, viewport, evidence, stepsToReproduce, expected, actual, recommendation, designAlternative (optional).
- Model from `UIA_MODEL` (default `claude-opus-5-5`), key from `ANTHROPIC_API_KEY`. All secrets go in `.env.example` as placeholders. Never commit or log secrets.
- Keep LLM cost sane: downscale/crop screenshots, cap pages, batch per page.

## GitHub readiness

- `README.md`: what it does, quick start, Web UI screenshot, sample report, options, login setup (test/staging accounts only), export setup, Action usage, `/audit` usage, Mermaid architecture diagram, how to add a domain pack.
- MIT `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md` (credential and token handling), `.gitignore` (includes `.env`, `reports/`, storage state), `.env.example`, `package.json` scripts (`start`, `dev`, `build`, `lint`, `typecheck`, `test`, `audit`).
- `.github/workflows/ci.yml` (lint, typecheck, unit + e2e tests on PR) and `ui-audit.yml` as above.
- `git init` and make one initial commit. Do not create a remote or push.

## How to verify (required before you call it done)

- Build a local **fixture site** under `fixtures/real-estate-site/` with at least 12 seeded, documented defects: broken link, dead button, missing alt text, low-contrast text, CTA hidden on mobile, console error, 404 image, form with no validation, nav dead end, missing price filter, oversized image, missing H1. Include a **login-protected page** (test credentials in the fixture's own config) with its own seeded defect. List all in `fixtures/real-estate-site/SEEDED_DEFECTS.md`. Add a small second fixture `fixtures/competitor-site/` that does several things better.
- Unit tests (Vitest): crawler parsing, evidence validation, dedupe, fingerprints, scoring, domain-pack schema (all 8 load), report generation, export payload building (mock Claude, Jira and GitHub).
- Integration tests: crawler against the fixture finds every deterministic defect in the evidence bundle; login reaches the protected page; a secret-leak check greps all outputs for the test password and fails if found; export preview sends nothing before confirm, and re-export skips exported findings (mocked APIs).
- Playwright e2e test of the Web UI: start audit, see progress, open report, open export preview.
- If `ANTHROPIC_API_KEY` is set, run a full audit against the fixture (with the competitor fixture) and confirm at least 90% of seeded defects appear in `report.json`, domain is real-estate, the Comparison section is populated, and at least 3 design alternatives are rendered. If not set, say so plainly and skip only that step.
- Use a fresh-context subagent to check the finished repo against every acceptance criterion in `REQUIREMENTS.md` section 11, and fix what it finds.

## How to work

- Delegate independent pieces (crawler + login, agents + domain packs, reporter + design recommender, Web UI + export, fixtures, CI/docs) to subagents and keep working while they run. Intervene if a subagent goes off track or is missing context.
- When you have enough information to act, act. If you are weighing a choice, make a recommendation and proceed rather than surveying options.
- Don't add features, refactor, or introduce abstractions beyond what the spec requires. Do the simplest thing that works well. Only validate at system boundaries (Web UI input, crawled pages, Claude responses, Jira/GitHub APIs).
- Never call real Jira or GitHub APIs during the build; use mocks.
- Pause for me only for a destructive or irreversible action, a real scope change, or input only I can provide (such as an API key). If you hit one, ask and end the turn rather than ending on a promise.
- Before reporting progress, audit each claim against a tool result from this session. If tests fail, say so with the output; if a step was skipped, say that.

## Final summary

Open with the outcome in one sentence. Then: how to run it (exact commands), test results with numbers, seeded-defect detection rate, anything not verified, and known limitations. Write complete sentences, no shorthand.
