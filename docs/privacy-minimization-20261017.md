# Technical Privacy Minimization - 2026-10-17

## Scope and Ownership

The operator reports mainland-China operation, US hosting and a global English-speaking audience. This is a technical minimization change, not a legal compliance certification. No deployment, database writes or provider-account actions are part of this work. A follow-up authorized an isolated, anonymous public-document edge check, with all production APIs and telemetry blocked. Do not include secrets, real storage contents or user data in diagnostics.

The checkout is already extensively dirty on `refactor/frontend-modules-20260905`. Preserve existing and concurrent changes. Initial ownership covered the new `privacy-headers.js`, `test/privacy-headers.test.mjs`, `public/js/shared/contribution-navigation.js` and focused navigation tests/documentation. Follow-up authorization expanded this to three narrow imperative-navigation adaptations in `public/js/contribute.js` and the VM harness files listed below. The parent retains `server.js`, `global.js`, other application modules, consent UI, backend, legal HTML and real privacy-gate/legal tests. Final local verification was completed on 2026-10-18; no production write or deployment occurred.

## Context Map

### Files to Modify

| File | Purpose | Planned change |
| --- | --- | --- |
| `privacy-headers.js` (new) | Express-compatible response headers | Enforced, restrictive script policy with reviewed inline hashes; conservative headers without OAuth-breaking isolation. |
| `public/js/shared/contribution-navigation.js` | Clean contribution routes and opaque prefill handoffs | Keep URL construction in memory; persist only a requested handoff at activation. Preserve existing route removal and Back behavior. |
| `public/js/contribute.js` (follow-up authorization) | Imperative prefill navigation | Activate handoffs immediately before bulk import, merge and add-condition navigation; leave all other behavior intact. |
| `test/privacy-headers.test.mjs` (new) | Header and CSP regressions | Test middleware composition, actual HTML inventory and browser enforcement. |
| `test/contribution-navigation.test.mjs` (new) | Handoff regressions | Cover zero eager storage, activation, expiry, malformed/denied storage, multiple tabs, reload and route integrity. |
| This document | Context, integration and limitations | Record review, integration prerequisites and test evidence. |

### Dependencies and Callers

| File | Relationship |
| --- | --- |
| `server.js` | Initially had no CSP; parent has now mounted `privacyHeaders` before `express.static`, page routes and session handling. Avatar validation permits any credential-free HTTPS URL. |
| `home-assets.js` | Serves verified `private/home-built.html`, or current `private/home.html` when source/manifest changes. Category bootstrap is a meta element, not script text. |
| `scripts/build-home-assets.mjs` | Bundles startup into one inline IIFE. A changed IIFE requires reviewing/updating its CSP hash. Do not run its repository-writing tests for this task. |
| `private/*.html` | Real application entry points: home, contribution, legal, how-it-works, login/callback, dialogs and moderation. |
| `public/assets/color-studies-20260909/index.html` | Public static design reference, with one inline script generating same-origin images. |
| `public/js/home.js`, `public/js/home-workspace.js`, `public/js/workspace/links.js` | Build prefilled anchor URLs during rendering, including beta feedback, empty search and score/model/benchmark actions. |
| `public/js/contribute.js` | Builds native suggestion anchors and directly navigates with prefill from bulk import, merge and add-condition buttons. All three imperative handoffs are now explicitly activated under the follow-up authorization. |
| `public/js/legal.js` | Changes privacy-request anchor href inside a click handler; delegated activation must run after target handlers. Context-menu/middle activation currently does not run that click-only template handler. |
| `public/js/censor.js`, `public/js/discussion.js` | Predominantly route-only links; moderation's `window.open` calls currently have no extra prefill. |
| `public/js/global.js`, `public/js/shared/page-header.js` | Custom dialogs/header inject style elements and update style properties. OAuth uses a popup and opener messaging. |
| `public/js/shared/http.js`, `public/js/home-startup.js` | Same-origin API fetches. No application WebSocket, worker or external script dependency found. |
| `public/js/shared/organization-logos.js`, `public/css/typography.css` | Vendor marks and fonts are self-hosted. |

### Existing Test Patterns

| Test | Coverage / constraint |
| --- | --- |
| `test/contribution-back.test.mjs` | VM-based same-origin return navigation; preserve concurrent implementation. |
| `test/clean-urls.test.mjs`, `test/fixed-score-contributions.test.mjs` | Route and object identity contracts. |
| `test/cloudflare-telemetry.test.mjs` | Telemetry observation helpers, not proof of analytics suppression. |
| `test/privacy-mobile.test.mjs` | Parent-owned legal/UI contracts may change concurrently. |
| `scripts/frontend/server.mjs` | Local fixture APIs; no production database required. |
| `test/home-assets.test.mjs` | Includes a real repository build/write. Do not run in the shared dirty checkout. |

