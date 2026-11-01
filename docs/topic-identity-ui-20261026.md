# Topic Identity and Shared Controls

## Context Map

| Files | Purpose | Change |
|-------|---------|--------|
| Shared UI components, custom select, shared control CSS | Field behavior | One clear-button design and larger transparent hit areas across existing and dynamic search fields |
| `public/js/shared/topics.js`, topic/private/navigation/ranking services | Topic metadata | Required one-sentence summary, creator metadata, private-account isolation |
| Dated summary migration and release helpers | Existing data | Backfill meaningful summaries, preserve existing content, backup and rehearse before publishing |
| Home HTML, `topics-home.js`, `topics-home.css` | Directory | Summary, title navigation arrow, shorter By label, lower treemap fade |
| Configuration HTML, navigation model/sidebar and CSS, workspace state | Topic workspace | Summary below headline, creator by topic name, bordered two-line navigation cards in every directory mode |
| Comparison controls CSS/markup | Effort and Harness | Transparent icon toggles with colored enabled icons and accessible state |
| Pie label layout and renderer | Compact slices | Fade-truncated name instead of percent-only labels; hover reveals the weight |
| `model-scores.js` and evidence CSS | All scores | Inline configuration disclosure and cross-configuration/version search |

Dependencies include existing account-write ownership checks, private topic
authorization, profile identity, ranking context validation, scoped recent
history, disclosure motion, search and publication hash guards. Recent history
must continue to store IDs and context values only, not summaries or profiles.

Tests cover shared fields, custom selects, topics/private topics, navigation,
ranking payloads, Pie geometry, model score search, async evidence state and
release failure handling. Existing real-browser fixtures and public checks
remain the reference patterns. The context map was reviewed before edits.

## Design Contract

| Field | Decision |
|-------|----------|
| Screen job | Find a topic, understand its scope, and inspect or configure its ranking |
| Main action | Enter a topic from a chart card or the compact sidebar catalogue |
| Hierarchy | Topic name first, one-sentence scope second; creator is quieter metadata |
| Navigation | Keep the existing directory modes, links, scroll state and sidebar width |
| Cards | Existing neutral Outline home cards; compact full-border sidebar rows, no colored edge or nested card surfaces |
| Controls | Shared clear glyph with a large transparent hit area; no hover/pressed fill; Effort/Harness use icon color, not a filled circle |
| Charts | Keep the existing data palette and relative bar scale; move only the background fade lower; preserve slice geometry and weight editing |
| Required states | Required/invalid summary, loading, empty, retry, disabled, private, account change, disclosure fetch failure and stale-response cancellation |
| Responsive | Check 320/390/768/1440 widths, touch targets, reduced motion, keyboard focus and long real names |
| Forbidden | Accent side borders, hover-heavy shadows, duplicate input crosses, text spilling into buttons, persisting profile data in history |
| Acceptance | All requested surfaces share the same summary; no blank existing topic summaries; search matches configuration headers or actual benchmark versions with the requested disclosure state |

## Work Boundaries

- Shared clear controls: dedicated worker; no Home or configuration HTML edits.
- Pie labels: dedicated worker; renderer/layout and focused tests only.
- All scores: dedicated worker; evidence UI and focused tests only.
- Parent: topic schema/API/backfill, Home/navigation/configuration integration,
  comparison toggles, final tests, build and publication.

No already-open-page compatibility layer, topic reference feature, import
feature or unrelated visual redesign is part of this request.

## Coverage Penalty Experiment

The follow-up request adds a selectable alternative to the default power factor.
With measured weighted coverage c in [0, 1], Power is c^0.35 and Rational (a=5)
is 5c/(1+4c). Both keep the same observed and pairwise-inferred scores; only the
last multiplier changes. Negative totals keep the existing mirrored loss
(2-factor), so missing coverage cannot improve a negative total. Zero measured
coverage remains incomparable. Score range is unchanged.

The selection persists on this device and is shared by Home and topic pages.
Inference version 5 selects Rational; version 4 remains the default. Home cache
keys and pagination scopes include this version. The temporary custom selector
is hidden outside Available results. This does not change saved Pie weights.

## Design Evidence

The existing neutral Outline cards and shared fields remain the visual reference.
Public UIZZE references for LinkedIn setup services, Binance security settings
and Apollo filters were discovered, but all three screen pages returned HTTP 410
when opened. No visual details are claimed from these unavailable pages. The
design contract above and real source/built browser screenshots are the verified
evidence used for this scoped revision.

## Verification

- Full suite: 2,534 passed, 0 failed, 2 opt-in checks skipped.
- Shared clear behavior: 23 unit cases and five responsive Chromium/WebKit runs,
  including transparent 44px hit targets and native/custom cross pixel checks.
- Pie labels: 3,264 geometry cases plus the existing 800-case helper after its
  name-only fallback update. No percent-only fallback remains.
- All scores: 90 focused checks and 17 isolated browser scenarios. Search and
  configuration expansion use the compact approved-version index; only an
  explicit source expansion fetches full validated evidence.
- Source and built Home charts passed six responsive geometry/pixel checks
  each. Topic identity/required summary/penalty controls passed eight browser
  layouts across Chromium and WebKit, including 320px width.
- Live Chromium checks passed on benchpoll.com at 1440px and 390px. The deployed
  origin also passed WebKit at those widths through a temporary SSH tunnel;
  Windows WebKit's direct edge connection timed out. No existing pages were used.
- Live scoring independently checked 23 matching models: both modes retained
  the same unpenalized total and Rational used exactly 5c/(1+4c).
- Actual All scores data covered 110 configurations and 4,053 version groups.
  Searches made zero full-evidence requests; explicit source expansion made one.
- Deployed-origin regression checks passed four Chromium/WebKit desktop/mobile
  runs, including sidebar centering, model focus, discussions, the guide and
  return-to-Home navigation. The task-owned SSH tunnel was closed afterwards.
- A three-table metadata-only MySQL rehearsal passed preservation, timestamp,
  idempotence, invalid-input, rollback and retry checks. The source was unchanged
  and the isolated database was removed. No score tables were cloned.
- Candidate compact-index SQL was checked on real data in a read-only
  transaction, and its built startup CSP pin was verified before release.

Published `topics-identity-ui-20261026-1793028569206` using the normal guarded
backup/migration/atomic-install flow. All 75 existing summaries were backfilled;
30 active topics remain. Frozen protected-data counts and identity/Pie/discussion
digests were verified unchanged. App health passed and the score timer was
restored. The release contains 51 installed files and 144 guarded dependencies.

Evidence is under
`D:/Codex-artifacts/website1/topic-identity-ui-20261026/`.
