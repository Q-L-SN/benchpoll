# Discussion Auto-Loading (2026-10-16)

## Context Map

Reviewed before implementation. This change is limited to discussion reads,
an isolated paging helper, focused tests, and this document.

### Files to Modify

| File | Purpose | Changes Needed |
| --- | --- | --- |
| `public/js/discussion.js` | Discussion panel, feeds, replies, and drafts | Automatic sequential paging, cancellation, retry, and `data-view` |
| `public/js/shared/discussion-auto-load.js` | New small sentinel helper | Observe the actual panel scroll root and recheck geometry before paging |
| `test/discussion-auto-load.test.mjs` | New isolated tests | Geometry, pagination guards, stale reads, errors, and zero progress |
| `test/panel-read-lifecycle.test.mjs` | Existing read-deadline harness | Supply the new loader dependencies without changing deadline coverage |
| `test/benchmark-discussion-scope.test.mjs` | Existing scope/draft harness | Supply the paging helper, abort controller, and shared-action fixture |
| `scripts/frontend/discussion-auto-load-20261016.mjs` | New browser fixture check | Desktop/mobile scrolling, races, retries, replies, and write/draft safety |

### Dependencies (Read-Only)

| File | Relationship |
| --- | --- |
| `private/home.html` | Supplies `.discussion-scroll`, `discussion-more`, and feed/thread elements; parent-owned |
| `public/css/discussion.css` | Determines panel scrolling and thread layout; parent-owned |
| `public/js/shared/http.js` | Supports the existing 60-second timeout and caller abort signals |
| `public/js/shared/account-identity.js` | Keeps account-bound writes protected |
| `public/js/workspace/benchmark-scores.js` | View changes suspend and resume discussion paging |
| `discussion-service.js` | Existing offset-based, 20-result read API; unchanged |
| `scripts/frontend/server.mjs` | Local synthetic fixture server; unchanged |

### Test Files and Reference Patterns

| File | Coverage / Pattern |
| --- | --- |
| `test/panel-read-lifecycle.test.mjs` | Actual loader extraction, timeout, and ignored late transport completions |
| `test/benchmark-discussion-scope.test.mjs` | Existing category/benchmark scope contracts |
| `scripts/frontend/benchmark-discussion-scope.mjs` | Browser routing, held responses, local fixture safety, and viewport checks |
| `scripts/frontend/discussions.mjs` | Synthetic post shape and account-aware fixture responses |

### Risk Assessment

- No public API changes, database migrations, or configuration changes.
- Existing dirty-worktree edits are preserved.
- No production reads, production writes, deployment, or release packaging.
- Main risks: obsolete reads after view changes, duplicate appends, hidden-root
  paging, and retry loops. Focused unit and browser checks cover these paths.

## Behavior

- The existing `discussion-more` button is both the sentinel and the explicit
  retry control. No markup is required by the paging implementation.
- An IntersectionObserver uses the panel's own `.discussion-scroll` element,
  with 160 pixels of bottom prefetch. Coalesced animation-frame checks inspect
  current geometry; observer records alone cannot trigger a stale load.
- Scroll and resize listeners also schedule checks. IntersectionObserver and
  ResizeObserver are optional; the scroll/resize fallback is tested in isolation.
- The existing read API and its 20-result offset pages are unchanged. The next
  batch starts only after the previous one settles and the actual sentinel is
  still near the panel bottom. Raw result counts advance the offset; post IDs
  prevent duplicate DOM entries. Empty or entirely duplicate batches stop paging
  even if the response advertises `hasMore`.
- Replacement reads abort obsolete work and retain the sequence check for
  transports that ignore aborts. Close, opening another discussion, and entering
  all-scores retire in-flight reads immediately. Information-only panels never
  request discussion pages. Returning from all-scores resumes an interrupted
  first read or enables paging from the existing offset.
- A read error pauses automatic loading. The same button says `Retry` and retries
  the failed first page or append offset only after an explicit click. Changing
  away from and back to all-scores does not bypass that error latch.
- Status text is `Loading discussions...`, `Loading replies...`, `Load more`, or
  `Retry`. Busy state and the button's polite live region are updated together.
  There is no polling, realtime push, or background feed refresh.
- `panel.dataset.view` is `feed` or `thread`; original/reply articles receive
  `is-root` / `is-reply`. Post metadata omits neutral task options and empty
  option badges, while all-category views retain the category name.
- Votes, reply links, permalinks, reports, and deletion use the existing shared
  quiet-action helper. Permalinks retain their title and accessible name, reports
  and deletion remain icon-only, and existing callbacks/account guards remain.
- Draft snapshots, account-bound writes, mention handling, and the existing
  60-second read deadline are preserved. Appending does not rebuild the composer
  selectors, filter options, or root article, which avoids discarding focused
  controls or the root's deletion confirmation.

## Verification

### Focused Regression Tests

```powershell
node --test --test-reporter=dot test/discussion-auto-load.test.mjs test/panel-read-lifecycle.test.mjs test/benchmark-discussion-scope.test.mjs test/discussion-service.test.mjs test/account-identity.test.mjs test/account-write-transport.test.mjs test/guest-drafts.test.mjs test/privacy-mobile.test.mjs test/content-motion.test.mjs test/quiet-actions.test.mjs
```

Result: 94 passing tests. Coverage includes actual loader execution in
isolation, request deadlines, hidden/offscreen geometry, observer coalescing,
fallback listeners, concurrent appends, zero progress, retries, view cancellation,
scope/context changes, reply classes, draft retention, and stale account isolation.

### Real Browser Fixture

```powershell
node scripts/frontend/discussion-auto-load-20261016.mjs
```

The script starts and closes its own loopback-only synthetic preview. It blocks
all writes before they reach the fixture server. One intentional submission is
rejected locally to check draft retention and expected account identity. An
ignored-abort transport fixture allows held old responses to arrive after newer
requests, including a check that old finalizers cannot clear the new busy state.

Default matrix: Chromium 1440x900, 390x844, and 320x740; WebKit 390x844.
`UI_TEST_ENGINE` and `UI_TEST_WIDTH` can narrow the run.
`DISCUSSION_AUTO_LOAD_OUTPUT` overrides the output directory, which defaults to
`D:/Codex-artifacts/website1/discussion-auto-load-20261016`.

The fixture checks ordinary/category and benchmark feeds, all-category scope,
20/40/45-result reply pagination, sort/filter/workspace changes, close/reopen,
all-scores suspension, first-page and append retries, duplicate/empty responses,
short pages, account-change write blocking, private information-only panels,
and horizontal geometry. The short-page fixture intentionally returns two
results per batch to exercise sequential filling without reading offscreen pages.
It saves feed/thread screenshots and a structured `verification.json` report.

WebKit uses the existing browser-fixture pattern of buffering loopback responses
through Playwright routing; direct continued responses did not initialize the
page in this Windows WebKit environment. This is a test-only transport adapter.

Final matrix result: all four configurations passed all 13 browser checks
(52 checks total), including preservation of the actual composer selector nodes
after automatic appends. Chromium used 46 fixture reads per viewport; WebKit used
45. Every configuration had zero page errors and zero real writes. The
`verification.json` report and feed/thread screenshots are in the output directory.

Syntax checks, scoped ESLint, and scoped `git diff --check` passed.
