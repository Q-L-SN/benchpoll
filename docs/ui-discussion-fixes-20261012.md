# UI and Discussion Fixes, 2026-10-12

## Context Map

| Area | Sources | Checks |
| --- | --- | --- |
| Fallback list | workspace/family-view.js, home-workspace.js, ui/fallback.css, private/home.html | Preview, editing, dynamic group, drag, arrow reorder |
| Contribution forms | private/contribute.html, contribute.js, contribute.css, shared/contribution-navigation.js | Previous page, sidebar alignment, textarea, direct entry |
| Workspace header | ui/workspace.css, discussion.js, workspace-layout.css | Timestamp typography, desktop/mobile panel branding |
| Discussion writes | discussion-service.js, ranking-service.js, db-transaction.js | Context creation/reuse, duplicate races, transaction rollback |

All frontend paths are under public/js or public/css unless qualified otherwise.
Concurrent changes outside this scope must remain intact. Deploy only reviewed files,
guarded by freshly captured production hashes.

## Design Contract

- Job: choose backups in order, or edit them deliberately; names open information only while browsing.
- Hierarchy: entrance version, numbered backup sequence, editing controls only in editing mode.
- Controls: trash for removal; explicit edit/finish; keyboard-accessible configuration selection without a trailing arrow.
- Layout: one compact vertical list structure in both modes. Dynamic groups attach below the previous item; no ordinary connecting arrows.
- Motion: 160ms movement from previous item positions, never a blank refresh; respect reduced motion.
- States: empty, loading, disabled, dragging, editing and browsing remain distinguishable.
- Responsive: retain touch targets, allow names to wrap, no horizontal overflow at 390px.
- Evidence: user's screenshots and the existing BenchPoll components. UIZZE catalogue access did not yield usable workflow-specific screen references; no replacement visual template is introduced.
- Forbidden: accent single-sided bars/crescents, underlined icon actions, nested clickable buttons, fake breadcrumbs.
- Acceptance: all ten requested behaviors pass focused unit and desktop/mobile browser checks.

## Reproduction Brief

- Production log repeats `POST /api/create_discussion_post 500 ranking_context_upsert_failed`.
- Failure is before inserting discussion_posts; the draft remains client-side.
- Suspect: ensureContext requires a nonzero upsert result.insertId even when the context already exists.
- Inspect production schema and reproduce duplicate-key upserts in connection-local temporary tables only; do not post or persist test content.
- Separate source fix from reproduction, and verify new/existing/concurrently created contexts with regression tests.

Confirmed twice on production MySQL 8.0.46, in a separate scratch database removed
afterward: an ordinary duplicate-key upsert returns the existing ID, while adding
the same AFTER UPDATE revision trigger as ranking_contexts makes the returned
insertId zero. The row still exists. The fix avoids an unnecessary upsert for
existing contexts and uses a current locking read after the concurrent-create case.

## Verification and Release

- Full unit suite: 1,718 tests passed; no failures. The outdated chooser selector assertion was updated to the new keyboard-accessible preview entry.
- Modified JavaScript files pass lint. Whole-repository lint reports an unrelated existing unused writeFile import in scripts/import-scale-official.mjs; that concurrent task's file was left unchanged.
- Source and production-bundled UI: Chromium at 1440, 390 and 320px; WebKit at 390px. WebKit localhost responses were buffered by the test harness to avoid the local chunked-document issue.
- Verified numbered browsing, plain names while editing, trash icons, square dynamic-group bottoms, 160ms reorder motion, connection rows hidden during dragging, configuration keyboard access, posting, panel logo placement, typography, a 440px resizable plaintext field and return navigation.
- Actual service code on production MySQL passes five isolated cases: existing, newly created and reused contexts, replies, and concurrent creation with the revision trigger. Repeated with the staged candidate and deployed source. All test messages were in a separate scratch database, removed afterward.
- Release ui-discussion-20261012-1791776333496: 18 files, 88 unchanged build-source guards, automatic backup and passing service health. No production business-data modifications.
- Live range/available endpoints return 200 with 40 benchmark rows and 25 ranking entries. Chromium desktop/mobile confirms panel branding, left-aligned form actions, breadcrumb removal and Back navigation. The authenticated textarea workflow was tested in the local fixture rather than impersonating a live user.
- Reports and screenshots: D:/Codex-artifacts/website1/ui-discussion-20261012.
