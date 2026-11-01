# Topic Directory Refinement

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Compare topic previews and open a precise model ranking. |
| Primary action | Open a topic or model; topic creation remains in Created by me. |
| Content hierarchy | Restore "Which AI benchmarks should count?"; community topic creation and weighting belong in the prominent subtitle. Remove the eyebrow and hero action pair. |
| Navigation | Popular, Recent, Created by me, Configured by me and Search use the same button treatment. Created uses an author icon; Configured uses the personal/user icon. |
| Floating controls | One sticky owner contains navigation above compact preview controls. Neither child is independently sticky; no full-width opaque ribbon crosses charts. |
| Topic structure | Creator attribution begins with "Created by". Previous/next controls sit in the header, never a footer. Fixed-height cards retain centered whole initial model columns. |
| Visual language | Open, Outline, Soft and Lift topic surfaces are neutral. Soft color, Paper, Frost, Outline, Hatch and Vivid treemaps use black labels. Retire Ink; preserve readable contrasts and the existing fade/area rules. |
| Required states | Loading, error/retry, paged preview, stale snapshot, empty/guest collections, saved appearance and keyboard focus. |
| Responsive behavior | Narrower columns show more models without cutting initial columns. Parameter values still reserve their required width. Compact navigation uses five equal icon buttons when full labels cannot fit. |
| Evidence | The user's two screenshots and existing BenchPoll browser captures. UIZZE/Explore was inspected but exposed no usable screen references, so no catalogue design evidence is claimed. |
| Forbidden defaults | No colored topic surfaces, accent strips/crescents, nested decorative cards, viewport-scaled text or persistent automatic focus outline. |
| Acceptance | Header pagination; six selectable treemaps and four neutral surfaces; no Ink/eyebrow/hero actions; equal navigation buttons; one transient model highlight; stable dock geometry at 320 through 1440 pixels. |

## Model Focus Reproduction

The reported sequence was reproduced twice per engine: the 4px rounded temporary highlight ended, exposing a 0px-radius native focus outline that remained. Automatic navigation focus is now tracked separately from keyboard input. Timed checks confirm a single transient 4px highlight, no residual automatic outline/background, and visible real keyboard focus. Wheel cancellation and reduced motion remain supported.

## Release Checks

Use source and actual bundled browser checks in Chromium and WebKit, focused unit tests, full regression, and a hash-guarded UI-only public release. Preserve concurrent work and existing database records; this change requires no data migration.

## Verification And Release

- Full regression: 2,393 passed, two opt-in checks skipped; changed JavaScript, tests and operational tooling passed ESLint.
- Source and actual CLI-built Home both passed Chromium/WebKit checks at 320, 390, 768, 1024, 1280 and 1440px, including chart pixels, complete centered columns, all six tree themes, all four neutral surfaces, persisted selection, search, paging, expired snapshots and account actions.
- Model-focus checks passed 121 focused unit cases, 16 timed style cases and four source/built integration suites across Chromium and WebKit. Sidebar checks passed 45 focused unit cases plus 320/390/1280 browser checks.
- At 1440px the featured fixture shows 22 whole columns instead of 16; at 390px it shows five instead of four. Parameter-width reservations still take precedence over density.
- Published `topics-refinement-20261024-1792814786209` at 2026-10-24 04:10:51 UTC (12:10:51 Asia/Shanghai). Eight UI sources and eight generated artifacts were installed. Production capture found no concurrent differences.
- Public Chromium/WebKit checks passed at 390/1440px: matching five-button treatment, one sticky owner, creator attribution, header paging, six tree/four surface options, model focus with no second outline after 2.1s, sidebar collapse and discussions.
- Post-release SHA-256 verification matched all 16 installed files and 163 unchanged dependencies. The application is active; the score-import timer stayed active and was not restarted. No database migration, backend replacement or scoring change was performed.

Code before-images and their manifest are stored in `/home/ubuntu/benchpoll-code-backups/topics-refinement-20261024-1792814786209`. UI-only rollout refuses backend files, migration requests, unsafe paths and changed dependencies. Rollback restores only bytes still owned by this release and preserves concurrent edits. Browser and fixture processes used for verification were closed.
