# AA Archival And Chart Interaction Rollout

## Installed Scope

- AA data batch: `aa-catalogue-archive-20261104`, committed at `2026-11-04T14:04:26Z`.
- UI release: `chart-interactions-20261104`, installed at `2026-11-04T14:20:29.517Z`.
- Source patch: `d71b190843ee1e42192f6db458b40b56c11489b6`.
- Production source base: the guarded 232-path feature/memory baseline associated with `a8f3a7e`.
- Pending cloud changes from `5cdea0d`, `9f2a614`, `93c313c`, `dd27841` and `da3be12` were preserved in GitHub but were not installed.

The deployment is an overlay, not a checkout of the patch commit's entire tree.
Its build used the actual guarded production sources, including preserved
production copies of `db.js`, `navigation-service.js` and `public/css/ui/navigation.css`.
Those three files were not deployed or changed. Only these chart modules changed:

1. `public/js/topics-home.js`: remove model-column tooltips while keeping accessible descriptions; pass the current view to the treemap layout.
2. `public/js/topics-home/layout.js`: use the configuration treemap's landscape-priority layout in full-weights view only.
3. `public/js/workspace/pie-renderer.js`: remove partition tooltips while retaining accessible labels and hover/click behavior.
4. `public/js/workspace/weight-treemap-layout.js`: make existing outer padding configurable, preserving the configuration-page default.

The other six installed files are the two generated HTML pages, their asset
manifests, and one changed JavaScript bundle per page. Old hashed assets remain
available to clients with older HTML. The mixed homepage view retains its
existing layout, visibility boundary and hover explanations for weight tiles.

## Data Result

See [the complete archive inventory](../aa-catalogue-archive-20261104.md) for all names and IDs.

- 30 benchmarks and 160 versions archived; no archived AA versions remain selectable.
- 5,457 accepted score rows marked archived. All 301,710 score-row identities and raw values were unchanged.
- `tau2-Bench Telecom`: new empty `default`, version ID `28000`.
- `humanitys-last-exam`: new empty `default`, version ID `28001`.
- Three retained benchmarks received an existing independent primary version.
- One all-AA personal-weight sector was removed; that allocation is now empty.
- No fallback families or scheduled Arena tracking records overlapped the archived objects.
- Possibly AA-derived rows outside the archived versions retain their previous exclusion; uncertain provenance alone did not archive independent versions.

The full database backup passed gzip and SHA-256 verification before the write
transaction. Its SHA-256 is
`65e35cdd33d6d38004c9bb8e2ae3a6ccfcf636c286419c97f4851f274566c6b8`.
The private backup path is recorded in the server-side `database-backup.json`.
The transaction preserved unrelated result statuses and protected user,
discussion, proposal, email and Arena tracking records. No schema DDL was applied.

## Verification

- Archive-policy/planner suite: 28 passed.
- Isolated MySQL rehearsal: classification, default-key collision, primary replacement, value preservation, pie removal, drift refusal, Arena-sync guard, forced rollback, duplicate refusal and guarded restoration all passed. The synthetic database was removed afterward.
- Public archive API checks: 24 requests passed, covering catalogue absence, archived detail rejection, empty defaults and all 15 retained parent benchmarks.
- Exact production-baseline UI candidate: 3,316 unit tests passed, 8 skipped, no failures.
- GitHub integration after preserving the newer pending cloud changes: 3,343 unit tests passed, 8 skipped, no failures. This does not mark those pending changes as deployed.
- Focused source browser tests: 17 passed in Chromium/WebKit.
- Rebuilt-candidate browser checks: 10 passed, including full-weights layout, suppressed tooltips, preserved hover scaling, keyboard selection and weight saving.
- Public Chromium at 1440/390 px and WebKit at 390 px passed. The real Intelligence card had 13 tiles, all wider than tall. Both tooltip types were absent, partition hover scaling remained 1.08, no page errors or horizontal overflow occurred.
- Origin health returned HTTP 200; application and score-sync timer were active. No automatic application restart occurred during verification.

## Operations And Rollback

Server directories under `/home/ubuntu/benchpoll-releases/`:

- `aa-catalogue-20261104`: reviewed inventory, full-backup manifest, transaction receipt and operator.
- `chart-interactions-20261104`: request, payload, installed receipt and `deploy-chart-interactions-20261104.mjs`.

Run the chart operator with `verify` for the current 232-path baseline plus its
10-file overlay and all 153 build sources. The previous memory/feature verifier
alone is no longer sufficient because UI hashes changed.

UI source backups are in `/home/ubuntu/benchpoll-code-backups/chart-interactions-20261104`.
The release operator verifies hashes before each replacement and restores only
its own files if installation or origin health fails. Do not restore the whole
repository or roll back the independent AA data transaction to undo UI changes.

Data originals are in `aa_data_archive_items`. Restoration requires the exact
post-archive state digest and refuses intervening changes or newly populated
replacement defaults. There is no automatic restoration on application startup.
Manual AA/Scale imports must not reactivate archived identities. Runtime secrets,
mail policy and the cancelled daily deployment automation were unchanged.

Local evidence: `D:/Codex-artifacts/website1/chart-archive-20261104/`.
