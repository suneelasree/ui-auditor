# Contributing to UI Auditor

Thanks for helping. Issues and pull requests are welcome.

## Setup

```bash
npm ci
npx playwright install chromium
cp .env.example .env    # ANTHROPIC_API_KEY is optional for most work
```

Node.js 22.19 or newer (required by Lighthouse and Vitest). `npm run dev` runs the server and the Vite frontend in watch mode.

## Tests

```bash
npm run lint
npm run typecheck
npm test                 # all: Vitest unit + integration, then Playwright e2e
npm run test:unit
npm run test:integration
npm run test:e2e
npm run fixtures         # fixture sites on http://localhost:4100 and :4200
```

Tests never call real Claude, Jira or GitHub APIs; use the existing mocks. If you add a detection rule, add a seeded defect to `fixtures/real-estate-site/`, document it in `fixtures/real-estate-site/SEEDED_DEFECTS.md`, and assert it in the integration tests.

## Project principles

- **Evidence first.** Every finding must cite evidence that exists in the crawl (selector, axe rule ID, console line, request URL, metric, screenshot region, link, domain check). Findings without matching evidence are dropped by `src/agents/evidence.ts`. Don't weaken this.
- **Read-only by default.** The crawler must not submit forms or change state unless "allow forms" is on.
- **No automatic exports.** Export only happens from the Web UI after preview and confirmation.
- Keep it simple: no new abstractions or dependencies unless they are needed.

## Adding a domain pack

1. Add `domains/<name>.yaml` following the `DomainPack` schema in `src/core/types.ts` (see the README for an example). Checks may set an optional `positive` label (the pattern phrased positively) for competitor comparison wording.
2. Add `<name>` to `DOMAIN_NAMES` in `src/core/types.ts`.
3. Update the `domain` input description in `.github/workflows/ui-audit.yml` and the README list.
4. Run `npm test` (the schema test validates every pack).

## Adding or changing an agent

- Engine agents: system prompts live in `src/agents/prompts/`; orchestration in `src/agents/specialists.ts`. Agent output is validated with zod (`RawFinding`) and then by evidence validation. Add the persona to `PERSONAS` in `src/core/types.ts` if it is new, and add unit tests with a mocked LLM client.
- Claude Code subagents: `.claude/agents/<name>.md`. If you add one, reference it in `.claude/commands/audit.md`.

## Pull request checklist

- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass locally.
- [ ] New behaviour has tests; new detections have a seeded fixture defect.
- [ ] README / docs updated if options, outputs or setup changed.
- [ ] No secrets, tokens, real credentials, `.env`, `reports/` or storage-state files committed.
- [ ] No real customer data or screenshots of sites you are not authorized to share.

## Never commit secrets

`.env`, `reports/`, `.auth/` and `*.storage-state.json` are git-ignored. Put new configuration in `.env.example` with an empty or safe default value only. If you commit a secret by accident, rotate it immediately; rewriting history is not enough.