## Inspected Inventory

- All application HTML script sources are self-hosted under `/js/` or `/build/home/`. No application HTML inline event-handler attributes, `javascript:` links, script evaluation, external-script loaders or embedded third-party frames were found. A test-only inline module exists in `test/fixtures/custom-select.html`; it is not an application response.
- Two public inline scripts were reviewed: the generated early-home startup in `private/home-built.html` and the static color-study image generator. Browser-normalized UTF-8 hashes (CRLF/CR become LF) are respectively `sha256-giS2U1VTk0kjJyVehXCrRsP9/Gmj3YsJi3+rIzYqxng=` and `sha256-B0jVaV6qxBJ0imok6w4LyDDPnOr2rAJlZAZ/MgW7yFc=`. No runtime hashing of arbitrary/injected HTML is proposed.
- CSS includes self-hosted imports, Manrope fonts and Font Awesome assets. Inline style elements/attributes and JS style properties are required by existing dialogs, charts, controls and account avatars. `style-src` can retain `unsafe-inline` without authorizing inline JavaScript.
- Browser API connections are same-origin `/api/...`. GitHub authentication is a top-level popup navigation through same-origin `/github_login`; server-to-server GitHub API/token calls are not browser `connect-src` requirements. External source/social links are navigation, not embedded scripts or frames.
- Images and CSS backgrounds are self-hosted except account avatars. Current server validation allows any HTTPS avatar host, not just `avatars.githubusercontent.com`. Preserve that contract with HTTPS images for now; narrowing requires parent-owned validation or a reviewed image proxy. Do not add `data:` or `blob:` without a demonstrated requirement.
- The prior audit observed provider-injected `static.cloudflareinsights.com/beacon.min.js` and same-origin `/cdn-cgi/rum` on production. That is historical evidence, not a new production observation. Excluding the script origin blocks that injection in CSP-capable browsers. `connect-src 'self'` does not itself block same-origin `/cdn-cgi/rum`.
- Before this change, `buildContributionURL()` enumerated localStorage, purged entries and stored an opaque handoff while rendering a link. Only this proven eager write was changed. Requested form reads already create per-tab sessionStorage for reload/back; other preferences/drafts are outside this ownership.

## Design Review Before Implementation

Context map reviewed against current callers, real HTML, compiled-home renderer/build and existing tests before implementation. No database migration or production/provider change is required. Public API remains clean contribution-path strings; the new explicit activation helper is integrated at the three imperative prefill callers listed above.

The policy can be enforced for the inspected application with pinned inline hashes. No script `unsafe-inline`, `unsafe-eval`, nonce reuse, arbitrary external script source or automatic hashing of response content is acceptable. Changed/generated inline script text must fail a test and be reviewed before rollout. A deployment that cannot maintain those hashes must externalize the startup script (or implement per-response nonces in its renderer) before enforcing this policy.

## Integration and Verification

Both new tests live under `test/` following the parent's correction, and are included in the existing `npm test` glob. Focused verification does not run the full suite's repository-writing home build.

### Headers

The parent has confirmed this integration before static middleware; the implementation is synchronous and has exactly this named export/signature:

```js
import { privacyHeaders } from './privacy-headers.js';

app.use(privacyHeaders);
app.use(express.static(currentDir + '/public', existingStaticOptions));
```

It adds an enforced `Content-Security-Policy`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` (preserving an existing `no-referrer`). An existing CSP is retained as an additional intersecting policy, rather than overwritten. It does not inspect sessions, create cookies, change caching, configure reporting endpoints or add COOP/COEP/HSTS. Report-only CSP cannot meet analytics-blocking requirements.

### Imperative Navigation Integration

Prefill anchors are handled automatically after target handlers, with trusted primary/Enter, modified, middle and context-menu activation. Default browser navigation is not intercepted. Pure URL construction performs no storage access; an activated handoff receives a fresh 30-minute lifetime. Explicitly requested form entry still writes per-tab sessionStorage for reload/back. Only expired/malformed handoffs in the module's existing namespace are cleaned, and only on activation.

Implemented: `public/js/contribute.js` imports `activateContributionURL` and wraps all three imperative prefill navigations. The parent must include this caller file in the release along with the shared module:

```js
// Bulk import (currently line 41) and requestMerge (currently line 514):
location.assign(activateContributionURL(buildContributionURL('feedback', values)));

