# Scene browsing and proposal discussions — 2026-11-03

This release implements requests 5–9, following the optional benchmark-version
contribution, mobile discussion page and score-rounding changes in `935f2b6`.
The source branch remains `codex/cloud-handoff-20261101`.

## User-facing changes

- Homepage scene lists open in a modal. Scene cards show the scene name and its
  existing chart, without repeating the topic name or summary. Scene searches on
  the homepage and configuration sidebar return the parent topic with matching
  scene names inside it. See [scene directory details](scene-directory-20261103.md).
- Homepage colored bars occupy at most 65% of plot height. The background weight
  chart's 32%–76% fade is unchanged.
- Deleting a private topic also withdraws its current proposal while it is
  collecting support. The confirmation explains this. Once the proposal enters
  review, deleting the source leaves its independent snapshot and discussion
  intact. The final support vote and deletion serialize through the existing
  topic graph lock.
- During collection, only the proposer can trial-adjust proposal weights. Other
  viewers can inspect rankings, discuss, support, or copy the unchanged snapshot
  into their own private workspace. The API also rejects custom trial weights
  and copy-time weight overrides from other accounts. Private copies are independent.
- Every proposal has an icon-only discussion link in the hall. Discussions live
  at `/topic-proposals/<id>/preview#discussion`, with thread links, replies, votes,
  author deletion and the existing report/moderation path. Older text-only
  proposals can be discussed even without a ranking snapshot.
- The workspace discussion scene selector now uses the same tabs, neutral text,
  sliding selection, overflow treatment and keyboard controls as configuration.
  The adjacent all-scenes icon aggregates the current topic's discussions and
  grays out the selector. Turning it off restores the selected scene. The composer
  retains that scene and its draft; its scene label identifies where a new post goes.
- Text-template feedback guidance has a full neutral border, soft background and
  padding. Sidebar opening reveals the current topic before its first visible
  frame, including mobile dragging. The personal-weights call to action has one
  line of copy: “Rank AI your way”.

## Schema and deployment

`scripts/migrate-proposal-discussions-20261103.mjs` defaults to inspection. Its
explicit `--apply` adds nullable `discussion_posts.proposal_ID` with an index and
foreign key to `topic_proposals`, and makes category/context scope nullable.
Existing messages, IDs and text are untouched. Proposal messages use only the
proposal scope; ordinary messages still require an accessible public topic and
valid scene. Withdrawal deletes the proposal and cascades its messages, mentions
and votes. Author deletion preserves other authors' replies; moderation hides
messages through the existing report mechanism.

The schema extension must be installed before the new backend. Keep it in place
if code is rolled back; an old backend ignores proposal messages through its
ordinary topic joins. Stop writes while installing, verify a fresh backup and
the current live file hashes, and use a narrow release. Do not replay the older
lifecycle/ARC migrations or copy this checkout over production.

`ops/export-scene-community-20261103.mjs /absolute/new/directory` builds both
frontends and exports a hash-checked allowlist outside the checkout. It includes
the preceding `935f2b6` source changes because that release has not been confirmed
deployed here. Inspect the optional-version column first; apply its separate
idempotent migration only if missing. The exporter contains neither production
configuration nor credentials and does not connect to production.

The live baseline documented in [local rollout](releases/20261103-local-rollout.md)
includes the server transport fix. Preserve that fix and reconcile any subsequent
live changes before installation. GitHub publication is not a production rollout.

## Validation

The full unit/contract suite and lint run locally. Disposable MySQL tests exercise
both deletion phases, final-vote/deletion concurrency, owner-only trial weights,
independent publication/copies, proposal thread isolation, reporting/deletion,
and topic boundaries for all-scenes feeds. The migration is checked for repeatability.

Chromium and WebKit cover mobile and desktop proposal creation, preview, read-only
viewer controls, comments/replies, source deletion and sidebar first-frame
positioning. Focused browser checks cover grouped scene search, modal focus,
lazy loading a 184-scene list, scene selector styling/drafts, feedback forms and
the generated frontend bundles. All fixtures use synthetic data.

Final local results: 3,310 full-suite tests passed, 6 explicit skips, zero failures;
17 MySQL integration tests passed. Both frontend builds and lint passed. The four
proposal lifecycle journeys and four sidebar journeys passed across Chromium /
WebKit at 390 and 1440 pixels. Generated-index checks passed in all four combinations;
the generated mobile workspace journey also passed. The 184-scene dialog was
additionally checked at 320 pixels.
