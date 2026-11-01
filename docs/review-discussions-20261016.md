# Discussion Correctness Review, 2026-10-16

## Scope and Safety

- Workspace: `C:/Users/18665/Documents/website1`.
- Branch: `refactor/frontend-modules-20260905`; base commit:
  `d1511a7e0b7eed08f7b0d5ca9bd09c280c8c08ed`.
- Runtime: Windows PowerShell, Node `v22.22.1`, repository lockfile.
- The worktree was already dirty, including discussion code and tests. Preserve
  all existing and concurrent edits; only add the review's focused changes.
- No deployments, production database connections, real messages, migrations,
  release scripts, CSS edits, or changes to `server.js`, `db.js`, or
  `public/js/home-workspace.js`.

## Context Map

### Owned Implementation and Tests

| File | Purpose | Review / Potential Change |
| --- | --- | --- |
| `discussion-service.js` | Validates and lists/posts/votes/deletes discussions in transactions | Read visibility, filter predicates, thread identity, reply ordering, and posting failures; change only reproduced defects |
| `public/js/discussion.js` | Panel state, drafts, thread navigation, writes, and read pagination | Reproduce cross-thread write completions, replacement-read failures, draft/error retention, and long-thread posting |
| `public/js/shared/discussion-auto-load.js` | Coalesced sentinel visibility checks | Review geometry, cancellation, and retry integration; no speculative rewrite |
| `test/discussion-auto-load.test.mjs` | Executes actual panel source in an isolated DOM/transport harness | Add held-write, thread-switch, error, and pagination reproductions without real requests |
| `test/discussion-service.test.mjs` | Isolated service and transaction checks | Extend focused service coverage where an actual defect is established |
| `test/discussion-replies.test.mjs` | Reply layout/action contracts | Existing regression coverage; no presentation changes planned |
| `scripts/frontend/discussion-auto-load-20261016.mjs` | Loopback-only paging browser regression | Wait for read completion even when a deliberately empty feed has zero height |
| `docs/review-discussions-20261016.md` | This review's context, findings, and evidence | Record pre-fix failures, exact changes, outcomes, and any outside-owner integration |

### Dependencies (Read-Only)

| File | Relationship |
| --- | --- |
| `ranking-service.js` | `resolveRankingContext` resolves public categories and canonical task options |
| `benchmark-condition-visibility.js` | Shared selectable-condition SQL predicate |
| `db-transaction.js` | Service transaction lifecycle and failure cleanup |
| `public/js/shared/http.js` | JSON error shape, caller aborts, and 60-second read deadlines |
| `public/js/shared/account-identity.js` | Shared account binding and account-bound write protection |
| `public/js/shared/context-selection.js` | Hierarchical composer option selection |
| `public/js/shared/ui-components.js` | Shared quiet action construction |
| `public/js/workspace/benchmark-scores.js` | Scores/discussion switching suspends discussion reads |
| `public/js/workspace/discussion-entry.js` | Category link and summary refresh after writes |
| `private/home.html` | Existing feed, root, composer, filter, and scroll elements |
| `public/css/discussion.css` | Existing scroll/layout behavior; explicitly outside ownership |
| `server.js` | Thin read/write routes and authentication/owner middleware; explicitly outside ownership |
| `db.js`, `scripts/migrate-discussions.mjs` | Schema reference only; never execute database initialization/migration |

### Related Tests and Reference Patterns

| File | Coverage / Pattern |
| --- | --- |
| `test/benchmark-discussion-scope.test.mjs` | Scope, task options, drafts, and entry navigation |
| `test/panel-read-lifecycle.test.mjs` | Actual-source execution, read timeouts, obsolete transport completions |
| `test/account-identity.test.mjs`, `test/account-write-transport.test.mjs` | Identity-safe write contracts |
| `test/guest-drafts.test.mjs` | Existing draft retention expectations |
| `scripts/frontend/discussion-auto-load-20261016.mjs` | Loopback synthetic browser checks; inspect before any execution |
| `scripts/frontend/discussion-replies-20261016.mjs` | Existing reply interaction fixture |
| `docs/discussion-auto-load-20261016.md` | Existing offset, deduplication, retry, and cancellation contract |
| `docs/discussion-replies-20261016.md` | Existing root/reply reading and action contract |

