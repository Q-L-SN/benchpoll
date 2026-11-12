# Prelaunch redesign — 2026-11-12

This change implements the 39-item prelaunch request on
`codex/cloud-handoff-20261101`. Production has not been changed by this work.

## Product changes

- The ranking workspace starts with no evaluation item selected. Selection can
  be cleared explicitly; wheel/touch scrolling only edits a selected weight
  inside the chart. Public mode hides Undo and displays configuration count as
  an icon with a tooltip. Name links, evidence counts and weight controls share
  one row. Selected-topic composition is normalized to 100%.
- Topic expansion is a distinct read-only mode with a Close action. Unsupported
  scenes turn it off. Entering/exiting retains a selected benchmark only if that
  benchmark remains visible. Both weight modes and the selected-item controls
  remain sticky; evaluation and index headings also stay visible on mobile.
- The header supports two test layouts: **Header layout → 3 rows / 2 rows**.
  The two-row variant keeps topic and summary on one horizontally scrollable
  line. Home, creator/Official, report and favorite actions have consistent
  desktop/mobile placement. Compact layouts preserve the sticky weight switch.
- **Advanced configuration → Pages / Accordion** is a second test switch.
  Pages use vertical controls with three neighboring pages prepared. Accordion
  keeps one section open, loads more automatically and pins its section headers.
  Choosing a version opens its fallback section; fallback is unavailable until
  a version is chosen. Long chains have intrinsic card heights; paged cards can
  expand past the preview limit. The original custom-chain editor remains.
  Public inspection is explicit read-only, without dimmed choices or personal
  selection highlighting.
- Evaluation lists show scenes when their empty search field is focused. Clear
  exits that state. Topic rows share normal benchmark typography and show
  favorites, configuration count where relevant, and coverage. Coverage indices
  are floored everywhere. Zero-public-weight entries use site-wide weight totals
  for ordering without exposing those totals in the UI.
- Desktop model hover temporarily previews expanded benchmark coverage in the
  treemap. Uncovered regions fade; covered regions show the adopted deduplicated
  median score. Mobile score details include the same view. Score tracks do not
  own tooltips; coverage pies do. Large mobile dialogs use the full viewport.
- The homepage has compact landscape cards on mobile, larger headline text with
  “Super Intelligence” kept together, descriptions below names, and an animated
  collapsed filter island. The gray background follows the header's glass fade.
  Intelligence is featured only in Popular and is identified by catalogue
  metadata, independently of its numeric URL.
- Discussion has an always-open composer above the feed, an icon sort toggle,
  shared scene selection and All state, and no redundant topic/mobile heading.
  Native panel scrolling retains its position during content resizing. The
  sidebar opening transition is verified in Chromium and WebKit.
- Public topic publication replaces Proposal Hall. Every account may have
  three published topics at once. Favorites include click feedback and drive
  popularity with recent and total activity. Creator/Official, favorite,
  configured and coverage metadata is reused across directory/workspace/profile
  cards. The report flag next to creator metadata opens a topic-specific report
  through the existing review queue.
- Profiles are full pages at `/@<publicID>` and `/me`. IDs are editable and unique;
  default numeric IDs follow account registration allocation. Published,
  favorited and configured topic tabs honor privacy settings. Owners can access
  settings and private browsing history. User names and avatars link internally;
  GitHub appears only as an optional profile link.
- Cyclic topic references are resolved through graph absorption probabilities.
  Closed cycles with no path to a benchmark contribute zero; their unresolved
  weight does not inflate covered benchmarks. How It Works and related policy
  copy describe the current behavior.

## Routes and catalogue

Public topics use `/<publicTopicID>/<localSceneNumber>`; private topics use
`/private/<opaqueID>/<localSceneNumber>`. A topic without scenes omits the final
segment. A topic with scenes redirects its root to its default scene. Named and
query-based scene URLs are no longer served. A private alias survives publication
and redirects to the public URL; unpublishing invalidates the public route.

The new official catalogue contains 23 topics and the requested language,
programming-language and media-reference scenes. Existing-catalogue reconciliation
retains matching topic/context identities and configurations, creates missing
entries and retires obsolete official entries. Authored and private topics remain
separate. See [topic platform migration](../topic-platform-20261112.md).

## Schema and rollout boundary

The application needs the new topic-platform and profile schema. The prepared
migration entry points are:

- `scripts/migrate-topic-platform-20261112.mjs`: no arguments prints its static
  plan; `--plan-current` reads the explicitly selected database; `--apply
  --reconcile-official` applies the current-catalogue update. `--initialize-official`
  is reserved for an empty catalogue.
- `scripts/migrate-profile-pages.mjs`: inspects by default and applies with
  `--apply`, using explicit database environment settings.

Only disposable local databases were used here. No production database, historic
migration replay, mail backfill, deployment or GitHub Actions operations channel
was used. This is a coordinated application/schema release; historical narrow
release flags are not a manifest for it. Build both home and index assets after
installing the lockfile dependencies.

## Verification

Node 24.22.1, pinned Playwright Chromium/WebKit and disposable MySQL 8.4 were used.
The final full unit/contract run passed 3,259 tests with six existing opt-in checks
skipped. ESLint, both asset builds, source/built Chromium and WebKit workflows,
and five real MySQL integration cases passed. Database checks cover
publication-cap concurrency, persistent aliases, favorites, version abstention,
reference expansion, catalogue transaction rollback/reapplication, unique profile
IDs, collection privacy and account-scoped browsing history. All test data is
synthetic and disposable; no live-data compatibility or production latency claim
is implied by these checks.

## Follow-up 40: scene hover

Workspace and discussion scene markers now slide to the button under the mouse.
Leaving the buttons restores the current scene; hovering does not navigate or
request data. Click activation remains immediate, touch gestures keep their
existing behavior, and the disabled All-scenes state and reduced-motion setting
are respected. Other segmented controls retain their existing behavior.

Both asset builds, ESLint, 74 focused unit/contract checks and eight existing
Chromium/WebKit scene checks pass. Built-page previews also verify hover
interpolation, selection preservation, return animation, click activation,
disabled discussion scenes and reduced motion in both browsers. This follow-up
requires no schema or data changes.
