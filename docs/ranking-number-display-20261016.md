# Ranking Number Display and Short Bar Labels

## Context Map

### Files to Modify
| File | Purpose | Changes |
| --- | --- | --- |
| `public/js/shared/ranking-number.js` | Shared ranking display formatter | Round displayed scores and percentages to whole numbers. |
| `public/js/workspace/model-list.js` | Standard model ranking | Round score labels, tooltip scores, coverage and accessible descriptions. |
| `public/js/workspace/model-bar-chart.js` | Overview model ranking | Use the same formatting for columns, axis labels and tooltips. |
| `public/js/workspace/chart-workspace.js` | Overview weight ranking | Round weight labels and tooltips. |
| `public/js/workspace/model-scores.js` | Ranking evidence dialog | Keep the headline total consistent with the ranking. Preserve raw evidence precision. |
| `public/js/shared/bar-label.js` | Endpoint label layout | Move short-bar labels outside by default instead of hiding them. |
| `public/css/ui/workspace.css` | Shared endpoint label styles | Apply outside placement and dark text to both weight and score bars. |
| `public/css/ui/score-colors.css` | Vendor score colors | Remove the score-only duplicate label positioning rule. |

### Dependencies
| File | Relationship |
| --- | --- |
| `public/js/home-workspace.js` | Mounts the three ranking views and evidence dialog. |
| `scripts/build-home-assets.mjs` | Bundles changed imports and shared styles. |
| `ops/stage-available-release.mjs` | Produces guarded deployment assets. |

### Tests
| Test | Coverage |
| --- | --- |
| `test/ranking-number-display.test.mjs` | Rounding, source usage and unchanged calculation inputs. |
| `test/score-colors.test.mjs` | Vendor colors and shared outside-label rule. |
| `scripts/frontend/ranking-number-display-20261016.mjs` | Desktop/mobile labels, short bars, resize, tooltips, modes and geometry. |
| Existing chart and ranking browser checks | Weight pagination, ordering and ranking layouts. |

### Reference Patterns
| File | Pattern |
| --- | --- |
| `public/js/workspace/model-list.js` | Already opts into outside labels for short model bars. |
| `public/js/shared/bar-label.js` | ResizeObserver measures actual text width without changing bar lengths. |

## Scope Review

- Presentation changes only; no public API, database, score calculations, saved weights or ordering changes.
- Whole-number rounding is applied at rendering time, not to the data or geometry.
- Raw benchmark scores in evidence views and contribution forms keep their precision.
- Zero and small positive weights may display as `0%`; the underlying nonzero weight remains unchanged.
- Outside labels use neutral dark text and no decorative accent borders.

## Verification and Release

- Full suite: 1,853 tests passed, no failures or skips. Scoped ESLint and whitespace checks passed.
- Source, production-built candidate and deployed assets passed Chromium at 1440/390/320px and WebKit at 390px.
- Checks cover rounding thresholds, negative scores, unchanged order and precise bar geometry, short labels, resize and headline totals.
- Existing overview pagination checks also passed in all four browser configurations.
- Browser fixture checks redirect every API request to local synthetic data; they do not modify production records.
- Deployed release: `showcase-20261012-1792128644977`; 12 files installed with 100 unchanged build-source guards. Health and installed hashes passed; no database changes or service restart were needed.
- Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792128644977`.
- Evidence: `D:/Codex-artifacts/website1/ranking-number-display-20261016/`.

## Score Range Follow-Up Context Map

| File | Change |
| --- | --- |
| `public/js/workspace/model-list.js` | Mount the existing endpoint label in both score modes; keep score intervals and scales unchanged. |
| `public/css/ui/workspace.css` | Share thick bars, compact corners and inline score styles across both modes. Preserve signed-range separation. |
| `public/css/site-palette.css` | Remove obsolete overrides that force dark score labels and a full-width track background. |
| `scripts/frontend/ranking-number-display-20261016.mjs` | Check short/long labels in Score range as well as Available results. |
| `scripts/frontend/score-bar-continuity.mjs` | Check positive, zero, negative and uncertain intervals, including their actual rendered joins and labels. |
| `test/ranking-number-display.test.mjs` | Require inline labels in both score modes and a shared track style. |

Reviewed scope: presentation only. Score range retains its real scale and gray uncertainty interval; only Available results uses leader-relative scaling. Raw score positions, calculation, ranking order and saved weights are unchanged.

### Follow-Up Verification and Deployment

- Source and built-candidate checks passed Chromium at 1440/390/320px and WebKit at 390px, followed by the same checks against deployed assets with synthetic APIs.
- The interval continuity checks passed all seven cases in Chromium and WebKit at 1440/390/320px, including negative scores, zero scores, no measured contribution, values above 100 and the colored/gray join pixel checks.
- Full suite after the concurrent email diagnostic patch completed: 1,860 passed, no failures or skips. Scoped lint and whitespace checks passed.
- Deployed release: `showcase-20261012-1792158255789`; seven files installed with 105 unchanged build-source guards; healthy, no database changes or restart.
- Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792158255789`.
- Evidence: `D:/Codex-artifacts/website1/score-range-display-20261016/`.
