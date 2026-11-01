# Flat Topics And Home

## Scope

Branch: `codex/flat-topics-home-20261022`, isolated from the original shared checkout. Baseline is the current working source, not the old committed version. The workspace baseline manifest is outside Git at `D:/Codex-artifacts/website1/flat-topics-home-20261022/workspace-baseline.json`.

Root `/` is the topic directory home, not a default ranking redirect. Configuration pages use stable numeric topic URLs. Topic 54 is featured by ID, never by name. Public and private topics are independent: no descendant aggregation or inherited contexts. This release does not implement topic references, recursive composition, importing or copying configurations.

## Context Map

| Owner | Files | Contract |
| --- | --- | --- |
| Parent | `server.js`, `ranking-service.js`, `navigation-service.js`, `private-category-service.js`, `ranking-entry-url.js` | Flat topic resolution, independent public weights, canonical routes, retired composition routes. |
| Parent | New `topic-service.js`, `topic-home-service.js`, shared topic helpers, migration and release tooling | Author credits, public/private creation, bounded previews, backup-first migration and deployment. |
| Homepage worker | New `private/index.html`, `public/js/topics-home.js`, homepage CSS/modules/tests | No sidebar, responsive featured/topic cards, whole centered model columns, proportional weights treemap and shared-like filters. |
| Profile worker | New profile service/editor/schema/tests; discussion author projection | Custom name/avatar override GitHub defaults; authenticated bounded raster updates. |
| Configuration worker | Existing `private/home.html`, `home.js`, `home-workspace.js`, navigation and sidebar styles | Flat navigation, collapsible sidebar/brand handoff, working discussions, no old overview or Public composition UI. |
| Guide worker | `private/how-it-works.html`, its JS/CSS/tests | Short human-readable explanations matching released behavior. |

Existing ranking, fallback, evidence and legal/account write guards remain authoritative. Database/HTTP integration stays with the parent to avoid overlapping worker edits.

## Design Contract

- Home uses the existing large logo and full headline/subtitle, then actual topic cards, not another hero-only screen. Normal cards have stable height and 6-8px radii; about three columns on a laptop, one on phones. Featured topic spans a row and is moderately taller, never a viewport-sized section.
- Available results is the default, left of Range. Retain effort/harness icon controls. One additional view toggle switches model-plus-weights to weights-only.
- Bars use vendor colors, integer labels and fully visible logos. Initial centered bar counts are integers sized from the available width; enforce minimum/maximum width. Loading more horizontally never moves the current scroll position.
- The weights treemap has area-proportional rectangles with the largest blocks toward the exposed top, small entries grouped into Other, conditional name/version/share labels, and a downward fade behind foreground bars. The exposed top gap is at least one quarter of the baseline-to-treemap-top distance. Weights-only removes the fade.
- Public custom topics have a creator, not a private owner. Legacy private ownership remains a separate access-control concept. OAuth defaults do not override custom public profile fields.
- No decorative one-sided accent strips/crescents, gradients/orbs, generic nested card stacks, or focus outlines on inputs. Preserve keyboard focus indicators on actionable controls and honor reduced motion.

## Data Contract And Migration

Keep existing category IDs and benchmark/result records. The storage table can retain its legacy `categories` name; topic behavior must no longer depend on parent relationships. Add explicit creator/slug metadata and a migration record. Archive old paths before flattening so bookmarks can redirect by ID. Materialize formerly inherited context dimensions into independent topics before removing inheritance. Preserve valid personal pies/discussions where possible; legacy data may be discarded only with a recorded reason and recoverable backup, under the user's authorization.

Every database change needs a dry-run, exclusive migration lock, fresh restricted backup, idempotent apply, and invariant checks. No migration runs at web startup. Keep a write freeze during the schema/data transition. Public weights for a topic use only that topic's matching contexts.

## Verification And Release Gates

1. Domain/authorization tests: flat access, direct-only aggregation, public/private isolation, safe creation, custom profile identity and raster validation, immutable account write ownership.
2. Browser fixtures: home and configuration at desktop/tablet/phone sizes in Chromium and WebKit; initial whole bars, proportional treemap/order/fade, empty/error/retry states, filters, pagination, sidebar animation and discussions.
3. Build with unchanged security policy (update exact reviewed startup pin only if required), inspect screenshots and critical geometry. Retired overview/composition entry points cannot still execute.
4. Production preflight and code/database backups. Rehearse migration on a copy, review exact runtime diff against a fresh production baseline, use source hash guards so concurrent work is not overwritten.
5. Deploy, verify root/topic/profile/discussion paths and independent weights, service health, hashes, error signals and backup availability. Document rollback honestly, including schema/data restoration requirements.

## Progress

- [x] Isolated new branch and working-source baseline.
- [x] Reviewed context/design/data boundaries and delegated disjoint frontend/profile/guide work.
- [x] Flat topic backend and migration.
- [x] New home and profile integration.
- [x] Configuration/sidebar and discussion verification.
- [x] Test/build/rehearsal.
- [x] Public release and verification.

## Ordering And Verification Notes

Popular and Home share distinct eligible contributors with nonempty direct-topic Pies updated in the last 14 days. Topic 54 is pinned by ID. Every sixth ordinary slot can expose one public topic created within seven days after its first eligible Pie; at most one exploration slot is allocated to the same creator. Empty, private, future-dated or ineligible-creator topics do not receive a discovery boost. Heat counts are never fabricated and this ordering does not change scores or Public Weights.

Recent stores at most 80 successful topic/context visits locally, scoped to guest or canonical account ID, without names or avatar data. My Pies contains nonempty saved configurations only. Public browsing history is not an input to popularity.

