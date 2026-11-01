# Taxonomy Update, 2026-10-15

## Context Map

| File | Purpose | Change |
| --- | --- | --- |
| `scripts/build-task-taxonomy-20261015.mjs` | Derive the next dated specification | Two renames, one retirement, normalize sibling order |
| `ops/task-taxonomy-20261015.json` | Generated full tree and templates | Preserve IDs and all context templates |
| `test/task-taxonomy-update.test.mjs` | Focused regression | Exact scope, repeatability, personal navigation and English URLs |
| `scripts/frontend/taxonomy-update-20261015.mjs` | Read-only production verification | Navigation, category pages and sidebar bounds |

References/dependencies: `scripts/migrate-expanded-taxonomy.mjs` provides the
transactional plan/rehearsal/apply workflow; `private-category-service.js` preserves
personal pies when retiring a category. `navigation-service.js` reads current
category names and IDs. Ranking-cache revision triggers include `categories`.
No runtime application or UI changes are required.

## Reviewed Scope

- Category 202: `Business` becomes `Management`; keep the category ID and personal
  Pie context unchanged.
- Category 215: `Long Context` becomes `Memory & Context`, a concise English label
  for memory and long-context capabilities.
- Category 235: retire `Real World` under `Forecast & Decide`. `Live Investing`
  remains the only child and moves from position 20 to 10.
- Keep all other categories, ordered templates, Any locking rules and the default
  `Intelligence` category unchanged. No legacy redirect is introduced.

The live preflight found one context and one personal Pie on category 202. Category
235 had no contexts, personal Pies or discussions. Retiring uses the existing
preservation mechanism if usage changes before the locked migration runs.

## Risk Review

- English URLs change for the two renamed categories; retained IDs preserve data.
- A database data migration is required, but no schema migration.
- Use a fresh restricted database backup, dry-run, transactional rehearsal and
  post-commit verification. Do not overwrite application files from other tasks.

## Public Verification

Read-only production verification passed on 2026-10-15, 04:14:49-04:17:00 UTC
(12:14:49-12:17:00 Asia/Shanghai), against `https://benchpoll.com` with Playwright
Chromium `151.0.7922.34`. This verification made no direct database connections,
used no account credentials, deployed nothing and edited no runtime code.

Run the production verifier with the repository's existing Playwright dependency:

```sh
node scripts/frontend/taxonomy-update-20261015.mjs
```

The authoritative evidence directory is outside the repository:

```text
D:/Codex-artifacts/website1/taxonomy-20261015/public-verification-2026-10-15T04-14-49-412Z
```

- `report.json`: complete passing report, API responses, browser requests,
  ancestry comparisons, per-row geometry and screenshot inventory. Zero final-run
  API retries, verification failures, page exceptions or unexpected network failures.
- `public-navigation.json`: unmodified public navigation response, containing
  exactly 54 active, available, non-private categories.
- `browser-1440.json`, `browser-390.json`, `browser-320.json`: viewport evidence.
- 27 viewport PNGs: default entry, expanded-tree top/bottom, and page/sidebar
  captures for categories 202, 215 and 236 at each size. Representative desktop,
  390px and 320px captures were also visually inspected.

### Verified Results

- The full ordered navigation response and fully expanded DOM tree match all 54
  specification names, IDs, ancestry and sibling positions, not only the changed
  nodes. Every specification path also resolves through `/api/get_page` to its
  expected original category ID.
- Category 202 is `Intelligence / Management`; category 215 is
  `Intelligence / Memory & Context`. The new English routes below work through
  actual sidebar clicks, successful category-specific workspace responses and
  direct document reloads returning HTTP 200 at all three sizes.
- `Forecast & Decide` 234 has exactly one child: `Live Investing` 236, position 10.
  `Real World` 235 is absent from navigation and the expanded tree; its public
  child-loading API and former page API path return 404.
- `/` returns 302 to `/Intelligence`. Fresh entry and returning to `/` after
  visiting the changed categories both select category 54 in every viewport.

| Verified route | Category ID | Click and direct reload |
| --- | --- | --- |
| `/Intelligence/Management` | 202 | Pass at all sizes |
| `/Intelligence/Memory-%26-Context` | 215 | Pass at all sizes |
| `/Intelligence/Forecast-%26-Decide/Live-Investing` | 236 | Pass at all sizes |

| Viewport | Expanded rows | Document width | Tree client/scroll width | Overflow or row overlap |
| --- | --- | --- | --- | --- |
| 1440 x 1000 | 54 | 1440 | 183 / 183 | None |
| 390 x 844, touch/mobile | 54 | 390 | 278 / 278 | None |
| 320 x 800, touch/mobile | 54 | 320 | 250 / 250 | None |

Label text bounds and every expanded row fit their panels. The new category pages
also fit with the mobile drawer closed. Local syntax and ESLint checks passed for
the verifier; `node --test test/task-taxonomy-update.test.mjs` passed all 3 tests,
including unchanged template specifications and retained personal navigation IDs.

### Known Effects and Verification Boundaries

- No taxonomy regression was found. Old `Business`, `Long Context` and retired
  `Real World` URLs do not have category-compatible redirects. Their APIs return
  404; HTML requests follow the existing 302 to
  `/dialogPage?errorCode=404&side=server&error=request_failed`. Existing bookmarks
  therefore need updating, consistent with the reviewed scope.
- The browser guard allowed only explicit read APIs and blocked other non-GET
  requests. There were zero attempted application mutations. Intentionally blocked
  Cloudflare RUM requests and cancelled guest-profile reads are retained in the
  raw network/console evidence and are not application failures.
- Earlier exploratory runs remain in sibling artifact directories. One direct
  API connection stalled; the final API client honors the environment's HTTPS
  proxy. An interim harness incorrectly expected HTML HTTP 404 rather than the
  existing 302 error dialog; only the assertion was corrected before the complete
  passing rerun. No production behavior was changed.
- This anonymous public verification did not re-audit private tables or inspect
  the retained personal Pie. Preservation of all personal Pies, weights, fallback
  tables, contexts, dimensions and category 202's existing Pie/context identity
  relies on the parent migration's unchanged before/after hashes. The supplied
  backup metadata was not independently re-read here:
  `/var/backups/benchpoll/pre-taxonomy-private-2026-10-15T03-59-07-829Z.sql.gz`,
  257868208 bytes, SHA-256
  `0bdfa5ad0c37f920f7678dca0c945c51d1df7f217001a1561393bff6e2bb4514`.
