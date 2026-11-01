# Coverage Pie Placement

## Context Map And Contract

| File | Responsibility |
| --- | --- |
| `public/js/workspace/model-list.js` | Attach measured-coverage indicator to the model-name part, before optional comparison parameters. |
| `public/css/ui/workspace.css` | Keep the name and 16px indicator together with a 6px gap; allow long model names to wrap within the available width. |
| `public/js/shared/comparison-display.js` | Existing name/parameter renderer and translation protection, unchanged. |
| `public/css/model-comparison.css` | Existing flexible identity and atomic parameter layout, unchanged. |
| `test/coverage-pie.test.mjs` | Proportions, accessible labels, mode gating and attachment regression. |
| `scripts/frontend/sidebar-coverage-20261021.mjs` | Actual row geometry, mode changes, click behavior and responsive browser checks. |
| `scripts/frontend/comparison-layout.mjs` | Long names and complete reasoning/harness values retain their layout. |

Expected: coverage is secondary model metadata, adjacent to the model name, not underneath the SCORE heading.
Observed: the name's `flex: 1` pushed its sibling coverage indicator to the far edge. Source Chromium screenshots reproduce this at 1440px and 390px (`D:/Codex-artifacts/website1/coverage-placement-20261022/before`).

Reuse the existing neutral indicator, tooltip and accessible label. Do not change ranking calculations, coverage proportions, bars, model-name translation protection, or other views. Range and incomparable rows still have no indicator. No schema or server configuration change.

## Rollout

Capture current production source, review the narrow diff, build with unchanged CSP policy, test the exact candidate, and install through the existing hash-guarded release helper. Source guards must refuse concurrent changes. Keep the helper's pre-write backup and rollback path; require healthy origin and public rendering after installation. No database writes or service restart are needed.

## Verification

- Focused unit checks: 16 passed. Complete suite: 2,205 passed, 2 existing optional skips, 0 failed. Log: `D:/Codex-artifacts/website1/coverage-placement-20261022/unit.log`.
- ESLint passed for the changed JavaScript and test scripts.
- Source adjacency checks passed in Chromium at 1440/390/320px. Long-name and complete reasoning/harness-value checks passed in Chromium at 1440/1024/768/390/320px and WebKit at 390/320px (`comparison-layout.mjs --labels-only`). The legacy all-controls script also enforces a single toolbar row, which the existing 1024px layout does not provide; that unrelated toolbar requirement was not changed or claimed as passing.
- Exact production candidate: 8 browser cases passed (Chromium 1440/761/760/390/320px; WebKit 1440/390/320px), including coverage proportions/geometry, click-through to score details, Range removal, Available restoration and sidebar navigation. Screenshots inspected at desktop and mobile widths. CSP startup hash matched the existing pin.
- Production Chromium smoke passed at 1440/390px after deployment, with name adjacency, native coverage explanation, score-dialog opening and no page errors. No new production WebKit claim; exact-candidate WebKit was verified locally.

## Release

Release `showcase-20261012-1792641377708`; 2 source files changed, 6 installed files including generated assets, 107 unchanged build-source guards. Reviewed diff SHA-256: `38d8d8b746bd2dad3dab0957fc0e5f843f7822d5cdf8630fd262168a48bf3add`.

Stage: `/home/ubuntu/benchpoll/scripts/showcase-view-20261012/release-coverage-placement`.
Backup: `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792641377708`.
Origin healthy; installed hashes verified by the release helper; no database change or service restart.
