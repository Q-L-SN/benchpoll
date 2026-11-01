# Home spacing and AA detail restrictions, 2026-10-31

## Context map

### Files to modify
| File | Purpose | Planned changes |
| --- | --- | --- |
| `public/css/topics-home.css` | Topic grid and floating settings placement | Deliberate centered gutters on medium/wide screens; narrow screens retain near-full width |
| `public/js/shared/aa-ranking-policy.js` | Existing AA classification shared by ranking and UI | Reuse the same classification for a display restriction reason/message |
| `benchmark-details.js` | Benchmark information API | Return minimal identity and an explicit restriction for AA versions; no protected detail content |
| `benchmark-scores.js` | Version list and score API | Preserve version navigation; do not query or return AA score rows |
| `public/js/discussion.js` | Benchmark information panel | Explain restricted content while preserving navigation and panel lifecycle |
| `public/js/workspace/benchmark-scores.js` | In-panel version switching and score pagination | Clear previous scores and show the restriction; recover normally when switching back |
| `ranking-service.js`, `server.js` | Model score configuration and source APIs | Omit AA versions and AA-sourced samples before grouping; report omissions without returning hidden rows |
| `aa-archive-policy.js` | Result-level provenance classification | Identify explicit AA evaluators in structured notes and score fields; share this decision across display and calculation |
| `public/js/workspace/model-scores.js` | Model All scores, search and lazy expansion | Hide restricted groups in every search state and retain a bottom policy notice |

### Dependencies and references
- `public/js/shared/aa-ranking-policy.js` already drives disabled Add controls and ranking exclusion. Do not invent another AA name classifier.
- Benchmark score reads use a read-only snapshot and descending score pagination. Preserve transaction cleanup and normal benchmark behavior.
- Discussion and score controllers guard asynchronous responses with sequence counters. Keep these guards for rapid version/panel changes.
- `private/home.html`, `public/css/discussion.css`: existing status, tabs and version-selector surfaces; prefer these over another modal or new decorative component.
- Home and configuration use generated bundles. Release from the current production baseline plus the bounded change set; do not deploy unrelated worktree changes.

### Tests
- Existing: `benchmark-details.test.mjs`, `benchmark-scores.test.mjs`, `aa-ranking-policy.test.mjs`, `aa-ranking-ui.browser.mjs`.
- Existing layout regressions: `topics-home-header.browser.mjs`, `topics-home-short-views.browser.mjs`, `mobile-workspace-polish-20261031.browser.mjs`.
- Add browser coverage for direct AA links, mixed normal/AA version switching, return to normal, and stale-response protection on desktop/mobile.
- Add geometry checks at narrow, tablet, laptop and wide desktop widths.
- Check model All scores unfiltered/search/empty results and lazy sources, keeping effort/harness restrictions intact.

### Risk assessment
- API payloads gain an explicit display-restriction field; normal scores and names remain unchanged.
- No database migration or deletion. Existing AA records and ranking exclusions remain intact.
- AA restrictions must not make non-AA versions inaccessible or show an empty-state message that suggests there are merely no scores.
- Review completed before implementation; grid CSS/testing is independent of the AA read/UI work.

## Verification and release

- Unit suite: 2,993 passed, 2 skipped, no failures (`aa-details-20261031/unit-provider-verified.log`).
- Focused ESLint checks passed for product code, regression tests and release/audit tools.
- Browser regressions: AA details/version switching (8), sticky benchmark scores (9), AA model-score display (13),
  and existing All scores interactions (22), all passed. Chromium and WebKit cover the benchmark-detail cases.
- Home layout checks: 16 spacing cases, 20 header cases, 16 short-directory cases, and 4 mobile workspace/home cases passed.
- Public verification: centered home grids at 393, 1440 and 1920 pixels; desktop grid width 1,120 pixels.
  Real model dialogs at 393 and 1440 pixels show the omission notice, hide AA-only search results, and restore
  independent configurations after clearing search. Loaded application bundle hashes match the release manifest.
- Public read-only API checks cover all 15 newly restricted versions, normal Tau3-Banking navigation, model
  configuration/source filtering, and every page of mixed DeepSWE results (173 visible rows, no duplicate/skipped rows).
- Read-only production candidate checks confirmed identical exclusion from calculation. The scoped ranking read
  took 1,544 ms; the three-model configuration read took 377 ms in this run, not a general performance guarantee.
- Initial release: `benchmark-policy-20261031-1793434121098` (18 files).
  Follow-up: `benchmark-policy-20261031-1793435233259` (12 files), healthy at `2026-10-31T08:31:40.815Z`.
  Both were built from the captured production baseline plus explicitly reviewed source files. There were no
  concurrent baseline differences, database changes, archival/deletion runs, or score-sync timer changes.
- Final evidence: `D:/Codex-artifacts/website1/benchmark-policy-20261031-1793435233259/`.
  Backups: `/home/ubuntu/benchpoll-code-backups/` followed by the corresponding release ID.

## Version audit

Read-only production snapshot: `D:/Codex-artifacts/website1/aa-details-20261031/version-audit.json`.
The snapshot contains 7,281 active versions. The old classifier identified 145; the reviewed classifier identifies 160.

- Space-delimited `AA Speech Arena` and `AA Pronunciation Robustness` were missed by the old prefix rule (six versions).
- Nine exact benchmark/version identities cover renamed AA MMMU-Pro cohorts, Harvey LAB all-pass and criterion-pass,
  SciCode Verified pass@1, Tau3-Banking publisher comparisons, CyberGym-E2E, an AA-derived VibeDex composite,
  and an HLE API republication.
- Match the benchmark ID together with the version key. Do not blanket-match explanatory text: many independent
  protocols mention AA solely to distinguish themselves from it.
- Do not exclude all of CritPt based on its introduction URL. Do not exclude mixed SWE-Atlas-QnA or SciCode default
  versions as a whole; AA-origin results need per-result provenance checks instead.
- Source records and legacy data remain in the database. No database migration, archival or deletion is part of this release.

## Result-level follow-up

The first public browser check exposed SciCode Verified under an `Artificial Analysis` evaluation-provider field,
even though neither its version name nor publisher source host identified AA. A read-only audit found 16 previously
unclassified rows with this explicit provider: 11 SciCode Verified rows and 5 DeepSWE v1.1 rows. SciCode Verified is
restricted as its own version; the mixed DeepSWE version retains independent results.

- Provider recognition uses catalog field names and actual text/enum values, not a hard-coded field ID.
- A harness named Artificial Analysis alone is not proof that AA conducted the evaluation. Tests preserve this distinction.
- Model indexes, lazy sources, benchmark-score pagination/counts, ranking aggregation and ranking evidence hashes
  now apply the same result provenance restriction. This prevents a hidden result from still affecting a ranking,
  and keeps the Used in this ranking evidence aligned with its calculation.
- Benchmark-score filtering happens before keyset pagination; mixed versions include an omission notice without
  disabling their independent versions or describing the remaining data as unavailable.
- Post-release provider audit: 112 matching records, zero unclassified. This audit covers explicit AA provider
  metadata, not an assurance that every future import with missing or inaccurate provenance can be identified.
- Newly imported or renamed AA-specific versions without reliable origin metadata still require review. The exact
  version registry intentionally avoids broad description matching that would hide independent comparisons.