### Risk Assessment and Review Gate

- [x] Context map reviewed against current imports, event handlers, routes,
  schema references, and test harnesses before changing implementation.
- [x] Isolated tests use synthetic responses and fake database connections;
  they do not import `server.js` or `db.js` or send network writes.
- [ ] Public API changes required (not established).
- [ ] Database migrations needed (none planned).
- [ ] Configuration changes required (none planned).
- Main risks: stale controls/errors affecting a different thread, draft loss,
  ascending reply pagination hiding a successful post, and deleted/filter
  visibility inconsistencies. Hypotheses are not findings until reproduced.

## Reproduction and Findings

Pre-fix baseline: 72 tests passed across the service, auto-load, replies, scope,
and panel-read lifecycle suites. Added reproductions execute the actual panel
source with synthetic posts, held promises, and intercepted writes only.

Commands run twice before implementation changes:

```powershell
node --test --test-reporter=spec test/discussion-auto-load.test.mjs
node --test --test-reporter=dot test/discussion-auto-load.test.mjs
```

Both runs: 26 tests, 18 passed, 8 failed. No real messages or database access.

### Confirmed Defects

1. **P2: Previous-thread messages remain actionable after switching threads.**
   Open thread 801 with reply 2001; hold the read for thread 901. Expected empty
   root/replies until 901 loads; actual feed still contains `[2001]`. A failed
   replacement read also keeps the old thread. Pre-fix location:
   `public/js/discussion.js:448` (content cleared only after read success).
2. **P2: Obsolete vote/delete and profile completions mutate another view.**
   Hold a synthetic vote or deletion in 801, open 901, then resolve or reject
   the old write. Expected two reads and no error in 901; actual successful
   writes start a third read, while failed writes expose an unrelated error.
   A held focus/profile failure similarly exposes an error in 901. Pre-fix
   locations: `public/js/discussion.js:332`, `:363`, and `:654`.
3. **P2: A successful reply beyond the first page is not displayed.**
   Start with 45 ascending replies (2001-2045), submit synthetic reply 2046.
   Expected 2046 loaded and scrolled into view; actual refresh contains only
   the oldest 20 replies, so its existing scroll attempt has no target.
   Pre-fix location: `public/js/discussion.js:615`.
4. **P3: Current-view posting errors are not retained with their draft.**
   Reject a reply with `discussion_post_cooldown`, switch to 901, then reopen
   801. Expected retained text and cooldown reason; actual text survives but
   status is empty. Pre-fix location: `public/js/discussion.js:623` (only the
   inactive-view error path stores the reason).

Implementation starts only after recording these isolated red-test results.

## Implemented Fixes and Current Locations

| Finding | Fix Location | Focused Reproduction |
| --- | --- | --- |
| Previous-thread / previous-filter content | `public/js/discussion.js:469` clears root and feed at replacement-read start, retaining the explicit read-error retry latch | `test/discussion-auto-load.test.mjs:344`, `:504` |
| Obsolete vote/delete/profile completion | `public/js/discussion.js:304`, `:340`, `:377`, `:680` bind callbacks to the discussion view; profile requests also reject older profile completions | `test/discussion-auto-load.test.mjs:364`, `:443`, `:479` |
| Posted reply outside first page | `public/js/discussion.js:625` consumes existing ascending reply pages until the submitted post is available, stopping on error, zero progress, view change, or a new draft | `test/discussion-auto-load.test.mjs:425`, `:516` |
| Draft failure reason lost | `public/js/discussion.js:633` saves the current or inactive draft together with its posting error; editing still clears the stored error | `test/discussion-auto-load.test.mjs:407` |

