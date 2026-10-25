# Harbor Homes fixture: seeded defects

The fixture is served by `fixtures/serve.ts` (`npm run fixtures` starts it on http://127.0.0.1:4100, the competitor on :4200).
Test login for the protected page: see `fixture-login.json` (test-only credentials).

"Deterministic" means the rule engine (`src/rules/ruleFindings.ts`) finds it from crawler evidence with no LLM involved; `tests/integration/crawler.test.ts` and `tests/integration/rules.test.ts` assert each deterministic row.

| ID | Defect | Page | Category | How it's detected (rule id / evidence kind) | Deterministic |
|---|---|---|---|---|---|
| SD-01 | Broken internal link "Explore our neighborhood guides" to `/neighborhoods` (404) | `/` | Navigation | `brokenLinks` rule; evidence `link` = `<origin>/neighborhoods`; also `nav.brokenLinks` | yes |
| SD-02 | Dead "Schedule a tour" button with no handler, href or form | `/listings/42-harbor-view-drive` | Functional | `deadButtons` rule (CDP `DOMDebugger.getEventListeners` on element + ancestors); evidence `selector` = `button.btn.tour-btn` | yes |
| SD-03 | Listing photo without alt text | `/listings` | Accessibility | `missingAlt` rule; evidence `selector` = `img.listing-photo` (axe `image-alt` also fires) | yes |
| SD-04 | Low-contrast disclaimer text (#c8c8c8 on white) | `/` | Accessibility | axe rule `color-contrast`; evidence `axe-rule` = `color-contrast`, node `p.disclaimer` | yes |
| SD-05 | "Book a free valuation" CTA hidden below 800px (outside nav/header) | `/` | UX | `hiddenCtas` rule from `captures[tablet/mobile].hiddenCtas`; evidence `selector` + desktop element screenshot | yes |
| SD-06 | Uncaught JS error "SavedSearch widget failed to initialise" | `/listings` | Functional | `consoleErrors` rule; evidence `console` = `Uncaught Error: SavedSearch widget failed to initialise` | yes |
| SD-07 | 404 image `/images/kitchen-missing.jpg` | `/listings/42-harbor-view-drive` | Performance (broken asset) | `failedRequests` rule; evidence `network` = image URL | yes |
| SD-08 | Contact form with no validation (no `required`, email is `type=text`) | `/contact` | Functional | `formValidation` rule (`hasValidation: false`); evidence `selector` = `#contact-form` | yes |
| SD-09 | Navigation dead end: privacy page has no links at all | `/privacy` | Navigation | `navIssues` rule from `nav.nodes[].deadEnd`; evidence `link` = page URL + screenshot | yes |
| SD-10 | No price filter on the listings page (no "price range"/"min price"/"max price") | `/listings` | Domain | Domain pack check (real-estate), not the rule engine; evidence `domain-check` | no (domain pack) |
| SD-11 | Oversized image: 2400x1600 PNG (~700 KB, generated at runtime) rendered at 320x213 | `/about` | Performance | `oversizedImages` rule; evidence `network` = `<origin>/images/team-photo.png`, `selector` = `img.team-photo` | yes |
| SD-12 | Missing H1 (page starts at h2) | `/about` | SEO | `headingIssues` rule (`h1: []`); evidence screenshot | yes |
| SD-13 | Login-only page: agent avatar has no alt text | `/account` (requires login) | Accessibility | `missingAlt` rule; evidence `selector` = `img.account-agent-avatar`; page has `requiresLogin: true` | yes (with login) |
| SD-14 (bonus) | Specs table forces horizontal scrolling on tablet and mobile | `/listings/42-harbor-view-drive` | UX | `horizontalOverflow` rule from `captures[].horizontalOverflow` | yes |
| SD-15 (bonus) | No mortgage calculator anywhere on the site | site-wide | Domain | Domain pack check | no (domain pack) |
| SD-16 (bonus) | No map view of listings | `/listings` | Domain | Domain pack check | no (domain pack) |
| SD-17 (bonus) | No security headers (CSP, X-Frame-Options, ...) | site-wide | Security | `securityHeaders` rule; one Low finding on localhost | yes |

Not defects, but exercised by tests: `/admin` is disallowed in `robots.txt` (recorded in `robotsBlocked`, never fetched), `/account` redirects to `/login` without a session, and the `/logout` link is never followed.
