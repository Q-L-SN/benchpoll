# Account Privacy UI (2026-10-17)

Final verification and handoff freeze: **2026-10-18**. The legal versions remain
`2026-10-17`, matching the current parent implementation; they are not changed to
the verification date.

## Context Map

Reviewed before implementation on the existing non-main, dirty worktree. Existing
changes are outside this task's ownership and must remain intact.

### Files to Modify

| File | Purpose | Changes |
| --- | --- | --- |
| `private/account-privacy.html` | Publicly accessible account/privacy settings | Explicit sign-in confirmations, optional research, anonymous requests, collapsed senior queue |
| `public/js/account-privacy.js` | Page controller | Status/CSRF, exact account binding, safe redirects, validated responses, private queue handling |
| `public/css/account-privacy.css` | Page layout | Restrained responsive settings sections and accessible focus states |
| `test/account-privacy-ui.test.mjs` | Focused unit/markup tests | Validation, redirects, consent and source contracts |
| `test/account-privacy-ui.browser.mjs` | Real-browser tests | Complete guest/account/request workflows and layout |
| `test/fixtures/account-privacy-server.mjs` | Local-only fixture | Serve real assets and isolated mock APIs; no application database |
| `docs/account-privacy-ui-20261017.md` | Context and handoff | Contracts, verification and integration boundaries |

### Dependencies (Read Only)

| File | Relationship |
| --- | --- |
| `public/js/shared/http.js` | Existing JSON POST, JSON-response enforcement and timeout |
| `public/js/shared/account-identity.js` | Existing page-scoped exact string owner protection |
| `public/js/shared/ui-components.js` | Shared field/action enhancement |
| `public/css/global.css`, `public/css/site-palette.css`, `public/css/typography.css` | Existing reset, tokens, controls and local fonts |
| `public/vendor/fontawesome/css/all.min.css` | Existing icons |
| `privacy-headers.js` | Actual middleware executed by the browser fixture on HTML, APIs and static assets |
| `privacy-controls.js` | Parent implementation read for contract parity; pure validators tested without its database |
| `server.js`, `public/js/global.js` | Parent-owned route/API/login integration, not edited here |
| `private/terms.html`, `private/privacy.html`, `public/js/shared/contribution-navigation.js` | Other-agent-owned legal/navigation integration |

### Reference Patterns

| File | Pattern |
| --- | --- |
| `docs/ui-components.md` | Shared action/field primitives, quiet secondary links, no accent stripes |
| `test/account-identity.test.mjs` | Exact large IDs and stale-account write rejection |
| `test/fallback-picker-state.browser.mjs` | Isolated real-browser interaction tests |
| `private/privacy.html`, `private/how-it-works.html` | BenchPoll branding, local fonts and existing icon library |

### Risk Review

- No database, migration, dependency, shared-helper or deployment changes.
- New APIs and the anonymous GET route are parent-owned prerequisites.
- An HTTP success alone is not a confirmed consent/preference save: validate the
  returned status and requested values. A privacy request needs a reference.
- Never derive account ownership or redirect destinations from query parameters.
- A lost response can leave a request's outcome unknown. Do not automatically
  replay writes or claim email delivery/deletion.

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Review account terms, make a separate research choice, submit a request without GitHub, or handle it as an authorized senior |
| Primary actions | Continue with GitHub for guests; explicit Terms/preference save for members; independent request submission |
| Hierarchy | Account state and short processing notice, confirmations/preferences, request form, operator details |
| Controls | Native unchecked confirmations and optional research checkbox; five request-type radios; shared actions/fields and Font Awesome |
| Visual language | Existing BenchPoll logo, Manrope, neutral dividers, unframed sections, restrained existing accent |
| Required states | Loading, retryable failure, unauthenticated, current/outdated terms, pending, confirmed save, blocked account switch, recorded request, senior queue/permission loss |
| Responsive behavior | Two-column section labels/content on desktop; one column at narrow widths; wrapping labels and 44px touch rows |
| Forbidden defaults | Hero, nested cards, decorative one-sided accent borders, auto-save, prechecked new-account consent, external input focus halo |
| Acceptance | Guest request works without OAuth; no writes on load; no unconfirmed success; exact owner/CSRF; no text loss on retry; no overflow at 320px |