The first actual database rehearsal preserved 75 categories, 12 contexts, 11 Pies, 29 weights, 1,767 benchmarks, 11,784 versions, 270,787 results, 1,688 models and 9 discussion posts. Migration and a second idempotent run passed. A review then added explicit effective dimension positions so inherited/local ties cannot reorder unlocking. That correction was re-rehearsed from the archived pre-migration metadata; migration, idempotence, retained counts and real public/private creation/profile contracts passed again.

The real bundled-root check caught a UMD-versus-ESM D3 export mismatch not exposed by native-module fixture tests. The adapter supports both runtime forms and the compiled root is now included in browser acceptance. Another review found expired snapshot retries repeatedly reused the expired ID; recovery now replaces the preview rather than mixing snapshots.

An unnecessary second full database clone exhausted disk headroom. It was removed immediately and production HTTP health remained 200. Rehearsals now reuse the isolated copy by resetting only archived topic/dimension metadata. Clone tooling also requires twice the database size plus 2 GiB headroom and disables binary logging for operational-account rehearsal imports. Never delete production binary logs or recovery backups to make room for a test copy.

Final application suite: 2,311 passed, zero failed, two existing opt-in tests skipped. Final source and actual CLI-compiled home checks passed Chrome/WebKit at 1440, 1280, 1024, 768, 390 and 320px. The exact staged candidate also passed real-database Chromium checks on desktop and phone, including configuration/sidebar/discussion transitions. Runtime and release-tool lint passed. Publication and post-release verification remain separate gates.

The 2026-10-23 redesign removes the visible Topics heading/count and rebuilds the masthead, toolbar, author/title hierarchy and chart surfaces. D3 slices sorted row groups vertically and tiles each row horizontally: normal cards expose the two largest priorities together; wide cards expose a longer sorted prefix. Binary tiling was rejected because it could hide the second-largest weight below smaller entries. Foreground-view labels fit only within the exposed top quarter, prioritizing name/share before an optional version; weights-only labels can use their complete tile. This also removes unreadable ghost text in the fade. Measured field values can widen model columns and reduce the visible count instead of becoming microscopic text. Centered scores, neutral complete range backgrounds and plot-only hover passed pixel/geometry checks.

Final browser artifacts: `D:/Codex-artifacts/website1/flat-topics-home-20261022/topics-home-final-20261023/`, the adjacent `-built/` directory, and `live-browser/`. Earlier `ordered` and `redesign` reports are historical baselines, not evidence for the final exposed-label correction.

Production's hourly score sync continued normally during isolated development, so live result/model counts may legitimately exceed the rehearsal snapshot. Release checks compare against the fresh write-frozen backup, not those historical counts. Before backup/migration, the launcher temporarily pauses an originally active score-sync timer and refuses to continue if an import is already active. Success or a pre-migration failure restores the timer. A post-DDL failure leaves scheduled imports paused and attempts to stop the web service; a stop failure is recorded as `recoveryError` and requires an external write freeze, not an assumption that maintenance succeeded. Protected identity, discussion, Pie and Fallback table digests are checked before starting the new service. A read-only production inspection has verified the digest queries against the actual schema.

Release-tool regression checks cover oneshot activating/deactivating/PID/job states, pre/post-DDL failures, timer restoration failures and dependency guards. The first launch attempt aborted before stopping the app: its path allowlist incorrectly rejected unchanged `eslint.config.js`. Live/candidate/manifest hashes matched, so no concurrent source change had occurred. The corrected dotted-root allowlist still rejects traversal and changed bytes; all 24 isolated launcher scenarios pass. Rehearsal service/database cleanup completed before the real release, returning production disk headroom to 8.4 GiB without removing recovery backups or binary logs.

## Published Verification

Released to `https://benchpoll.com/` at approximately 16:58 on 2026-10-23 (Asia/Shanghai), release `topics-20261022-1792683638917`. Source remains on `codex/flat-topics-home-20261022` in the attached isolated worktree. No dynamic topic references, imports or copying substitutes were added.

- The write-frozen backup passed gzip/integrity checks. The migration kept all 75 category IDs, 12 contexts, 11 Pies, 29 weights, 1,767 benchmarks, 11,784 versions, 271,048 results, 1,694 models and 9 discussions; zero records were discarded. Protected identity/Pie/Fallback/discussion digests matched before starting the new service.
- The root returns the new directory, with 54 active public topics. Topic 54 is first. Legacy category links redirect to numeric canonical topic routes; legacy showcase links redirect Home, while an obsolete view parameter on a canonical route is sanitized. There are no active private topics in production, so actual private access denial was checked with temporary topics in the isolated rehearsal, not claimed as a live-data test.
- All 61 installed source/build files matched their release hashes after publication. Public Chromium/WebKit desktop/mobile checks passed four cases, covering Home, weights-only, canonical configuration, sidebar collapse, discussion transitions, complete model columns, logos and CSP. Public screenshots/report are at `D:/Codex-artifacts/website1/flat-topics-home-20261022/public-browser/`.
- Web service and score-sync timer are active. The actual append-only error log had no writes after the new service started; journald has no application-output records because this unit redirects output to files. Disk headroom was 8.21 GiB after backup and rehearsal cleanup.
- Code backup: `/home/ubuntu/benchpoll-code-backups/topics-20261022-1792683638917`. Database backup manifest: `/home/ubuntu/benchpoll/scripts/flat-topics-20261022/topics-20261022-1792683638917/database-backup.json`, restricted to the operator; compressed backup is 163,538,946 bytes. Recovery must restore compatible code/schema/data together under a confirmed write freeze, preserving any later legitimate writes.
