# Topic Proposals Hall UI (2026-10-27)

## Context Map

Reviewed again for the 2026-10-28 limits contract before implementation.

| Owned file | Purpose |
| --- | --- |
| `private/topic-proposals.html` | Public, usable proposal hall and proposal dialog |
| `public/js/topic-proposals.js` | Validated reads, guarded writes, account integration, draft lifecycle |
| `public/css/topic-proposals.css` | Compact list and responsive dialog layout |
| `test/topic-proposals-ui.test.mjs` | Payload, response and source contracts |
| `test/topic-proposals-ui.browser.mjs` | Real headless browser interactions and screenshots |
| `test/fixtures/topic-proposals-server.mjs` | Strict local-only API/static fixture |
| `scripts/frontend/topic-proposals-ui.mjs` | Scoped test runner and loopback-only in-memory preview |

Dependencies are read-only: `shared/http.js`, `shared/write-intent.js`,
`shared/account-identity.js`, `shared/sign-in.js`, `shared/account-center.js`,
`shared/profile-editor.js`, `shared/topics.js`, `shared/ui-components.js`,
the shared palette, typography, controls and local Font Awesome assets.
Reference patterns: `topics-home.js`, `test/sign-in.browser.mjs`,
`test/fixtures/sign-in-server.mjs`. API authority:
[`topic-proposal-limits-20261028.md`](topic-proposal-limits-20261028.md)
supersedes the original API contract for limits, deadlines and mutations.
No shared files, server routes, database, homepage, README or deployment changes.

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Inspect Topic proposals and explicitly manage collecting proposals and supports |
| Primary user and action | Visitors browse; eligible accounts manage 3 active supports and 1 collecting proposal |
| Content hierarchy | Topic proposals heading, concise collection rules, account quotas, newest-first list with deadlines, manual pagination |
| Navigation and controls | Existing brand/home and account entries; one Propose a Topic entry; Your proposal opens the supplied active record without pagination; native edit and withdrawal dialogs; Font Awesome owner actions |
| Visual language | Existing Manrope, palette, shared action/input primitives; unframed list with neutral dividers; Font Awesome state/action icons; no hero, author identity, decorative media, accent edges, or radius above 8px |
| Required states | Loading, empty, read error/retry, open/pending/approved/rejected/expired/withdrawn, quota reached, guest/account error/account changed, pending writes, revision conflict, validated success, recoverable write errors |
| Responsive behavior | Constrained desktop content; 320px list remains readable; support controls wrap below content; dialog scrolls within viewport and retains accessible actions/focus |
| Evidence used | Existing BenchPoll hall/account/control patterns are authoritative. Public UIZZE catalogue was checked, but no applicable screen evidence was available; no external layout or branding is copied |
| Forbidden defaults | Marketing hero, nested cards, decorative gradients, accent stripes, author names/avatars, sorting absent from API, privacy checkbox, visibility control, payment/sponsorship UI, optimistic/automatic writes |
| Acceptance criteria | Exact account and CSRF binding; retained write identity for uncertain retries; no automatic writes after sign-in or revision conflicts; deadline never extended by edits; edit resets supports; every success refreshes loaded rows and quotas without losing scroll, focus or unrelated drafts; real desktop/mobile keyboard and screenshot checks |

## API And Safety

- POST `/api/get_topic_proposals` with `{}` or `{before: nextCursor}` only.
  Validate `{authenticated, proposals, nextCursor, threshold: 30, limits, account,
  activeProposal}` before rendering. Limits must be exactly 3 supports, 1 collecting
  proposal and 14 days. `activeProposal` must agree with `account.activeProposalID`,
  belong to the signed-in account and be open. Guests have neither account nor
  active proposal metadata. Other authors' identities are stripped.
  Legacy over-limit support totals remain readable, but cannot enable new support.
- POST `/api/propose_topic` with `{name, description, csrfToken, expectedUserID}`.
  Required NFC-normalized summary is at most 180 Unicode codepoints; name at most 128.
- POST `/api/vote_topic_proposal`, `/api/cancel_topic_proposal_support` and
  `/api/withdraw_topic_proposal` with `{proposalID, revision, csrfToken,
  expectedUserID}`. POST `/api/edit_topic_proposal` adds `name` and `description`.
  Positive revisions, strict ISO UTC deadlines and all capability flags are
  validated. Never self-support or change support/content after collection closes.
- Content edits reset all supports and increment revision without extending the
  original deadline. No-op edits retain both supports and revision. The editor
  states this distinction truthfully. Withdrawal requires explicit confirmation;
  a pending write cannot be dismissed or submitted twice.
