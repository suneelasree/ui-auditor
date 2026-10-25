---
description: Run a UI Auditor audit on a URL, then get a deeper review from the specialist subagents. Never exports issues.
argument-hint: <url> [--depth 2] [--max-pages 15] [--domain auto] [--viewports desktop,tablet,mobile] [--competitor <url>] [--allow-forms] [--no-lighthouse] [--login-url <url>] [--login-choose <text>] [--login-success-url <text>] [--login-success-selector <css>]
allowed-tools: Bash(npm run audit:*), Read, Grep, Glob, Task, Agent
---

Audit the site given in the arguments with UI Auditor and summarize the results.

Arguments: `$ARGUMENTS`

## Steps

1. **Check inputs.** If no URL was given, show the usage line from `argument-hint` and stop. Remind the user to audit only sites they are authorized to test. If `--login-url` is present, the credentials must already be in `UIA_LOGIN_USER` / `UIA_LOGIN_PASSWORD` (environment or `.env`); never ask the user to paste a password into the chat, and never print those variables.

2. **Run the audit** (this can take several minutes):

   ```bash
   npm run audit -- $ARGUMENTS
   ```

   Exit code 0 means success; 2 means invalid options (show the error and stop); 1 means the audit failed (show the last lines of output and stop). On success the output ends with the paths of `report.html`, `report.json` and `report.md`; the run folder is the directory containing them, `reports/<runId>/`.

3. **Read `reports/<runId>/report.json`**: target, domain, scores, `summary` (top issues and severity counts), `findings`, `agents`, `notes` (for example, AI agents skipped because `ANTHROPIC_API_KEY` is not set), and `comparison` if present.

4. **Deeper review in parallel.** In a single message, launch these subagents with the Task tool, giving each the run folder path `reports/<runId>/`:
   - `ux-designer`
   - `senior-engineer`
   - `sdet`
   - `accessibility`
   - `domain-expert`
   - `design-recommender`

   Each writes `reports/<runId>/claude-review-<agent>.md` and replies with its top priorities. If a subagent fails, note it and continue.

5. **Summarize for the user**:
   - Target, detected domain, overall score and per-category scores, pages audited, severity counts.
   - The top 5 issues (ID, severity, title, page, one-line recommendation), adjusted by what the subagents found: call out anything they added or re-ranked, with its evidence.
   - Comparison highlights if competitors were given.
   - Any notes (skipped agents, crawl warnings, dropped findings).
   - Paths: `reports/<runId>/report.html` (open in a browser), `report.md`, the generated specs in `reports/<runId>/tests/generated/`, and the `claude-review-*.md` files.

## Never

- Never export findings to GitHub Issues or Jira, and never call their APIs. If the user wants issues created, tell them to use **Export** in the Web UI (`npm start`), which shows a preview and asks for confirmation.
- Never print, log or write credentials or tokens.
- Never modify `report.json`, `report.html` or `report.md`.
