# Sign-in and sessions API

UI Auditor never asks for passwords in its own UI. When a page needs a sign-in, the user signs in
themselves in a real browser window that UI Auditor opens; the resulting session (cookies and
local storage) is saved per site under `.auth/sessions/` (git-ignored) and reused by later audits
until it expires or the user clicks **Forget**.

The username/password login (`options.login` + credentials or `UIA_LOGIN_USER`/`UIA_LOGIN_PASSWORD`)
still exists for CI and the headless script; the Web UI no longer exposes it.

## Endpoints

### `POST /api/check`
Body `{ "url": "https://..." }`. Loads the page headlessly (with the saved session if there is one)
and reports whether a sign-in form is showing.

```json
{ "origin": "https://app.example.com", "needsSignIn": true, "hasSession": false }
```
`needsSignIn` is `false` when the page loads without a password field (public page, or the saved
session still works). Takes up to ~20 s for single-page apps. 400 on an invalid URL.

### `POST /api/signin`
Body `{ "url": "https://..." }`. Opens a visible browser window at that URL for the user to sign in.
Returns `{ "id": "si_..." }`. Only one sign-in window at a time (409 with the running id otherwise).

### `GET /api/signin/:id`
```json
{ "id": "si_...", "origin": "https://...", "status": "waiting", "message": "Sign in in the window that opened." }
```
`status`: `waiting` (window open, user signing in) → `saved` (sign-in detected, session saved,
window closed) | `cancelled` (user closed the window) | `failed` (`message` says why) | `timeout`
(10 minutes). Poll about once a second.

### `POST /api/signin/:id/done`
The user says they are signed in: saves the session now and closes the window. Returns the same
shape as `GET`. Useful when automatic detection is slow.

### `DELETE /api/signin/:id`
Cancels and closes the window.

### `GET /api/sessions`
`{ "sessions": [{ "origin": "https://...", "savedAt": "2026-10-25T02:10:00.000Z" }] }`

### `DELETE /api/sessions?origin=https://...`
Forgets the saved session for that site. `{ "ok": true }`.

### `POST /api/audits` (changed)
Same body as before (`{ options, credentials? }`). If a saved session exists for the URL's origin
and `useSession` is not `false` in the body, the audit runs signed in with it. Response
`{ "id": "...", "usedSession": true }`.

## Web UI flow

1. User pastes a URL, picks **This page** (depth 0, 1 page) or **Whole site** (depth 2, 15 pages), clicks **Audit**.
2. UI calls `POST /api/check`.
   - `needsSignIn: false` → start the audit (`POST /api/audits`) and go to the progress page.
   - `needsSignIn: true` → show a "This page needs you to sign in" card with **Sign in** and
     **Audit the sign-in page instead** buttons.
3. **Sign in** → `POST /api/signin`, poll `GET /api/signin/:id`, show "Finish signing in in the
   window that opened" with an **I'm signed in** button (`POST .../done`) and **Cancel**.
   On `saved` → start the audit automatically.
4. A "Signed in to <origin> · Forget" chip is shown on the home page for each saved session.
