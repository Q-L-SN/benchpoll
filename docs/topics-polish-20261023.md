# Topic Browsing And Account Follow-Up

## Scope And Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Find a relevant topic, compare models, and participate in its benchmark weights. |
| Primary action | Open a topic or an exact model comparison; create a public/private topic from Mine. |
| Hierarchy | Community participation first, topic collections second, chart settings third. |
| Navigation | Popular, account-scoped device-local Recent, Mine, Configured, and expanding Search. A centered logo/navigation island stays available after the hero. |
| Visual language | White canvas, prominent subtitle, compact neutral controls, restrained card frames, thinner vendor-color columns, small rounded column caps. |
| Chart controls | Available results remains the default. Reasoning/Harness and comparison modes retain their existing controls. Treemap candidates are Soft color, Paper and Ink. |
| Required states | Guest, authenticated, loading, empty collection, failed read/write, stale preview, unavailable target, expired ranking snapshot, and changed account. |
| Responsive behavior | Cards keep whole centered initial columns; the island reduces to icons when needed. Search replaces its own action area. Controls wrap without hiding labels or model parameters. |
| Evidence | The user's two supplied screenshots, actual BenchPoll components, and desktop/mobile browser captures. The UIZZE catalogue entry was reachable, but no usable catalogue screen references were retrieved; none are claimed as visual evidence. |
| Forbidden defaults | No crescent or one-sided accent borders, decorative nested cards, inert chart controls, or viewport-scaled type. |
| Acceptance | No card-footer counts; low scores fit inside columns when physically legible; canonical public slug routes; one shared account center; exact model navigation with reduced-motion support. |

## Routing And Data

- Public topics use `/<slug>`. The existing numeric ID remains the internal identity and featured-topic key.
- Private topics retain owner-authorized `/personal/:ID` addresses; names never grant private access.
- Old numbered links and archived category-tree links continue to redirect, preserving context/discussion parameters.
- A shared reserved-route list rejects normalized official/future page names during topic creation. Database uniqueness also prevents concurrent public-slug collisions.
- The small `topic_short_urls_20261023` migration archives existing slugs, preserves valid addresses, and deconflicts reserved/colliding addresses. It changes no weights, scores, accounts or discussions.
- Topic metadata exposes account-relative `isMine` and `configured` flags without disclosing owner/account IDs.
- Model links carry their exact comparison identity and the selected score/effort/harness modes. A session-bound snapshot locator finds the target's page without fetching every preceding page.

## Verification And Rollout

Verified before rollout:

- The complete regression suite passed 2,374 tests; two opt-in checks were skipped. The changed runtime and release tooling passed ESLint.
- Home passed Chromium/WebKit source and actual CLI-built checks at 320, 390, 768, 1024, 1280 and 1440 pixels, including pixel inspection, complete centered columns, themes, low scores, filtering races, pagination, expired snapshots and account actions.
- The shared account center passed 39 focused unit tests and 13 browser cases in each engine, covering profile edits, account changes, sign-out, deactivation safeguards and focus restoration.
- Exact model navigation passed source/built checks in both engines, including ordinary startup, deep pagination, public/private Home links, effort/harness variants, preference preservation and reduced motion.
- A metadata-only MySQL rehearsal verified 75 topics, idempotency and public-slug uniqueness without modifying production metadata. It renamed the reserved `media` and `security` addresses to `media-benchmarks` and `security-benchmarks`; the disposable metadata database was removed.
- Production capture found no source conflicts across the 29 changed runtime files. The candidate built both pages on the server. Its inline preloader matched the reviewed CSP hash; arbitrary inline/evaluated/external scripts remain prohibited.

Release `topics-polish-20261023-1792764696241` uses byte-hash concurrency guards, a fresh gzip/integrity-checked database backup, protected-record counts and configuration digests, and coordinated app/score-import downtime. No full rehearsal copy of score data is created.

Published at 2026-10-23 18:44:36 UTC (2026-10-24 02:44:36 Asia/Shanghai): 45 installed source/build files, 54 active public topics, and the score-import timer restored. Public Chromium/WebKit checks passed at 390 and 1440 pixels, covering the rendered charts, navigation island, search, all three themes, weight-only view, exact model focus, sidebar collapse and discussions. Read-only HTTP checks passed for short routes, legacy/case/trailing-slash redirects with query preservation, reserved/request-field rejection, official pages and private-topic protection. Protected database counts and configuration/identity digests were rechecked after those browser visits and remained unchanged.

Go/no-go requires the complete regression suite, metadata rehearsal, source guards and server build to pass. After installation, verify root and short routes, preserved legacy query parameters, the featured preview, exact model focus, sidebar/discussion behavior, and the restored app/score timer. Code before-images are in `/home/ubuntu/benchpoll-code-backups/topics-polish-20261023-1792764696241`; the stage's `database-backup.json` records the private backup path and SHA-256. If a post-DDL failure occurs, keep writers paused, inspect `release-failure.json`, and use those verified backups only after checking for concurrent work. Never restore over newer user writes.

This work does not implement dynamic topic references, importing, or copying configurations.
