# Frontend refactor — 2026-09-05

## Recovery

The local, unsubmitted product was preserved in commit `76ef8e0`, tagged
`frontend-baseline-20260905`, before implementation. Work is local on
`refactor/frontend-modules-20260905`. Nothing is pushed. Database schema and server
behavior are outside this change.

To inspect the original safely in a separate directory:

```powershell
git worktree add --detach ../website1-frontend-baseline frontend-baseline-20260905
```

This checks out source only; local credentials and dependencies are intentionally
not copied. To undo the finished refactor in the active checkout, revert its
implementation commit(s), preserving the baseline snapshot and later history.
The implementation is tagged `frontend-refactor-20260906`. With a clean working
tree, roll back the single implementation commit, then restore dependencies:

```powershell
git revert frontend-refactor-20260906
npm ci
```

Do not revert the baseline snapshot: it preserves work that existed before this
task. Neither command changes the database schema or database records. Local
credentials remain outside version control throughout.

## Design contract

The user explicitly superseded the older image reference for this revision.

| Field | Decision |
| --- | --- |
| Screen job | Compare model evidence under a chosen benchmark allocation. |
| Primary user/action | A model evaluator inspects public weights, then edits their personal allocation. |
| Hierarchy | Category/context; weight source and allocation; benchmark selection; model results and source details. |
| Navigation | Persistent category rail; distinct allocation, benchmark, and model regions. Compact screens switch between allocation/benchmarks and model results without losing state. |
| Visual language | Warm off-white canvas, white working surfaces, dark green active controls, graphite text, tabular numbers, thin separators, 6–12 px radii, restrained motion. |
| States | Loading, empty public/personal data, unauthenticated, saving, conflict, network failure/retry, fallback, source details, pending contribution, reviewer/senior permissions. |
| Responsive | Desktop three working regions; tablet two-column composition; mobile sticky navigation and separately selectable results. All operations remain reachable. |
| Evidence | Repository workflows and API contracts; public indexed UIZZE references below. Screen URLs returned 410 during inspection, so no screenshot-level borrowing is claimed. |
| Forbidden defaults | Decorative metric cards, fabricated data in production, oversized marketing hero, hidden source controls, changed scoring rules, framework rewrite. |
| Acceptance | Existing contracts pass after module-aware adaptation; direct module tests; actual Chromium flows using isolated API fixtures; desktop/mobile visual review; no backend/database changes. |

## Reference evidence and limits

- [Apollo filter contacts](https://uizze.com/screens/6995634a0013a4ec6281): indexed description identifies search and compact filters. Transfer filter locality; do not copy CRM terminology or dark styling.
- [Whop chat workspace](https://uizze.com/screens/69ac7f5c0011355a63dd): indexed description separates navigation and working content. Transfer persistent navigation; do not copy messaging layout or branding.
- [Revolut owner dashboard](https://uizze.com/screens/699b447d001169993d53): indexed description exposes permission-scoped controls. Transfer explicit action availability; do not copy financial cards or dark palette.

These are limited textual references. The product flows and rendered BenchPoll
pages are the primary evidence for the final design.

## Module boundaries

- `workspace/state.js`: fresh state for one workspace.
- `workspace/contracts.js`: server response validation without DOM dependencies.
- `workspace/weights.js`: allocation arithmetic, snapshots, geometry and labels.
- `workspace/pie-renderer.js`: SVG creation/animation with explicit selection callback.
- `workspace/model-list.js`, `model-scores.js`: leaderboard and evidence dialog views.
- `workspace/links.js`: contribution link contracts.
- `shared/http.js`: JSON transport with structured failures.
- `shared/workspace-channel.js`: category/weight coordination without window globals.
- `shared/mobile-panels.js`, `page-header.js`, `overlays.js`: responsive navigation,
  shared branding and keyboard focus management.
- `contribution/contracts.js`, `fields.js`: catalogue validation and field conversion.

Page entry modules retain orchestration and business interactions. Module imports
are native browser ES modules; no build service is required.

## Intentional behavior changes

- Mobile screens switch explicitly between weights/benchmarks and model results;
  both views retain the same workspace state.
- Locked contribution categories no longer disable mobile account/help navigation.
- Moderation overlays support focus containment, Escape and focus return. Approval,
  SQL preview, and role authorization continue to use the original API workflow.
- Pinned Font Awesome assets are local. Icons work without a third-party CDN.

The ranking formulas, lower-bound ordering, condition identity, source-score
medians, direct-only Fallback semantics, 100% allocations, save revisions,
contribution payloads and server permissions are unchanged. The same framework
and URLs are retained. `home.css` is no longer loaded by the homepage.

## Verification

- `npm run lint`: includes every browser JS module, with undefined-variable checks.
- `npm test`: 163 passing checks, including direct module behavior tests. Existing
  structural tests now follow local JS/CSS imports; obsolete colors and layout
  dimensions were updated to the new design. Server/domain contracts remain.
- `npm run test:frontend`: 18 Chromium scenarios against the real HTML, JS and CSS
  served with isolated API fixtures. Covers desktop evidence/links/search, weight
  save/undo/Fallback, failed saves, revision conflict, category save ordering,
  context selection, guests/welcome, empty/error/loading/retry, widths 320–1920,
  all ten contribution modes, new benchmark validation/submission, touch gestures,
  account actions, reviewer permissions and moderation approval.
- Extracted function audit: 55 of 56 moved function bodies are token-equivalent
  to the baseline. `drawPie` delegates selection to an injected callback; the
  callback retains the original save/selection sequence. Palette constants changed.
- No changes to `server.js`, `ranking-service.js`, `moderation-admin.js`, `db.js`
  or migrations relative to the baseline.

Generated evidence lives in `artifacts/frontend/`: `results.json`, desktop/tablet/
mobile homepage screenshots, personal Fallback, score evidence, contribution,
moderation, welcome, empty and error states. Data in these images is synthetic.

Actual GitHub login, MySQL transactions and SMTP delivery were not exercised;
no production data or credentials were used. Chromium was tested; independent
Safari/Firefox validation remains outside this run.
