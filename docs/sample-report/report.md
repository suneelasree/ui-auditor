# UI Audit: http://127.0.0.1:4100

- **Target:** http://127.0.0.1:4100
- **Date:** 2026-10-24T17:54:40.652Z
- **Domain:** real-estate (detected, confidence 100%)
- **Pages audited:** 7
- **Overall score:** 79/100

> **Notes**
> - AI agents skipped: ANTHROPIC_API_KEY is not set. Only rule-based findings are included.

## Scores

| Category | Score |
|---|---|
| **Overall** | **79** |
| UX | 76 |
| Navigation | 83 |
| Functional | 71 |
| Accessibility | 64 |
| Performance | 78 |
| SEO | 95 |
| Security | 98 |
| Domain | 69 |

## Issues by severity

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 10 |
| Medium | 8 |
| Low | 3 |

## Top issues

1. **UIA-001** Call to action "Book a free valuation" disappears on tablet and mobile (High, UX)
2. **UIA-002** Page scrolls horizontally on tablet and mobile: /listings/42-harbor-view-drive (High, UX)
3. **UIA-003** Broken internal link "Explore our neighborhood guides" returns 404 (High, Navigation)
4. **UIA-004** Button "Schedule a tour" does nothing when clicked (High, Functional)
5. **UIA-005** Uncaught JavaScript exception: Uncaught Error: SavedSearch widget failed to initialise (High, Functional)

## Findings

### UIA-001: Call to action "Book a free valuation" disappears on tablet and mobile

- **Severity:** High
- **Category:** UX
- **Found by:** UX Designer
- **Page:** `/` @ mobile 375px
- **Fingerprint:** `527e7d544c3e5179`

**Evidence**