Scores are a pause of the same discussion, not a new discussion identity.
Returning from scores retains working controls. A successful write completed
while scores are visible marks the discussion for refresh on return without
issuing hidden reads. These boundaries are covered by tests at
`test/discussion-auto-load.test.mjs:454` and `:465`.

The reply reveal uses the existing 20-result API and therefore traverses the
intervening pages in a long thread. It does not add an endpoint, bypass the
single-flight guard, retry a failed write, or remove the explicit read retry.

## Verification

### Unit / Contract Regression

```powershell
node --test --test-reporter=spec test/discussion-auto-load.test.mjs test/discussion-service.test.mjs test/discussion-replies.test.mjs test/benchmark-discussion-scope.test.mjs test/panel-read-lifecycle.test.mjs test/account-identity.test.mjs test/account-write-transport.test.mjs test/guest-drafts.test.mjs test/privacy-mobile.test.mjs test/content-motion.test.mjs test/quiet-actions.test.mjs test/frontend-modules.test.mjs
```

Result: **124 passed, 0 failed**. Of these, 32 exercise the paging/panel source
and 15 exercise the discussion service. Nineteen tests were added by this
review. Service-list coverage asserts the emitted SQL and bindings using fake
connections, not a running SQL database. It covers category/context/version
filters, all-category visibility, unavailable threads, deleted roots retaining
live replies, reply-permalink normalization, and ascending reply offsets.

Scoped ESLint, `node --check public/js/discussion.js`, and scoped
`git diff --check` passed. Git reports only the existing LF/CRLF conversion
warnings; there are no whitespace errors. Node reports the existing experimental
MockTimers warning in the panel-deadline suite.

### Loopback Browser Regression

Run `scripts/frontend/discussion-auto-load-20261016.mjs` with
`DISCUSSION_AUTO_LOAD_OUTPUT` set to
`D:/Codex-artifacts/website1/review-discussions-20261016/auto-load-final` and no
`HOME_BUILT_ROOT`, `UI_TEST_ENGINE`, or `UI_TEST_WIDTH` override.

The fixture permits only its own loopback origin and intercepts every write.
It starts and closes its synthetic preview; no real message or database write
is permitted. The first run exposed a fixture-only assumption: waiting for the
empty feed to be visible times out after a failed replacement read now that
stale contents are correctly cleared. The focused helper at
`scripts/frontend/discussion-auto-load-20261016.mjs:26` now waits for the idle
element to be attached rather than to have a nonzero layout box.

Final browser matrix: **52 checks passed** (13 per configuration): Chromium
1440x900, 390x844, 320x740, and WebKit 390x844. Fixture read counts were
41/43/43/41 respectively. Every configuration reported zero page errors and
zero real writes. The final `verification.json` report and feed/thread
screenshots are in the output directory above; the earlier helper-failure
report is retained separately in the sibling `auto-load` directory.

## Exact Changed Paths and Integration

This review changed only:

- `public/js/discussion.js`
- `test/discussion-auto-load.test.mjs`
- `test/discussion-service.test.mjs`
- `scripts/frontend/discussion-auto-load-20261016.mjs` (one-line idle wait)
- `docs/review-discussions-20261016.md`

`discussion-service.js`, `public/js/shared/discussion-auto-load.js`, and
`test/discussion-replies.test.mjs` were reviewed but not changed by this review;
their SHA-256 hashes still match the initial snapshot. Existing dirty changes in
those files belong to earlier/concurrent work.

**Outside-ownership integration required: none.** There are no schema,
server-route, dependency, configuration, CSS, or release-script changes.
Initial/final hashes also match for `server.js`, `db.js`,
`public/js/home-workspace.js`, and `public/css/discussion.css`. No deployment or
production database operation was performed. This is a bounded local review,
not a claim of live-database or full-repository validation.
