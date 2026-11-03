# Optional versions and mobile discussion — 2026-11-03

The evaluation list now has one row per benchmark. Its quiet entry,
“Know this benchmark? Help configure it”, opens the two optional choices in a
dialog. Version controls are not placed under the treemap. The dialog sorts
versions by this topic/scene's explicit selection share, then approved score
count and condition ID. Choose a version before selecting or editing a fallback
chain rooted at it. Changing or deselecting the version clears that chain.

New benchmark allocations follow the community for both choices. An explicit
version alone is valid. No fallback is an explicit fallback choice; following
the community is abstention. Custom chains can be created, reordered and edited
inside the dialog. Account saves, guest drafts, undo, proposal snapshots and
private copies retain the distinction.

## Computation and storage

- Benchmark allocation, version selection and fallback selection are separate.
  Benchmark weights retain the existing 72-hour sample, topped up to ten total
  Pies without an age cutoff. Explicit version/fallback choices use the existing
  14-day configuration electorate, scoped to the matching topic/scene.
- Version proportions use only explicit version allocations. Fallback shares
  use only explicit chains for that primary version. Each uses benchmark weight
  as the voting weight. Abstentions affect neither denominator nor voter count.
- An unselected version expands the benchmark weight into the community version
  mixture before fallback, topic-reference expansion and model scoring. Missing
  portions stay missing. No choices means the designated primary version, with
  no synthetic 100% vote; no fallback choices means primary-only scoring.
- `personal_pie_weights.follow_community_version` is an additive `TINYINT(1) NOT
  NULL DEFAULT 0`. Existing allocations therefore retain their explicit version
  choices and exact weights. New opt-outs store `1`. No score, condition,
  historical weight, timestamp or existing fallback is rewritten by migration.
- Existing personal mixes containing several explicit versions remain valid.
  Choosing one in the dialog combines their benchmark allocation and clears the
  old chains. Mixing an abstention and another allocation for the same benchmark
  is rejected, avoiding ambiguous fallback ownership.
- Private choices remain private. With no public electorate in that private
  context, an unselected version uses the primary default.

## Mobile discussion

The existing discussion interface is the third native scroll-snap page after
Composition and AI Index. The desktop rail is restored when the viewport grows.
The shared topic header and scene selector remain in place; the mobile header's
chat entry is hidden. The dock follows continuous scroll position across all
three pages. Leaving discussion preserves its draft and cancels stale reads;
returning restores the current thread. The discussion scene tabs no longer append
“Default”. The weight-adjustment prompt sits above the dock.

## Score display

Before/after adjustment values use the ranking's two-decimal precision before
rounding to whole numbers. Previously a raw 49.499 could show 49 in the dialog
while its ranked endpoint 49.50 showed 50. After adjustment now reads the ranked
endpoint directly. Negative half values retain the shared rounding rule. This
changes display only; calculations, stored evidence and ranking order retain
their existing precision.

## Validation

Focused tests cover abstention denominators, independent electorates, scene
isolation, cold starts, score-count ties, missing weight, zero scores, grouped
search, validation and repeatable additive schema preparation.
`test/community-versions.mysql.mjs` uses a freshly named loopback-only database
and verifies real persistence, response validation, inherited-version changes
and recursive topic references. `test/community-versions.browser.mjs` exercises
the dialogs, saves and undo, and discussion drafts at desktop, 390px and 320px
using Chromium and WebKit. Artifacts: `artifacts/community-versions-20261103/`.

Final Linux checks after incorporating remote commit `74e90f1`:

- Full suite: 3,310 passed, zero failed, 6 existing opt-in/private-fixture skips.
- Fresh MySQL: 10 passed across community versions and topic lifecycle suites.
- Chromium/WebKit source journeys: 4 passed, including custom-chain editing and
  a native touch drag that moves the page before release.
- Built mobile journeys: community settings/discussion and all estimation modes
  passed. Both home/index builds and focused ESLint checks passed.
- Score rounding regression covers positive and negative values around half
  boundaries. The earlier privacy popup timeout passed on isolated rerun and in
  the final full run without changing that test.

## Release

`node ops/export-community-versions-20261103.mjs <new-directory-outside-checkout>`
builds both pages and exports only this change's source allowlist and bundles.
The preceding lifecycle, harness, loading and transport releases are already
deployed; see `docs/releases/20261103-local-rollout.md`. Do not use the older
combined exporters to enqueue those migrations again. Inspect
`scripts/migrate-community-versions-20261103.mjs` without `--apply` first. Its only
DDL adds the opt-out column; applying it is required before installing the new
backend readers. A retry inspects the existing column and never resets choices.

The bundle is a review package. Installation still requires live source hashes,
a verified backup, concurrency checks, the new additive column and post-install
health checks. Do not replay historical migrations or
replace production with this entire checkout. No Actions operations bridge was
added. This environment still has no production VPN/TCP route; validation uses
synthetic data, and GitHub publication is not a production deployment.
