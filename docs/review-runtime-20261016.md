# Runtime Review Integration

This batch began on 2026-10-16 and continues on 2026-10-17 (Asia/Shanghai). The active objective remains to review the application broadly for bugs and unintended behavior; this batch is not a completion claim.

## Reviewed Changes

| Runtime File | Confirmed Behavior Repaired | Evidence |
|--------------|----------------------------|----------|
| `ranking-read-cache.js` | Successive abandoned producers and late driver errors no longer fail a surviving reader; cancelled subscribers cannot consume successful shared results. | `docs/review-ranking-pages-20261016.md`, deterministic fake leases and actual service integration. |
| `public/js/workspace/fallback-picker.js` | Custom automatic version groups resolve current priorities instead of exposing another anchor's saved list. | `docs/review-fallback-state-20261016.md`, controlled DOM and real dialog checks. |
| `public/js/workspace/family-view.js` | An obsolete captured drag is cancelled when its entries/permissions change, without interrupting unchanged drags. | Same Fallback report, actual pointer capture and stale pointerup checks. |
| `public/js/discussion.js` | Old thread content and delayed write/profile completions do not affect the new view; successful replies beyond page one become visible; failed draft reasons survive navigation. | `docs/review-discussions-20261016.md`, actual-source unit harness and loopback browser matrix. |
| `public/css/ui/showcase.css` | Short desktop/mobile/landscape data and outro scenes fit above the footer; small plots retain readable axis endpoints. | `docs/review-showcase-viewport-20261016.md`, two pre-fix reproductions and multi-engine geometry screenshots. |

Parent review confirmed the release diff contains only these intended changes. No scoring formula, sample selection, stored weight, schema, or public API changes are part of this batch. Existing concurrent edits remain intact.

## Release Context Map

| File | Purpose |
|------|---------|
| `scripts/prepare-available-release.mjs` | New five-file runtime scope with captured production hashes and explicitly reviewed diff. |
| `ops/stage-available-release.mjs` | Add the exact `ranking-read-cache.js` name to the safe root-file allowlist; retain staging/build source guards. |
| `ops/launch-release.mjs` | Add the same exact name, preserve per-file pre-replacement hashes and non-destructive rollback. |
| `test/release-concurrency.test.mjs` | Existing overwrite/rollback/concurrent-deletion regressions. |

The helper edits only authorize the named module in staging; they do not weaken path validation or alter application behavior. Root-module installation requires one service restart; no migration or intentional database write is required.

## Residual Scope

- Fake-driver cancellation coverage is not proof of real MySQL driver abort timing.
- The reply reveal retains the existing ascending 20-result API; reaching a newly posted reply traverses intervening pages. Very long thread latency remains a separate optimization concern, not a claim of constant-time navigation.
- Browser matrix and full-suite results verify their covered cases only. Remaining application and production-data behaviors require continued review.
- Previously audited external limitations (unconfigured email provider and unresolved Arena source conflicts) are not silently represented as fixed by this batch.

## Verification And Release

- Full current-tree suite: **1,895 passed, 0 failed, 0 skipped**, using `node --test --test-reporter=spec "test/**/*.test.mjs"` after all three agents completed.
- Scoped ESLint and whitespace checks passed. Existing Git LF/CRLF warnings are not whitespace failures.
- Exact production bundle: 10 multi-scene viewport cases passed in Chromium/WebKit, including 320x568 portrait and 844x390 landscape; 8 Fallback chooser cases passed across desktop/mobile/WebKit/reduced motion; discussion auto-load passed 52 checks across four engine/viewport cases.
- Source-only pinned-switch/pagination regression passed all seven cases; code changes to axis/outro typography do not modify that source-control contract.
- Released `showcase-20261012-1792208840526`: five reviewed runtime sources, ten installed source/build files, 104 unchanged build-source guards. Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792208840526`.
- One service restart, no migration or intentional data change. Origin health and all installed hashes passed.
- After release, all 10 viewport cases passed using real public HTML/CSS/JS with synthetic API data. Separate anonymous production-data runs passed at desktop 1440x900 and mobile 390x844 with zero page errors and no business-write requests.
- Artifacts: `D:/Codex-artifacts/website1/showcase-view-20261012/review-runtime-20261016/` and the linked scoped review directories.

## Continuing Review Queue

These are unproven hypotheses or remaining validation needs, not additional confirmed findings:

- Verify that voting/deleting in deep reply pages preserves a reader's position; current action handlers perform a replacement read.
- Evaluate bounded positioning of a new reply in very long threads instead of traversing every intervening page.
- Validate genuine driver cancellation timing in an isolated MySQL environment, without manipulating production locks or data.
- Extend responsive tests to long category/context headings and text-only font changes, not just the currently verified dimensions.

Goal status remains active. This turn made authoritative progress by reproducing defects, implementing focused fixes, adding tests and deploying/verifying the reviewed changes; the broader goal is neither complete nor blocked.