The concrete references are the repository's shared UI contract and existing
pages. UIZZE catalogue searches found [LinkedIn's sharing prompt](https://uizze.com/screens/699c74cb001ecb87f310),
[X's display settings](https://uizze.com/screens/9ed6c008075fc7672b5bae49c4be1dbc)
and [Canva settings](https://uizze.com/screens/345fc4149fafbd7766b1aeb03a36cb31).
All three detail fetches returned HTTP 410; no visual inspection of these
references is claimed, and no third-party styling is copied.

## Integration and Verification

### Routes and APIs

The parent registration for anonymous `GET /account/privacy` and all seven POST
APIs was inspected after implementation. This task does not change those
registrations. Incoming navigation to `/account/privacy#request` targets the
request section. Policy links use existing `/privacy#providers` and
`/privacy#operator` IDs, not nonexistent `international`/`contact` anchors.

| POST API | UI behavior |
| --- | --- |
| `/api/get_privacy_status` | Sends `{}`; validates exact string/null account ID, boolean `authenticated`/`isSenior`, supported versions, acceptance, research preference and CSRF; never reads owner IDs from the URL |
| `/api/prepare_github_login` | Sends CSRF, current terms/privacy versions, explicit `acceptedTerms: true`, `eligibleAge: true`, separate research boolean; only the credential-free HTTPS `github.com/login/oauth/authorize` endpoint is allowed |
| `/api/accept_legal_terms` | Same business payload through `pageAccountWriteScope.write`, adding transport `expectedUserID`; validates returned owner, accepted state and preference before reporting success |
| `/api/save_privacy_preferences` | Explicit preference save with CSRF and exact owner metadata; validates returned preference; withdrawal is not gated by acceptance of current Terms |
| `/api/submit_privacy_request` | CSRF, trimmed email (maximum 254, dotted domain), request type and trimmed 1..4000-character message; no owner metadata; only a nonempty returned reference confirms receipt |
| `/api/list_privacy_requests` | Lazy load on opening senior-only disclosure, then explicit refresh/more; CSRF, exact senior owner metadata and optional opaque `before`; preserves backend created-descending order and deduplicates page overlap by reference |
| `/api/update_privacy_request` | CSRF, exact senior owner metadata, reference, status and resolution up to 2000 characters; closing requires nonblank resolution; only `{updated:true}` confirms a save |

Queue records use `textContent`/native textarea values, including email, message
and handling record. No request content is interpolated as HTML. Subject account
IDs in queue records are never bound as the reviewing senior's identity. Queue
access and updates do not require accepting new Terms. Losing senior access or
detecting an account change hides and clears queue content. Both endpoints still
require the parent's authoritative senior/owner/CSRF checks.

The backend's `due_at` is a **28-day internal review target**, not a uniform
statutory deadline. Both queue rows and metadata say **Review by (internal
target)**; a visible note explains that legal deadlines depend on applicable
law. `dueAt` remains the unchanged API field. Fixture examples use 28-day targets.

`operator.identityPending` is retained and defaults conservatively to pending
when absent. The API's public account name (currently `Q-L-SN` without configured
legal identity) is explicitly labeled **Public operator account**, followed by
**Legal operator identity is pending**. No legal name or active contact email is
invented. A missing email remains a visible limitation, not a fake mailto link.

### Persistence and Failure Handling

- Nothing is submitted on load except the status read. Research/terms/age are
  not silently saved; new-account checkboxes begin unchecked.
- Research refusal does not block login. Age confirmation is 16+ **and** legal
  eligibility; there is no birthdate, password or identity-document field.
- No automatic browser draft storage. Request text and queue editor drafts stay
  in document memory only; an explicit full reload can discard them.
- A timeout, transport failure, HTML response or unconfirmed JSON response never
  becomes success. User text and choices stay intact for explicit retry.
- A 403 refreshes account/security status without replaying the action or
  clearing a request draft. Account-switch errors block later account writes
  while the independent request form remains usable with current security state.
- A confirmed request keeps its contents and reference visible and prevents an
  unchanged accidental repeat in normal form use. There is no automatic erasure
  or claim that mail was delivered. A lost response may still represent a
  recorded request; the UI warns about this uncertainty before retry.
- Senior handling explicitly requires manual follow-up through a verified
  contact channel. An entered contact address is labeled unverified; changing a
  queue status neither verifies it nor sends email or deletes data.

### Commands and Results

```powershell
node --test test/account-privacy-ui.test.mjs test/account-privacy-ui.browser.mjs
.\node_modules\.bin\eslint.cmd public/js/account-privacy.js test/account-privacy-ui.test.mjs test/account-privacy-ui.browser.mjs test/fixtures/account-privacy-server.mjs
```

Final result: **36 passed, 0 failed**: 10 validation/markup/parent-parity tests and
26 real Chromium checks (Chromium 151.0.7922.34). Changed JavaScript/test lint
passed. The explicit browser command is needed because `.browser.mjs` is not in
the repository's default `*.test.mjs` glob. The whole repository test suite was
not rerun by this scoped UI task.

Rechecked on 2026-10-18 against current `privacy-controls.js` and `server.js`:
all seven API names/payloads, `isSenior`, `operator.identityPending`, exact string
owner metadata, CSRF transport, current legal versions, message/email limits,
queue cursor and closed-resolution requirement agree. The parent-parity test
also generates an actual 43-character CSRF token with `ensurePrivacyCSRF`,
passes it through the UI payload and verifies it with `assertPrivacyCSRF`, then
validates that payload with the real `validateLegalChoice` and synthetic document
hashes. This does not open a database or operate an account. Queue routes and
preference withdrawal remain independent of current-Terms acceptance.

The browser fixture serves the **actual HTML/JS/CSS and local visual assets** and
executes the actual `privacyHeaders` middleware, not a copied policy string. It
asserts the enforced CSP/nosniff headers and records **zero CSP violations** in
each page. External network requests are intercepted; GitHub navigation is
fulfilled locally in the redirect test. Application APIs are isolated in-memory
fixtures using the real owner guard. No application database, deployment, real
GitHub exchange, outbound email or external service write is involved.

| State | 1440x1000 | 390x844 | 320x780 |
| --- | --- | --- | --- |
| Guest | Pass | Pass | Pass |
| Authenticated, current Terms accepted | Pass | Pass | Pass |
| Authenticated, old/unaccepted current Terms | Pass | Pass | Pass |
| Senior, current Terms unaccepted | Pass | Pass | Pass |

All 12 state/viewport combinations check default unchecked confirmations,
appropriate Terms/queue visibility, anonymous-capable request submission, text
retention after failure **and** success, no horizontal overflow, no checkbox/
label collision, 44px email field, keyboard focus, no exterior input outline or
shadow, loaded local logo and local font. Workflow tests additionally cover
required independent confirmations, research refusal, exact large IDs despite
misleading owner query parameters, stale-owner blocking, in-place CSRF recovery,
unsafe/missing redirects, rate-independent server errors, transport/non-JSON
errors, pending/missing-reference responses, queue pagination, literal HTML-like
request content, non-senior denial, permission loss, unsaved editor retention,
required closure records and unconfirmed queue updates.

### Screenshot Evidence

**27 current screenshots** (full page and first viewport for each combination,
plus three focused senior-queue captures)
are written to:

`C:/Users/18665/AppData/Local/Temp/benchpoll-account-privacy-20261017/`

Names: `{guest,authenticated,old-terms,senior}-{1440,390,320}.png` and matching
`-viewport.png` files. Earlier exploratory `senior-768.png` may also remain;
it is not counted in the final matrix. Focused files are
`senior-{1440,390,320}-queue.png`, making the internal-target label visible without
scrolling through a full-page capture.

Visually reviewed final examples include `guest-1440-viewport.png`,
`authenticated-390-viewport.png`, `old-terms-320-viewport.png` and senior full-page
evidence. They show the existing logo, unframed settings sections, neutral
dividers, no accent stripe, wrapping content and visible keyboard focus.

### Local Preview and Boundaries

A local, in-memory senior preview was left running at
`http://127.0.0.1:55462/account/privacy` (PID `36164`). It is **not** the application
server: records are synthetic and changes are memory-only. The fixture can also
be started in guest mode with:

```powershell
node test/fixtures/account-privacy-server.mjs --serve
```

Add `--senior` for the private queue, and optionally `--port <port>`. The process
prints its local URL and can be stopped normally; the launched preview can be
stopped with `Stop-Process -Id 36164`.

Unresolved product/release prerequisites are the real legal operator identity,
an active privacy contact channel, the parent's migrations/backend deployment,
and actual operational follow-up/retention procedures. No compliance
certification, delivery capability or completed production integration is
claimed. A future legal version change must update the page's supported version
alongside the notices/API. Only the seven scoped new files above were edited;
shared helpers, legal pages, backend, navigation, README and existing dirty
changes were not modified by this task.

## Frozen Handoff

The final resumed run on 2026-10-18 again passed **36/36** tests and changed-file
lint after the internal-target wording and 28-day fixture correction. All 27
current screenshots were regenerated. The focused 320px senior-queue screenshot
was visually reviewed and shows both the internal-target label and the
applicable-law caveat without clipping or horizontal overflow.

The six implementation/test files below are frozen at these SHA-256 values.
This document is the seventh scoped file and is finalized with this handoff; it
deliberately has no self-hash. Parent can hash all seven files for integration.
No read-only attributes, git commit, deployment or real-account operation was
performed as part of the freeze.

| File | SHA-256 |
| --- | --- |
| `private/account-privacy.html` | `220AE11F24D95B07ED1C7D2F66AC3CCE67A41B650BA8C282475FC093DA02B3AA` |
| `public/js/account-privacy.js` | `7CECE30159F302494D7463520C43C9A6BCADEB545DC6D76EFA5D42E0D801DAA9` |
| `public/css/account-privacy.css` | `9472A021CE029211FE85CC4FEC32180DBB77E79880A06F2CB2F420313FEB8324` |
| `test/account-privacy-ui.test.mjs` | `3A3DA55D9800B1475DFE78BC1863896673A7C90DCD7BA8FB7737D5F27BD562EF` |
| `test/account-privacy-ui.browser.mjs` | `A8341867D310F90D65D59AD3FDF1381F98A26B27716ABBBD05F58A40E81A98A1` |
| `test/fixtures/account-privacy-server.mjs` | `FF141073FC9D1974A7D97D2EEF2B1A80C24E00214BD1318A2692121AA21F4E07` |
