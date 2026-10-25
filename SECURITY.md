# Security Policy

## Scope and responsible use

UI Auditor performs **passive checks only**: it loads pages, follows same-origin links within limits, respects `robots.txt`, rate-limits requests, and reads response headers. It does no penetration testing, fuzzing or vulnerability scanning beyond passive security-header checks. Forms are only submitted when you explicitly turn on "allow forms".

**Only audit sites you own or are authorized to test.** For logged-in audits, use dedicated test or staging accounts, never personal or production admin accounts.

## Credential handling

- **Web UI sign-in:** the user signs in themselves in a browser window UI Auditor opens; UI Auditor never receives the password. The resulting session (cookies and local storage) is saved per site in `.auth/sessions/` (git-ignored) so later audits can reuse it. That file grants access to the account until the session expires, so keep the folder private and use **Forget** in the Web UI (or delete the file) when done. Sessions are only ever used for audits of the same origin.
- Login credentials come only from `UIA_LOGIN_USER` / `UIA_LOGIN_PASSWORD` (environment, `.env`, or GitHub secrets), or are entered in the Web UI for a single run. Web UI credentials are held in memory for that run and never written to disk.
- Credentials are registered with a redactor (`src/core/redact.ts`) for the duration of the run, so they are scrubbed from progress messages, logs, errors and the report.
- Password fields are masked in screenshots, including `evidence/login-failed.png`. Nothing else is masked: a page that displays the logged-in username or email will show it in screenshots (and those screenshots may be sent to Claude).
- The Playwright storage state (session cookies) is saved inside the run folder only for the run and deleted when the run ends, including on failure.
- An integration test greps all run outputs for the test password and fails if it appears.
- MFA, CAPTCHA and SSO are not supported, and the tool does not attempt to bypass them.

## Token handling

- `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `JIRA_API_TOKEN` and other secrets belong in `.env` (git-ignored) or in your CI secret store. `.env.example` contains no secrets (`ANTHROPIC_API_KEY` is empty by default).
- Use least-privilege tokens: a fine-grained GitHub token limited to Issues on one repository; a Jira API token for an account that can only create issues in the target project.
- Tokens are only sent to their own service (Anthropic, GitHub, your Jira base URL). Issue export only runs from the Web UI after a preview and explicit confirmation; the GitHub Action and Claude Code `/audit` never export.
- What is sent to Claude: screenshots, trimmed DOM/text samples, logs and metrics from the crawl. Don't audit pages containing data you are not allowed to send to a third-party API.
- The local Web UI server is intended for `localhost`. Don't expose it to an untrusted network. It refuses requests whose Host header is not `localhost`, `127.0.0.1` or a name listed in `UIA_ALLOWED_HOSTS` (blocks DNS rebinding), and refuses cross-origin non-GET requests.
- Run files under `/reports/:id/*` are served with `Content-Security-Policy: sandbox` (`report.html` gets `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox`), so content captured from audited sites cannot act on the Web UI's origin.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's **private vulnerability reporting** (Security tab, "Report a vulnerability") on this repository. Include steps to reproduce, affected version or commit, and impact. We aim to acknowledge reports within 5 working days and will credit reporters who want it.

## Supported versions

Only the latest release on `main` receives security fixes.