- selector: `a.btn.btn-secondary:nth-of-type(2)` - Visible at desktop, hidden at tablet, mobile (screenshot: `evidence/p01-home-cta1.png`)
- screenshot: `evidence/p01-home-tablet-fold.png` - tablet: "Book a free valuation" not visible (screenshot: `evidence/p01-home-tablet-fold.png`)
- screenshot: `evidence/p01-home-mobile-fold.png` - mobile: "Book a free valuation" not visible (screenshot: `evidence/p01-home-mobile-fold.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/ on desktop and note the "Book a free valuation" button
2. Resize to tablet/mobile width (e.g. 375 px)
3. Look for the same call to action

**Expected:** Primary calls to action stay available on every screen size.

**Actual:** "Book a free valuation" (a.btn.btn-secondary:nth-of-type(2)) is hidden at tablet, mobile.

**Recommendation:** Keep the CTA visible on small screens (stack it under the headline or use a sticky bottom bar) instead of display:none.

### UIA-002: Page scrolls horizontally on tablet and mobile: /listings/42-harbor-view-drive

- **Severity:** High
- **Category:** UX
- **Found by:** SDET
- **Page:** `/listings/42-harbor-view-drive` @ all viewports
- **Fingerprint:** `0df52af06d58fc94`

**Evidence**

- screenshot: `evidence/p06-listings-42-harbor-view-drive-tablet-full.png` - document.scrollWidth exceeds the tablet viewport width (screenshot: `evidence/p06-listings-42-harbor-view-drive-tablet-full.png`)
- screenshot: `evidence/p06-listings-42-harbor-view-drive-mobile-full.png` - document.scrollWidth exceeds the mobile viewport width (screenshot: `evidence/p06-listings-42-harbor-view-drive-mobile-full.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/listings/42-harbor-view-drive at tablet/mobile width
2. Swipe or scroll sideways

**Expected:** Content fits the viewport width; no sideways scrolling.

**Actual:** The document is wider than the viewport at tablet, mobile.

**Recommendation:** Find the element with a fixed/min width (tables, images, long words) and make it responsive (max-width: 100%, overflow-x: auto wrapper, stacked layout).

### UIA-003: Broken internal link "Explore our neighborhood guides" returns 404

- **Severity:** High
- **Category:** Navigation
- **Found by:** SDET
- **Page:** `/` @ all viewports
- **Fingerprint:** `e20a621ec4428884`

**Evidence**

- link: `http://127.0.0.1:4100/neighborhoods` - HTTP 404; linked from / (screenshot: `evidence/p01-home-desktop-fold.png`)
- selector: `main > p:nth-of-type(1) > a` - link text "Explore our neighborhood guides"

**Steps to reproduce**

1. Open http://127.0.0.1:4100/
2. Click the link "Explore our neighborhood guides" (main &gt; p:nth-of-type(1) &gt; a)
3. Observe the response for http://127.0.0.1:4100/neighborhoods

**Expected:** The link opens a working page (HTTP 2xx/3xx).

**Actual:** The link target http://127.0.0.1:4100/neighborhoods HTTP 404.

**Recommendation:** Fix the href to point at an existing page, restore the missing page, or add a redirect; add a link check to CI.

### UIA-004: Button "Schedule a tour" does nothing when clicked

- **Severity:** High
- **Category:** Functional
- **Found by:** SDET
- **Page:** `/listings/42-harbor-view-drive` @ all viewports
- **Fingerprint:** `4810029d32211ed7`

**Evidence**

- selector: `button.btn.tour-btn` - No click listener on the element or its ancestors, no href, not a form submit. Pages: /listings/42-harbor-view-drive (screenshot: `evidence/p06-listings-42-harbor-view-drive-desktop-full.png`)
- screenshot: `evidence/p06-listings-42-harbor-view-drive-desktop-full.png` - /listings/42-harbor-view-drive @ desktop (screenshot: `evidence/p06-listings-42-harbor-view-drive-desktop-full.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/listings/42-harbor-view-drive
2. Click the button "Schedule a tour" (button.btn.tour-btn)
3. Observe that nothing happens: no navigation, dialog or state change

**Expected:** Clicking the button performs its labelled action.

**Actual:** The button has no click handler, link or form behind it, so clicking does nothing.

**Recommendation:** Wire the button to its action (open the booking form/dialog or link to the relevant page), or remove it until the feature exists.

### UIA-005: Uncaught JavaScript exception: Uncaught Error: SavedSearch widget failed to initialise

- **Severity:** High
- **Category:** Functional
- **Found by:** Senior Engineer
- **Page:** `/listings` @ all viewports
- **Fingerprint:** `ce0b57ae8c16dd43`

**Evidence**

- console: `Uncaught Error: SavedSearch widget failed to initialise` - at at initSavedSearch (http://127.0.0.1:4100/js/saved-search.js:3:9); pages: /listings
- screenshot: `evidence/p03-listings-desktop-fold.png` - /listings @ desktop (screenshot: `evidence/p03-listings-desktop-fold.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/listings with DevTools open
2. Check the Console tab after the page loads

**Expected:** The page loads without JavaScript errors.

**Actual:** Console shows: Uncaught Error: SavedSearch widget failed to initialise

**Recommendation:** Fix the failing script (guard missing elements/data, handle errors) and add error monitoring so regressions are caught.

### UIA-006: 1 image without alt text on /account

- **Severity:** High
- **Category:** Accessibility
- **Found by:** Accessibility
- **Page:** `/account` @ all viewports
- **Fingerprint:** `c94411c1d4087d01`

**Evidence**

- selector: `img.account-agent-avatar` - &lt;img src="http://127.0.0.1:4100/images/agent.svg"&gt; has no alt attribute (screenshot: `evidence/p02-account-desktop-full.png`)
- network: `http://127.0.0.1:4100/images/agent.svg`

**Steps to reproduce**

1. Open http://127.0.0.1:4100/account
2. Inspect img.account-agent-avatar
3. Check the alt attribute (or use a screen reader)

**Expected:** Informative images have descriptive alt text; decorative images have alt="".

**Actual:** 1 image have no alt attribute, so screen readers announce the file name or nothing.

**Recommendation:** Add descriptive alt text (e.g. "3-bedroom cottage on Lighthouse Lane, front view"), or alt="" for purely decorative images.

### UIA-007: 1 image without alt text on /listings

- **Severity:** High
- **Category:** Accessibility
- **Found by:** Accessibility
- **Page:** `/listings` @ all viewports
- **Fingerprint:** `cea6bba1f3c9c53c`

**Evidence**

- selector: `img.listing-photo` - &lt;img src="http://127.0.0.1:4100/images/house-4.svg"&gt; has no alt attribute (screenshot: `evidence/p03-listings-desktop-full.png`)
- network: `http://127.0.0.1:4100/images/house-4.svg`

**Steps to reproduce**

1. Open http://127.0.0.1:4100/listings
2. Inspect img.listing-photo
3. Check the alt attribute (or use a screen reader)

**Expected:** Informative images have descriptive alt text; decorative images have alt="".

**Actual:** 1 image have no alt attribute, so screen readers announce the file name or nothing.

**Recommendation:** Add descriptive alt text (e.g. "3-bedroom cottage on Lighthouse Lane, front view"), or alt="" for purely decorative images.

### UIA-008: Elements must meet minimum color contrast ratio thresholds (color-contrast) on /

- **Severity:** High
- **Category:** Accessibility
- **Found by:** Accessibility
- **Page:** `/` @ all viewports
- **Fingerprint:** `83a92210bfbae205`

**Evidence**

- axe-rule: `color-contrast` - Elements must meet minimum color contrast ratio thresholds. 1 element affected. https://dequeuniversity.com/rules/axe/4.14/color-contrast?application=playwright (screenshot: `evidence/p01-home-desktop-fold.png`)
- selector: `.disclaimer` - Fix any of the following:   Element has insufficient color contrast of 1.67 (foreground color: #c8c8c8, background color: #ffffff, font size: 10.8pt (14.4px), font weight: normal). Expected contrast ratio of 4.5:1

**Steps to reproduce**

1. Open http://127.0.0.1:4100/
2. Run axe-core (rule color-contrast)
3. Inspect .disclaimer

**Expected:** No violations of WCAG rule "color-contrast".

**Actual:** 1 element fail: Elements must meet minimum color contrast ratio thresholds.

**Recommendation:** Fix per https://dequeuniversity.com/rules/axe/4.14/color-contrast?application=playwright. Fix any of the following:   Element has insufficient color contrast of 1.67 (foreground color: #c8c8c8, background color: #ffffff, font size: 10.8pt (14.4px), font weight: normal). Expected contrast ratio of 4.5:1

### UIA-009: Slow page: Lighthouse performance score 78/100; LCP 4503 ms (target &lt;= 2500) on /about

- **Severity:** High
- **Category:** Performance
- **Found by:** Senior Engineer
- **Page:** `/about` @ desktop 1440px
- **Fingerprint:** `70c2f026bf333b26`

**Evidence**

- metric: `performance=78` - Lighthouse performance score 78/100
- metric: `lcpMs=4503` - LCP 4503 ms (target &lt;= 2500)

**Steps to reproduce**

1. Run Lighthouse (desktop) on http://127.0.0.1:4100/about

**Expected:** Core Web Vitals in the "good" range: LCP &lt;= 2.5 s, CLS &lt;= 0.1, TBT &lt;= 200 ms.

**Actual:** Lighthouse performance score 78/100; LCP 4503 ms (target &lt;= 2500)

**Recommendation:** Optimise the largest element (image size, preload), defer non-critical JavaScript, reserve space for late content.

### UIA-010: No price range filter on listings

- **Severity:** High
- **Category:** Domain
- **Found by:** Domain Expert
- **Page:** `/` @ all viewports
- **Fingerprint:** `5b0a7eddaf8c678b`

**Evidence**

- domain-check: `re-price-filter` - Searched 7 page(s) for selectors [input[name*=price i], select[name*=price i], input[id*=price i], select[id*=price i], [class*=price-filter i], [class*=pricefilter i], ...] and keywords [price range, min price, max price, minimum price, maximum price, any price]; none found (screenshot: `evidence/p01-home-desktop-fold.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/
2. Look for: Price range filter on listings
3. Observe that it is not present on any of the 7 crawled page(s)

**Expected:** Buyers filter by budget first. Leading property portals offer min/max price controls on every search and listings page.

**Actual:** Not found on any of the 7 crawled page(s).

**Recommendation:** Add min/max price selects (or a range slider) above the results, keep the chosen range in the URL so searches are shareable, and show the active range as a removable chip.

### UIA-011: Navigation dead end: /privacy has no links to other pages

- **Severity:** Medium
- **Category:** Navigation
- **Found by:** SDET
- **Page:** `/privacy` @ all viewports
- **Fingerprint:** `873e3794b2f83fe4`

**Evidence**

- link: `http://127.0.0.1:4100/privacy` - /privacy has 0 internal outbound links (inbound: 6)
- screenshot: `evidence/p07-privacy-desktop-full.png` - /privacy: no navigation, header or footer links (screenshot: `evidence/p07-privacy-desktop-full.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/privacy
2. Look for site navigation, a logo link or footer links
3. Observe there is no way to continue except the browser back button

**Expected:** Every page offers site navigation (header nav, logo link to home, footer links).

**Actual:** The page contains no internal links at all.

**Recommendation:** Use the shared page layout with header navigation and footer on this page.

### UIA-012: Form #contact-form accepts input without any validation

- **Severity:** Medium
- **Category:** Functional
- **Found by:** SDET
- **Page:** `/contact` @ all viewports
- **Fingerprint:** `a10691049f576f48`

**Evidence**

- selector: `#contact-form` - Fields: name(text), email(text), phone(text), message(textarea). No required/pattern/type constraints. (screenshot: `evidence/p05-contact-desktop-full.png`)
- screenshot: `evidence/p05-contact-desktop-full.png` - /contact @ desktop (screenshot: `evidence/p05-contact-desktop-full.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/contact
2. Leave every field of #contact-form empty (or type "abc" into the email field)
3. Submit the form

**Expected:** Required fields and email/phone formats are validated before the form is sent, with clear inline errors.

**Actual:** No field is required and no input type or pattern constrains the values, so empty or malformed submissions are accepted.

**Recommendation:** Mark required fields with `required`, use type="email"/"tel", add inline error messages, and validate again on the server.

### UIA-013: Broken image: /images/kitchen-missing.jpg (HTTP 404)

- **Severity:** Medium
- **Category:** Performance
- **Found by:** Senior Engineer
- **Page:** `/listings/42-harbor-view-drive` @ all viewports
- **Fingerprint:** `0b7ceeeb58052f13`

**Evidence**

- network: `http://127.0.0.1:4100/images/kitchen-missing.jpg` - GET image -&gt; HTTP 404; pages: /listings/42-harbor-view-drive
- screenshot: `evidence/p06-listings-42-harbor-view-drive-desktop-full.png` - /listings/42-harbor-view-drive @ desktop (screenshot: `evidence/p06-listings-42-harbor-view-drive-desktop-full.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/listings/42-harbor-view-drive with DevTools &gt; Network open
2. Find the request to http://127.0.0.1:4100/images/kitchen-missing.jpg

**Expected:** All page resources load successfully.

**Actual:** GET http://127.0.0.1:4100/images/kitchen-missing.jpg -&gt; HTTP 404.

**Recommendation:** Restore the missing image or fix its src; add a fallback/placeholder and monitor 404s.

### UIA-014: Oversized image: 2400x1600 (695 KB) shown at 320x213

- **Severity:** Medium
- **Category:** Performance
- **Found by:** Senior Engineer
- **Page:** `/about` @ desktop 1440px
- **Fingerprint:** `38a86f80f61a3c71`

**Evidence**

- network: `http://127.0.0.1:4100/images/team-photo.png` - natural 2400x1600, rendered 320x213, 695 KB
- selector: `img.team-photo` (screenshot: `evidence/p04-about-desktop-full.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/about
2. Inspect img.team-photo
3. Compare its intrinsic size and transfer size with its displayed size

**Expected:** Images are served close to their displayed size (about 2x for retina) in a modern format.

**Actual:** The image is 7.5x wider than displayed and weighs 695 KB.

**Recommendation:** Resize and compress the image (WebP/AVIF), and use srcset/sizes so small screens get small files.

### UIA-015: Missing H1 heading on /about

- **Severity:** Medium
- **Category:** SEO
- **Found by:** UX Designer
- **Page:** `/about` @ all viewports
- **Fingerprint:** `20a1352f23ee690d`

**Evidence**

- screenshot: `evidence/p04-about-desktop-fold.png` - /about: 0 &lt;h1&gt; elements; headings: h2 "About Harbor Homes", h2 "Our agents" (screenshot: `evidence/p04-about-desktop-fold.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/about
2. Inspect the heading outline (e.g. with a headings bookmarklet)

**Expected:** Each page has exactly one H1 that states its purpose.

**Actual:** The page has no H1; it starts with h2 "About Harbor Homes".

**Recommendation:** Promote the main page title to an &lt;h1&gt; and keep a logical h1 &gt; h2 &gt; h3 outline.

### UIA-016: Listings cannot be sorted

- **Severity:** Medium
- **Category:** Domain
- **Found by:** Domain Expert
- **Page:** `/` @ all viewports
- **Fingerprint:** `f160fc379e00a124`

**Evidence**

- domain-check: `re-sort` - Searched 7 page(s) for selectors [select[name*=sort i], select[id*=sort i], [class*=sort-by i], [class*=sortby i], [data-sort], [aria-label*=sort i]] and keywords [sort by, sort results, newest first, low to high, high to low]; none found (screenshot: `evidence/p01-home-desktop-fold.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/
2. Look for: Listings cannot be sorted
3. Observe that it is not present on any of the 7 crawled page(s)

**Expected:** Users expect to sort results by price, newest and size.

**Actual:** Not found on any of the 7 crawled page(s).

**Recommendation:** Add a "Sort by" control (Newest, Price low to high, Price high to low, Size) above the results.

### UIA-017: No map view for listings

- **Severity:** Medium
- **Category:** Domain
- **Found by:** Domain Expert
- **Page:** `/` @ all viewports
- **Fingerprint:** `ec3cca68d96fd4f4`

**Evidence**

- domain-check: `re-map-view` - Searched 7 page(s) for selectors [#map, [class~=map], [class*=map-view i], [class*=mapview i], [class*=listing-map i], [class*=leaflet-container], ...] and keywords [map view, view on map, show map, search by map, map search, view map]; none found (screenshot: `evidence/p01-home-desktop-fold.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/
2. Look for: Map view for listings
3. Observe that it is not present on any of the 7 crawled page(s)

**Expected:** Location drives property decisions; top portals pair the results list with an interactive map.

**Actual:** Not found on any of the 7 crawled page(s).

**Recommendation:** Offer a list/map toggle (split view on desktop) with listing pins that sync with the results and a "search this area" action.

### UIA-018: No mortgage or affordability calculator

- **Severity:** Medium
- **Category:** Domain
- **Found by:** Domain Expert
- **Page:** `/` @ all viewports
- **Fingerprint:** `01fee7021d3f9235`

**Evidence**

- domain-check: `re-mortgage-calculator` - Searched 7 page(s) for selectors [[class*=mortgage i], [id*=mortgage i], form[action*=mortgage i], a[href*=mortgage i], input[name*=down-payment i], input[name*=downpayment i], ...] and keywords [mortgage calculator, monthly payment, estimated payment, down payment, affordability calculator]; none found (screenshot: `evidence/p01-home-desktop-fold.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/
2. Look for: Mortgage or affordability calculator
3. Observe that it is not present on any of the 7 crawled page(s)

**Expected:** Calculators keep buyers on the site and turn browsing into budget planning.

**Actual:** Not found on any of the 7 crawled page(s).

**Recommendation:** Add an estimated monthly payment on each listing that opens a calculator (price, deposit, rate, term), pre-filled with the listing price.

### UIA-019: Missing security headers: content-security-policy, x-content-type-options, x-frame-options, referrer-policy, permissions-policy

- **Severity:** Low
- **Category:** Security
- **Found by:** Senior Engineer
- **Page:** `/` @ all viewports
- **Fingerprint:** `5e10c07af1283ff6`

**Evidence**

- link: `http://127.0.0.1:4100/` - Response headers of the main document lack: content-security-policy, x-content-type-options, x-frame-options, referrer-policy, permissions-policy (local server; verify on production)
- screenshot: `evidence/p01-home-desktop-fold.png` - / @ desktop (screenshot: `evidence/p01-home-desktop-fold.png`)

**Steps to reproduce**

1. Run: curl -I http://127.0.0.1:4100/
2. Inspect the response headers

**Expected:** The document response sets standard security headers.

**Actual:** Missing: content-security-policy, x-content-type-options, x-frame-options, referrer-policy, permissions-policy.

**Recommendation:** Add at the server/CDN: Content-Security-Policy (start with default-src 'self'); X-Content-Type-Options: nosniff; X-Frame-Options: DENY (or CSP frame-ancestors 'none'); Referrer-Policy: strict-origin-when-cross-origin; Permissions-Policy limiting camera, microphone, geolocation.

### UIA-020: No neighbourhood or school information

- **Severity:** Low
- **Category:** Domain
- **Found by:** Domain Expert
- **Page:** `/` @ all viewports
- **Fingerprint:** `f0f2d759faf9af96`

**Evidence**

- domain-check: `re-neighbourhood-info` - Searched 7 page(s) for selectors [[class*=neighbourhood i], [class*=neighborhood i], [id*=neighbourhood i], [id*=neighborhood i], [class*=nearby-schools i]] and keywords [neighbourhood guide, neighborhood guide, about the neighbourhood, about the neighborhood, nearby schools, school ratings, ...]; none found (screenshot: `evidence/p01-home-desktop-fold.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/
2. Look for: Neighbourhood or school information
3. Observe that it is not present on any of the 7 crawled page(s)

**Expected:** Buyers research the area as much as the home; leading sites show schools, amenities and commute info.

**Actual:** Not found on any of the 7 crawled page(s).

**Recommendation:** Add a neighbourhood section on listings (nearby schools with ratings, transport, amenities, a walkability or commute score).

### UIA-021: No virtual tour or video

- **Severity:** Low
- **Category:** Domain
- **Found by:** Domain Expert
- **Page:** `/` @ all viewports
- **Fingerprint:** `b187bd83751b8215`

**Evidence**

- domain-check: `re-virtual-tour` - Searched 7 page(s) for selectors [iframe[src*=matterport i], [class*=virtual-tour i], a[href*=virtual-tour i]] and keywords [virtual tour, 3d tour, video tour]; none found (screenshot: `evidence/p01-home-desktop-fold.png`)

**Steps to reproduce**

1. Open http://127.0.0.1:4100/
2. Look for: Virtual tour or video
3. Observe that it is not present on any of the 7 crawled page(s)

**Expected:** Virtual tours reduce wasted viewings and are increasingly expected on premium listings.

**Actual:** Not found on any of the 7 crawled page(s).

**Recommendation:** Support embedding a 3D/video tour on listings and badge listings that have one.

## Competitor comparison

| Category | 127.0.0.1:4100 (you) | 127.0.0.1:4200 |
|---|---|---|
| **Overall** | **86** | **99** |
| UX | 100 | 100 |
| Navigation | 88 | 100 |
| Functional | 71 | 100 |
| Accessibility | 76 | 100 |
| Performance | 90 | 100 |
| SEO | 95 | 100 |
| Security | 98 | 98 |
| Domain | 69 | 91 |

### What competitors do better

- **127.0.0.1:4200: Price range filter on listings** 127.0.0.1:4200 has this pattern; your site does not. Buyers filter by budget first. Leading property portals offer min/max price controls on every search and listings page.
- **127.0.0.1:4200: Map view for listings** 127.0.0.1:4200 has this pattern; your site does not. Location drives property decisions; top portals pair the results list with an interactive map.
- **127.0.0.1:4200: Sortable listings** 127.0.0.1:4200 has this pattern; your site does not. Users expect to sort results by price, newest and size.
- **127.0.0.1:4200: Mortgage or affordability calculator** 127.0.0.1:4200 has this pattern; your site does not. Calculators keep buyers on the site and turn browsing into budget planning.
- **127.0.0.1:4200: Neighbourhood or school information** 127.0.0.1:4200 has this pattern; your site does not. Buyers research the area as much as the home; leading sites show schools, amenities and commute info.

### Where you win

- You have "Photo gallery for properties" and 127.0.0.1:4200 does not.
- You have "Save / favourite listings" and 127.0.0.1:4200 does not.

### Patterns worth copying

- Price range filter on listings
- Map view for listings
- Sortable listings
- Mortgage or affordability calculator
- Neighbourhood or school information

## Generated regression tests

- `tests/generated/home.spec.ts`
- `tests/generated/listings-42-harbor-view-drive.spec.ts`
- `tests/generated/listings.spec.ts`
- `tests/generated/privacy.spec.ts`
- `tests/generated/contact.spec.ts`

## Agents

| Agent | Status | Findings | Dropped | Note |
|---|---|---|---|---|
| Rules | ok | 21 | 0 |  |
| Competitor Analyst | ok | 5 | 0 |  |
| Design Recommender | skipped | 0 | 0 | Design alternatives need ANTHROPIC_API_KEY |