// Add-condition action (currently lines 2608-2609): keep its existing URL construction.
location.assign(activateContributionURL(url.href));
```

Without these wrappers the clean route would open with unavailable prefill; this compatibility issue is now fixed. A fresh whole-application search of `buildContributionURL`, its aliases and wrapper functions found no other imperative navigation requiring prefill persistence. The route-only model edit at line 695 and moderation's route-only `window.open` calls need no wrapper. Other callers assign native anchor hrefs and use the shared activation handler. No backend authorization is moved to the client.

### Local Verification

```powershell
node --test test/privacy-headers.test.mjs test/contribution-navigation.test.mjs
node --test test/account-identity.test.mjs test/fixed-score-contributions.test.mjs test/personal-pie-save.test.mjs test/write-idempotency.test.mjs test/moderation-transactions.test.mjs test/moderation-replay.test.mjs test/transaction-cleanup.test.mjs
node --test test/contribution-back.test.mjs test/clean-urls.test.mjs test/static-session-isolation.test.mjs test/contribution-contract.test.mjs
```

Local Chromium tests parse all real private/public HTML with DOMParser, check the reviewed inline hashes/handler inventory, and exercise real source/built-home, form, legal, help and moderation modules. A synthetic analytics-tag injection is blocked before any external script/connect request; inline handlers and eval are also blocked. Self modules/imports, HTTPS avatars, custom-element styles/dialogs, form validation/fetch and popup-opener messaging continue to work. Native Enter, primary, new-tab, modified and middle clicks, plus a first-time href assignment during a target click handler, retain prefill and reload recovery.

Final results on 2026-10-18:

| Verification | Result |
| --- | --- |
| Privacy headers + contribution navigation tests | 29 passed, 0 failed; 1 network-dependent live-edge opt-in skipped. |
| Actual contribution workflows | All 10 passed: Beta, Contribute scores, Contribute benchmark, empty-search manual benchmark, empty-search bulk import, bulk-import button, merge, add-condition, discussion report and score change. |
| Terms-guard VM harness and related business tests | 255 passed, 0 failed. |
| Existing Back/clean-URL/static-session/contribution contracts | 44 passed, 0 failed. |
| ESLint across all 12 changed JS/MJS files | Passed. |

Actual homepage workflows use the native `Open rankings` button to leave the presentation before operating formal-page controls. They do not force-click, rewrite visibility, pre-seed the display preference or weaken the prefill assertions. Every workflow uses isolated synthetic fixture data and local-only requests. The full `npm test` suite was not run because it includes repository-writing build tests and parent-owned work in progress; both new test files are nevertheless included in its existing `test/**/*.test.mjs` glob.

Follow-up image audit found no `FileReader`, `readAsDataURL`, `createObjectURL`, file-upload control or local-image preview in the current contribution implementation/application JS. Organization logos use the self-hosted logo map. Therefore no unused `data:`/`blob:` image scheme was added. If a requested local preview is later introduced, review and permit only the required `img-src` scheme, not scripts or connections.

### Edge Check and Remaining Limits

An opt-in test fetches only the public Privacy HTML, overlays the proposed CSP in an isolated browser, supplies application assets from the local checkout and blocks every production API/analytics/secondary-document request. It also strips NEL/reporting response headers in that test context to avoid provider reports. It makes no origin/provider configuration change. Both attempts timed out while reading the edge document (one had received HTTP 200 headers); therefore actual edge-injected beacon blocking is **not yet verified**. The offline injected-tag and real application tests are not evidence of deployed-edge behavior.

```powershell
$env:BENCHPOLL_LIVE_CSP_CHECK = '1'
node --test --test-name-pattern='actual edge-injected' test/privacy-headers.test.mjs
Remove-Item Env:BENCHPOLL_LIVE_CSP_CHECK
```

- No `challenges.cloudflare.com` exception was added. A challenge, Turnstile, Rocket Loader, email obfuscation or Zaraz dependency needs separate evidence and narrowly scoped changes; Zaraz can rewrite origin policies. This work does not claim to disable provider server-side analytics, access logs or edge-generated reporting headers.
- `script-src 'self'` permits same-origin provider scripts; `connect-src 'self'` permits same-origin `/cdn-cgi/rum`. HTTPS images preserve the current broad avatar contract, so image-based tracking is not categorically blocked. CSP is not a consent system or a defense against every same-origin script.
- Inline pins must be reviewed when rebuilding changed startup code. No runtime auto-pinning, script `unsafe-inline` or broad third-party allowance is provided. A stricter existing CSP still intersects and may need its own compatibility review.
- A native browser menu's final choice cannot be observed: opening a context menu on a prefilled anchor prepares only that selected handoff, even if the user then cancels. Merely rendering, focusing, hovering, pressing down or dispatching an untrusted synthetic click does not persist it. This explicit user-action boundary preserves native open/copy/new-tab behavior.
- Existing click-only template creation in `home.js` (Beta) and `legal.js` (privacy request) is unchanged; those callers do not create their template on middle/context-menu events. This pre-existing limitation is separate from prebuilt anchors, which retain their handoff across those actions.
- Unactivated URLs now refer to page-memory entries and are not portable after the source document closes/reloads. A requested activation persists the chosen token for reuse across tabs. This is the intended minimization tradeoff.
- Thirty minutes is an access expiry, not an automatic physical deletion timer. Expired old/selected records are removed on a later activation; requested per-tab sessions last until their tab/session ends. Other browser preference/draft stores are outside this change.

## Follow-Up Context Map: VM Harness Compatibility

The parent requested this additional scope after the privacy implementation. Reviewed current guard registrations and reproduced failures before edits: `test/fixed-score-contributions.test.mjs` and `test/personal-pie-save.test.mjs` raise `ReferenceError: requireCurrentTermsForAPI is not defined`; `test/account-identity.test.mjs` rejects the new auth/owner/terms/handler registration order.

| File | Minimal change |
| --- | --- |
| `scripts/review-write-replay-20261008.mjs` | Pass-current-terms middleware fixture; retain actual owner guard and verify all four registered callbacks. |
| `scripts/review-moderation-transactions-20261008.mjs` | Same fixture/order compatibility for business transaction probes. |
| `scripts/review-moderation-replay-20261008.mjs` | Same fixture/order compatibility for moderation replay probes. |
| `scripts/review-transaction-cleanup-20261008.mjs` | Define the terms prerequisite when evaluating extracted handler registrations. |
| `test/fixed-score-contributions.test.mjs` | Define the terms prerequisite in the business-handler VM context. |
| `test/personal-pie-save.test.mjs` | Pass terms only in the isolated HTTP fixture; retain real auth/owner/idempotency behavior. |
| `test/account-identity.test.mjs` | Allow the terms middleware only after owner; preserve strict auth/owner ordering checks. |

Dependencies/tests: `test/write-idempotency.test.mjs`, `test/moderation-transactions.test.mjs`, `test/moderation-replay.test.mjs`, `test/transaction-cleanup.test.mjs` use the four harnesses. Other reviewed direct VM route contexts exercise read-only endpoints without the new terms guard and require no changes. No production guard, backend, real privacy-gate tests, feedback-template tests or legal tests are in this follow-up ownership. Parent retains `test/privacy-controls.test.mjs`. This map was reviewed before harness edits.

The updated business harnesses use explicit pass-current-terms fixtures. Harnesses which invoke middleware still execute the real account owner guard and assert `[role/auth, owner, terms, handler]`; the account-identity registration matcher allows an optional terms guard only after owner and rejects reversed auth/owner or terms/owner order. Nothing removes, reorders or weakens the production terms guard.

## Changed-File Handoff

This is the exact file list changed by this task, including the expanded caller/harness authorization. Existing unrelated changes in these files were preserved. Runtime release must include `privacy-headers.js`, the shared navigation module **and** `public/js/contribute.js`; the parent's existing `server.js` mount is an additional parent-owned integration change. Build/generated artifacts were not rewritten here.

```text
privacy-headers.js
public/js/shared/contribution-navigation.js
public/js/contribute.js
test/privacy-headers.test.mjs
test/contribution-navigation.test.mjs
scripts/review-write-replay-20261008.mjs
scripts/review-moderation-transactions-20261008.mjs
scripts/review-moderation-replay-20261008.mjs
scripts/review-transaction-cleanup-20261008.mjs
test/account-identity.test.mjs
test/fixed-score-contributions.test.mjs
test/personal-pie-save.test.mjs
docs/privacy-minimization-20261017.md
```

No remaining caller adaptation is known. Remaining release decisions are the inline-hash/build gate, real edge/challenge verification, server/provider logging and consent/retention duties described above. No broad Cloudflare exception, new image scheme, provider setting, database write or deployment was introduced. After final verification this task stops file writes so the parent can freeze the shared checkout.

## Primary Technical References

- [W3C Content Security Policy](https://www.w3.org/TR/CSP3/): enforcement, script hashes, source matching and multiple-policy intersection.
- [Cloudflare data origin and collection](https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/): analytics script origin.
- [Cloudflare CSP behavior](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/content-security-policies/): origin policies and edge products, including Zaraz policy rewriting.
- [Cloudflare cdn-cgi endpoint](https://developers.cloudflare.com/fundamentals/reference/cdn-cgi-endpoint/): same-origin analytics endpoint.
- [W3C Referrer Policy](https://www.w3.org/TR/referrer-policy/): same-origin referrers without cross-origin referrer disclosure.