- Every mutation uses `pageAccountWriteScope.write` and `postWriteJSON`, with
  response validation inside the retry transport. Keep the same CSRF token,
  revision and payload for an uncertain retry. Refresh security state only after
  definitive CSRF expiry. Mutation responses are bare proposal records, not quotas.
- Same-key server replay returns the current record and does not reapply an old
  intent. Changed content/revision triggers a read refresh, never an automatic
  vote on a new version. Edit conflicts keep the draft and require explicit
  "Review latest version", display the current text for comparison, and still
  require a separate Save edits action. Replays may contain fresh supports or a
  now-closed status; success does not rely on a monotonically increasing count.
- Successful mutations re-read all already-loaded feed pages and account quotas.
  The old visible list remains until every refreshed page validates. The visible
  row anchor, keyboard focus and unrelated drafts are preserved. A failed refresh
  keeps confirmed rows but disables writes until quotas are confirmed again.
- `activeProposal` is independent of the feed cursor. Your proposal opens its
  editor directly, including withdrawal, even when it is older than loaded rows.
  It is not prepended or duplicated in the community feed, and no pagination
  search is performed to locate it.
- The 14-day deadline is displayed using `<time datetime="...">` and the user's
  local time format. A timer disables collecting actions at the deadline and
  refreshes the now-freed quota. Open/pending/approved/rejected/expired/withdrawn
  each have distinct text and icons. Pending and closed records consume no quota.
- Read `/api/get_user_profile` to bind the exact string account ID. Get CSRF from
  `/api/get_privacy_status` and verify it belongs to that same account. Account
  replacement blocks writes instead of silently rebinding or reloading.
- Shared popup sign-in and account-change notifications preserve the modal and
  session-local draft. Create drafts and account/proposal-scoped edit drafts are
  separate, with an in-memory fallback when session storage is blocked. Popup-
  blocked navigation can restore a persisted draft. Sign-in completion only
  refreshes reads; another explicit mutation is required.
- Server strings are rendered as text; only approved, validated local Topic URLs
  become links. Ordinary proposal and Topic creators are never rendered.
- The dialog contains exactly: "You will receive the review result by email. We
  will use the verified address linked to your GitHub account."

## Verification

- `node scripts/frontend/topic-proposals-ui.mjs`: **78/78 passed** after the final
  2026-10-28 contract extension (12 unit/source tests and 66 real headless browser
  scenarios). Chromium and WebKit both cover 1440x1000, 768x900, 390x844 and
  320x568 layout/dialog checks; lifecycle/limits run on desktop and mobile, and
  off-page author management additionally runs at 320x568 in both engines.
- `node --test test/topic-proposals-ui.test.mjs test/sign-in.test.mjs test/account-write-transport.test.mjs test/account-identity.test.mjs`:
  **31/31 passed**, including 19 shared identity/transport/sign-in regressions.
- Scoped ESLint passed for the Hall module, both test files, fixture and runner.
- Visually inspected refreshed mobile hall, desktop WebKit hall and the short-
  screen 320px WebKit off-page editor. No clipped controls, incoherent overlaps,
  accent-sided decoration or missing brand/icon assets. The skip link is clipped
  when unfocused; keyboard focus remains visible. Dialog Tab trapping, Escape,
  confirmation cancel and restored opener/list-row focus are browser-tested.
- Browser diagnostics reject unexpected console errors, CSP violations, HTTP
  failures, unknown fixture payloads and all external traffic. Local fixtures
  enforce revision, capability, quota and exact-account request contracts.
- Coverage includes Unicode limits; all six collection states; exact deadline
  cutoff; 3-support/1-proposal quotas; cancellation and explicit replacement;
  edit/reset/unchanged expiry; no-op editing; confirmed withdrawal; off-page
  active management; current-state same-key replay; stale-revision review;
  scroll/focus preservation through multi-page refresh; read failure recovery;
  separate drafts with blocked storage; popup sign-in; account replacement;
  CSRF/legal/email errors; malformed responses and single-flight writes.
- Screenshots: `D:/Codex-artifacts/website1/topic-proposals-20261028/`.
  Dialog captures use the actual viewport; list captures include the full list.
- Local preview: `node scripts/frontend/topic-proposals-ui.mjs --serve` prints an
  automatically allocated loopback URL. Data is fixture-only and in memory;
  the popup completes local sign-in without visiting GitHub. The default runner
  closes every fixture and browser; no detached preview is left running.

Production API integration and route/deployment verification remain parent-owned.
No live content, production API, OAuth provider or database was contacted.
