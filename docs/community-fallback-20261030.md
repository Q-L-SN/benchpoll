# Community Fallback

## Context Map

| Files to modify | Purpose / change |
| --- | --- |
| `ranking-service.js`, `benchmark-family-service.js` | Separate explicit votes from inheritance; support explicit none; accept only concrete fallback versions. |
| `public/js/shared/benchmark-families.js` | Ordered concrete-version chains; no automatic version groups. |
| `public/js/home-workspace.js`, `public/js/workspace/{fallback-picker,family-view,contracts,state}.js` | Immediate benchmark addition; community/custom/none chooser and validated inherited calculation. |
| `public/js/workspace/{guest-drafts,pie-recovery}.js`, `server.js` | Reset legacy local choices without losing weights; block stale clients from restoring old choices. |
| `scripts/migrate-community-fallback-20261030.mjs` | Backed-up, one-time clearing of all legacy choices/catalogue, nullable explicit-none representation. |
| `private/{home,how-it-works}.html`, `README.md` | Remove automatic-version controls and document the new behavior in both README languages. |

| Dependencies | Relationship |
| --- | --- |
| `public/js/workspace/model-scores.js` | Displays the concrete fallback versions used in calculations. |
| `benchmark-version-preferences.js`, `public/js/workspace/version-group-dialog.js` | Retired automatic-version behavior, no longer part of runtime. |
| `scripts/frontend/{fixtures,server}.mjs` | Isolated UI preview and save/reload fixtures. |
| `ops/{flat-topics-stage-20261022,community-fallback-apply-20261030}.mjs` | Hash-guarded staging and schema-aware release; never roll old code over a possibly committed new schema. |

| Tests | Coverage |
| --- | --- |
| `test/{community-fallback,public-fallback,personal-pie-save}.test.mjs` | Abstention, explicit none, weighted mixtures, persistence, migration. |
| `test/{fallback-picker-state,pie-recovery,guest-drafts}.test.mjs` | Choice state, old draft reset, recovery races. |
| `test/community-fallback.browser.mjs` | Desktop/mobile add, choose, save, reload, return to community. |

Reference patterns: `schema_migrations` transactions in the ordered-family migration;
`verifySlugBackup` backup verification; draft-record compare-and-swap; existing release
source hashes and immutable artifact manifests. Map reviewed before implementation.

## Decisions

- Adding a benchmark does not select a fallback or open the chooser.
- No stored rule means follow community, and contributes no fallback vote.
- An explicit empty chain means no fallback and is a real weighted vote.
- Explicit choices from active public pies determine whole-chain proportions using
  their allocation to that benchmark. Inherited choices never vote again.
- A personal explicit choice overrides inheritance; public results use the community mix.
- Without community choices, unconfigured slices calculate normally with no backups.
  They remain unconfigured and automatically inherit future community choices.
- Missing-score estimation is separate from fallback and is not disabled by an empty chain.
- Only explicitly selected versions can appear in a chain. All Other Versions is retired.
- The user authorized clearing every legacy fallback choice and catalogue record.
  Pie entries and weights must remain unchanged. The reset runs once, not on every deployment.

## Risk Assessment

- API change: obsolete automatic groups are rejected; stale client writes need an upgrade.
- Database migration: nullable family reference plus a transactional, marked legacy reset.
- Browser state: migrate old drafts without their fallback choices or pending write receipts.
- Verification: full unit suite, real-schema rehearsal, isolated desktop/mobile UI tests,
  source-hash checks, backup, then production smoke tests.

## Release Verification

- Released `community-fallback-20261030-1793374824933` on 2026-10-30.
- Full serial suite: 2936 passed, 2 existing opt-in skips, no failures. Final search changes additionally passed 35 browser checks.
- Community fallback add/save/reload/custom-chain checks passed in desktop Chromium, mobile Chromium, and mobile WebKit. Tooltip and parameter overflow checks passed separately.
- An isolated clone of the production schema passed the reset and repeat-run preservation rehearsal before production changes.
- Production reset left 0 explicit choices, 0 saved chains, and 0 chain members. All 34 weights and 11 pies, including activity timestamps, retained the pre-migration digest.
- A full checksum-verified database backup and original source files were retained. Both application and score-sync timer are active.
- Read-only public browser checks passed at 390px and 1440px: darker homepage score ranges, topic search closing at the hero, Public AI Index labels, mobile sticky identity, and shared tooltip rendering.
