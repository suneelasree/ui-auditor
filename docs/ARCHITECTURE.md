# Architecture

## Principle: evidence first, judgement second

Deterministic code collects hard evidence; Claude agents only interpret it. Every finding must cite at least one evidence item (`kind`: screenshot, selector, axe-rule, console, network, metric, link, domain-check) whose value can be matched against the crawl. Screenshot evidence must be a PNG under `evidence/` belonging to that page; Domain Expert domain-check evidence must name a check that actually failed in this run. `src/agents/evidence.ts` drops any finding whose evidence can't be matched and records how many were dropped per agent (`report.agents[].dropped`). This is the main guard against made-up issues.

## Pipeline

Orchestrated by `src/engine/runAudit.ts`:

1. **Crawl** (`src/crawler`): Playwright, same-origin, depth/page caps, robots.txt, rate limit. Optional login first (`src/crawler/login.ts`: waits for single-page-app sign-in forms, optional "after login, choose" steps, `evidence/login-failed.png` on failure); storage state lives in `<runDir>/.auth` and is deleted at the end. Per page and viewport: screenshots, DOM snapshot, console, failed requests, link checks, axe-core, hidden CTAs, overflow. Lighthouse runs on at most the first 5 pages, in a separate browser without the login session. Builds the nav graph. Output: `EvidenceBundle`.
2. **Rules** (`src/rules`) and **domain detection + checks** (`src/agents/domain.ts`, `domains/*.yaml`): deterministic findings.
3. **Specialist agents** (`src/agents`): UX Designer, Senior Engineer, SDET, Accessibility, Domain Expert run in parallel via the Anthropic SDK; output validated with zod, then evidence validation. They see viewport-sized above-the-fold screenshots and element crops, never full-page captures; images are not downscaled, and any over 8000px or 5 MB are skipped with a note. Skipped (with a note) if `ANTHROPIC_API_KEY` is unset or still the `your-...` placeholder.
4. **Dedupe and score** (`src/report/dedupe.ts`, `scoring.ts`, `fingerprint.ts`): merges duplicates across personas, assigns `UIA-###` IDs and stable fingerprints (page path plus query string; also the export dedupe key), computes overall and per-category scores.
5. **Competitors** (`src/competitor`, optional): quick crawl of up to 2 competitors (home + up to 5 pages, public, desktop only, rules and domain pack only). The target is re-crawled the same way so the Comparison section is like-for-like; the full audit score is unchanged.
6. **Design Recommender** (`src/design`): Good/Better HTML + Tailwind for the top issues, rendered to PNG with Playwright.
7. **Report** (`src/report`): `report.html` (self-contained), `report.json`, `report.md`, generated Playwright specs. Everything passes through `redactDeep` before writing.

## Module map

| Path | Responsibility |
|---|---|
| `src/core` | Shared types and zod schemas (`types.ts`), secret redaction (`redact.ts`) |
| `src/crawler` | Playwright crawl, login, axe-core, Lighthouse, nav graph |
| `src/rules` | Deterministic rule findings from the evidence bundle |
| `src/agents` | Claude client, specialist agents and prompts, domain packs, evidence validation |
| `src/design` | Design Recommender: Good/Better mockups and screenshots |
| `src/competitor` | Competitor crawl and comparison |
| `src/report` | Dedupe, fingerprints, scoring, test generation, HTML/JSON/MD writers |
| `src/engine` | `runAudit` orchestration and progress events |
| `src/server` | Fastify server: API, server-sent events for progress, serves `web/dist` and reports (run files with `Content-Security-Policy: sandbox`); refuses non-local Host headers and cross-origin non-GET requests |
| `src/export` | GitHub Issues and Jira export: preview, confirm, duplicate guard |
| `src/scripts/audit.ts` | Internal headless runner (`npm run audit`) for the GitHub Action and Claude Code |
| `web` | Vite + React frontend |
| `domains` | Domain pack YAML files |
| `fixtures` | Fixture sites with seeded defects, served by `npm run fixtures` |

## Run folder layout

```
reports/
  exports.json               # exported finding fingerprints (duplicate guard)
  <runId>/                   # e.g. 20261024-101500-a1b2c3
    meta.json                # status, url, timestamps, overall score
    progress.jsonl           # progress events (redacted)
    report.html              # self-contained report
    report.json              # Report (src/core/types.ts)
    report.md                # Markdown report
    evidence/                # screenshots, crops, DOM snapshots, design mockups (HTML + PNG)
    tests/generated/*.spec.ts  # Playwright regression specs
    claude-review-<agent>.md   # optional, written by Claude Code /audit subagents
    .auth/                   # login storage state, only during a run, then deleted
```

All evidence paths inside `report.json` are relative to the run folder.
