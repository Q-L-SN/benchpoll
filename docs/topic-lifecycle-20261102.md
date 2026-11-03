# Private topics and proposal snapshots

This change is developed on `codex/cloud-handoff-20261101`. Deployment is now
authorized by the owner after verification; historical migrations and unrelated
production data must not be replayed or rewritten.

## Product contract

- Private topics have an owner-only editor for their name, summary, ordered scene
  list and default scene. Saving is atomic and checks the version opened by the
  editor. Scene identities and saved weights survive renaming and reordering.
- Creating the first scene preserves the existing root weights in the selected
  default scene. Removing all scenes preserves the old default's weights as the
  topic's root. Removed scenes and deleted topics stop resolving as reference
  targets; existing references do not silently point at another scene.
- New topic proposals come from a saved, nonempty private topic. Submission
  captures an independent, versioned snapshot of its scenes, weights and explicit
  fallback choices. Public references remain references to public weights;
  private or unavailable references must be removed before publication.
- Original private topics stay private and can be edited or deleted without
  changing a published proposal. Replacing proposal content increments its
  revision and resets supports without extending its collection deadline.
- Everyone can inspect a proposal and calculate personal trial weights using the
  existing ranking algorithm. Trials never write public weights or support votes.
  Signed-in users may explicitly save a new private copy. Approval imports the
  snapshot as one contribution from its author, including scenes and fallbacks.
- The current 30-support review threshold, account quotas and 14-day proposal
  collection period remain. Existing text-only proposals remain reviewable.
  Reviewers cannot silently change the content of a supported snapshot.

## Scene URLs

Public scenes use `/<topic-slug>/<scene-name-slug>`; private scenes use
`/personal/<ID>/<scene-name-slug>`. Visiting a topic root redirects with 302 to
its current default scene, preserving model focus and other non-scene parameters.
Topics without scenes keep their root URL. Renaming changes the scene path while
retaining its internal context identity and weights. Old scene names and
`?scene=ID` / `?context_scene=ID` have no compatibility aliases. Canonical metadata,
sitemap, discussion links, navigation and previews use the named path.

## Implementation map

- `private-topic-service.js`, `topic-scenes-service.js`: owner locks, atomic
  editing/deletion, context identity and version checks.
- `topic-snapshot-service.js`, `topic-proposal-service.js`: publication snapshots,
  source validation, preview, replacement, copying and approval import.
- `ranking-service.js`: read-only proposal calculation using the existing scoring
  pipeline and public reference resolution.
- Shared private-topic editor, proposal hall and proposal preview page: existing
  account write scopes, CSRF, idempotency, accessible dialogs and mobile layouts.
- An additive proposal-snapshot migration, focused backend/browser tests, both
  frontend builds and the ordinary regression suite precede a narrow release.

## Verification and release

Verified locally on 2026-11-02 with Node 22.22.1 and disposable MySQL 8.0:

- Full regression suite: 3,249 passed, 6 explicitly skipped, zero failures.
- Final named-route/reference checks: 37 passed. Old scene query URLs are
  rejected by the page routes, parser and URL generator.
- Isolated MySQL lifecycle suite: 9 passed, including the real moderation SQL
  preview and approval handler, immutable snapshots, vote reset, deletion,
  independent private copies and explicit/ordered fallback preservation.
- Chromium and WebKit lifecycle journeys at 390 and 1440 px: all 4 passed.
- Scene/reference/search browser regressions: all 25 passed. Adding a topic
  from the mixed evaluation list persists its concrete reference identity.
- Compiled mobile workspace journey passed: scene marker before delayed
  responses, native continuous swipes, fixed header, drawer dragging and
  summed topic coverage. Both frontend builds and lint passed.

Screenshots and the lifecycle report are under
`artifacts/topic-lifecycle-20261102/`; workspace and brand previews are under
`artifacts/workspace-ui-20261101/` and `artifacts/brand-seo-20261102/`.

Use Node 22 and the lockfile. The opt-in `test/topic-lifecycle.mysql.mjs` and
`test/topic-lifecycle.browser.mjs` use fresh, randomly named databases through
`test/helpers/lifecycle-mysql.mjs`, restricted to loopback. Set
`LIFECYCLE_MYSQL_ENV_FILE` to the external disposable MySQL credentials file.
No production rows, mail or OAuth services are used. Each run drops only its own
new database.

Only `scripts/migrate-topic-snapshots-20261102.mjs` is new DDL: one additive table,
no historical data rewrite. Its default invocation is a dry run; `--check` reads
schema metadata; `--apply --backup-manifest=...` requires a verified backup and an
exclusive advisory lock. Apply before deploying the snapshot-aware application.
No historical migrations may be replayed. Build both frontend entries and
include all earlier authorized UI, public-weight sampling and brand/SEO changes
in the release allowlist.

Export a reviewable package outside the checkout with:

```bash
node ops/export-topic-lifecycle-20261102.mjs /workspace/benchpoll-release-20261102
```

The exporter checks the handoff branch, both frontend manifests and each source
hash, then includes only the explicit application allowlist and generated build
files. `request.json` records every file hash and any unchanged build inputs that
must match the live server. It deliberately marks the package as not yet ready
for installation until live baseline and backup checks are completed. The older
slug migration module is included solely for its backup-verification function;
its migration entry point must not be run.

Production installation remains pending: the current cloud environment reports
no VPN and no permitted production TCP/SSH destination. Local builds and tests
are not evidence of a successful deployment. Capture live file hashes, a fresh
verified database backup, service state and available disk space before a narrow
installation; never copy the entire checkout or replace production configuration.
