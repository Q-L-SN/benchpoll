# Configuration Sidebar, 2026-10-22

## Context Map

| Files to modify | Purpose and boundary |
| --- | --- |
| `private/home.html` | Configuration shell, Topics labels, account entry, remove presentation/composition markup |
| `public/js/home.js` | Flat topic routing/bootstrap, account identity and profile integration |
| `public/js/home-workspace.js` | Standard pie/benchmark/model workflow only, flat topic identity |
| `public/js/navigation/sidebar.js`, `model.js`, `preferences.js` | Popular/Recent/My Pies, scoped visit history, search, canonical ID URLs, private creation |
| `public/js/shared/config-sidebar.js` | Persistent desktop collapse and single-brand staged handoff |
| `public/css/ui/config-sidebar.css`, `workspace-layout.css` | Desktop centering, motion, responsive shell |

Dependencies reviewed: `shared/taxonomy-drawer.js` owns mobile drawer motion;
`discussion.js` owns panel behavior and captures/moves the original sidebar brand;
`workspace/contracts.js` validates server workspace data;
`shared/profile-editor.js` is supplied by another agent. Do not edit these files here.
The root homepage, backend and shared profile service/editor are separate workstreams.

Existing test references: `test/navigation.test.mjs`, `test/category-search.test.mjs`,
`test/account-identity.test.mjs`, `scripts/frontend/server.mjs` and `fixtures.mjs`.
Existing UI references: `ui/navigation.css`, `ui/shell.css`, `workspace-layout.css`,
`shared/account-identity.js` and `workspace/discussion-entry.js`.

Risk assessment: no database migration; canonical public URLs change; backend flat
navigation and workspace contracts must land together. Dirty worktree changes are retained.

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Configure weights and inspect the resulting benchmark/model ranking for one topic |
| Primary action | Adjust the Personal Pie, with Public Weights and fallback inspection retained |
| Hierarchy | Topic identity, weight source, pie/benchmarks/model results |
| Navigation | Flat Popular/Recent/My Pies; ID54 pinned, remaining server order preserved; exact numeric/context identity; private creation |
| Visual language | Existing tokens, Font Awesome icons, quiet secondary controls, no accent side stripes |
| Motion | Fade the outgoing brand, resize sidebar space, reserve header-brand width, fade in; reverse in opposite order |
| Required states | Loading, empty, retry, private owner checks, unavailable saved Pie, storage unavailable |
| Responsive behavior | Desktop collapse preference; mobile drawer remains independent; discussion panel keeps its existing brand placement |
| Evidence | Repository patterns above; https://uizze.com/?platform=Web was accessible but did not expose inspectable catalogue screens through browsing |
| Forbidden defaults | Showcase/overview entry, chart switch, Public composition, hierarchy expanders, duplicate logos, decorative accent borders |
| Acceptance | 1440/1280/1024/390/320 layouts, centered expanded workspace after collapse, stable headline Y, reduced motion, discussions/details and profile updates |

## Integration Contracts

- `/api/get_category_navigation` returns `{ items, entries, flat: true }`; navigation
  entries use the existing shape with a single lineage node. `popularity` is metadata,
  not the Public Weights participant count. The frontend preserves the server's
  heat/exploration order and only enforces ID54 first.
- Public URLs are `/topics/:ID/:slug`; ID-only routes are accepted and normalized.
  Private URLs remain `/personal/:ID`.
- `/api/get_topic` accepts `{ categoryID }` and returns topic metadata. The existing
  `/api/get_page/topics/:ID/:slug` bootstrap supports `{ treeOnly: true }` and a flat
  `categoryTree` plus `currentCategoryID`.
- Workspace payloads supply the context and dimensions. `publicPie.composition` is
  no longer consumed and its validator has been removed by the parent.
- The profile editor exports `openProfileEditor({ profile, onSaved })`, returning
  effective `userName`/`userProfilePictureURL`; document `benchpoll:profile-updated`
  is handled only for the currently bound account. Writes use `expectedUserID`.
- Shared `page-header.js` was inspected: its current brand link is `/`, not
  `/Intelligence`. Shared discussion copy is owned by the discussion agent.

## Recent And Configured Semantics

- Recent uses `benchpoll-sidebar-recent-v1:guest` or
  `benchpoll-sidebar-recent-v1:user:<exact-user-ID>` in local storage. Each of up to
  80 records contains only `categoryID`, canonical `contextValues`, `isPrivate`,
  and `visitedAt`. Topic names, profile data and URLs are not stored.
- Visits are recorded from successful workspace snapshots, not clicks, metadata
  requests, errors, mode switches, saves or refreshes of the same current identity.
  A later return to a different topic/context records a new MRU timestamp.
- The account must match the shared account write scope. Private recent entries
  are resolved through the current account's private-topic API and revalidated
  when entering Recent. Other accounts and guests cannot inherit private names.
- A completed visit updates storage immediately. Visible MRU reordering waits
  while a navigation is pending or pointer/keyboard focus remains in the list.
  It resumes after leaving the list or entering Recent again.
- My Pies contains only the backend's nonempty saved-Pie entries. Explicit
  `weightCount: 0` is filtered defensively, for both public and private topics.
  A successful snapshot adds a location only when `hasPersonalWeights` confirms
  actual saved weights. The currently browsed topic is never inserted by itself.
- Empty private topics remain accessible through Home or Recent, not through a
  fabricated My Pies row. Private-topic creation and `expectedUserID` are retained.
- The configuration entry unconditionally sets `workspaceDisplay = 'standard'`.
  Stored `charts` preferences are ignored and `view` is removed from topic URLs.

## Parent-Owned Follow-Up

- The parent has removed the unused `publicComposition` and
  `publicCompositionVisible` defaults from `workspace/state.js`. The display
  preference functions in `workspace/preferences.js` have no remaining app
  callers; the configuration does not need them.
- At inspection time, `buildPersonalNavigation` filtered `weightCount > 0` but
  did not include `weightCount` in its output. Missing counts remain compatible
  with that backend guarantee; expose the count to make the frontend check
  independent of it. Explicit zero-count entries are already rejected.
- Shared discussion rendering still formats canonical `categoryPath` as a label
  in some places. The discussion agent should use `categoryName` or the single
  lineage display node. `benchpoll:context-weights` now also carries `categoryName`.
- No backend, database, root-homepage, shared profile editor/service, or
  `discussion.js` files were changed in this task. No commit or deployment.

## Verification

Passed:

- ESLint over all changed JavaScript and focused tests.
- `node --test test/config-sidebar-20261022.test.mjs test/account-identity.test.mjs`:
  16 tests passed.
- Follow-up legacy-contract run: `category-search`, `home-change-ui-contract`,
  `ui-components`, `task-taxonomy-update`, `quiet-actions`, plus the two focused
  files above: 39 tests passed, zero failures. Before the updates, the five
  requested legacy files had eight outdated assertion failures.
- Updated tests retain public/private search separation, numeric topic identities,
  independent single-node lineage, English display names, aggregate-only
  popularity metadata, three accessible navigation modes, and public fallback
  inspection without restoring Public composition. Recent scope and persistence
  behavior remain covered by the focused unit and browser suites.
- `node test/config-sidebar-20261022.browser.mjs`: Chromium at
  1440/1280/1024/390/320 by 900 pixels, including staged and reduced motion,
  single-brand ownership, stable public/personal headline Y, centered wider
  workspace, drawer operation, discussion and benchmark information/score panels,
  profile name/avatar updates and account-owner rejection, public fallback picker,
  Popular order, Recent persistence/context identity/no-jump/failure behavior,
  guest/account isolation, and empty private-topic creation without a fake Pie.
- Three-mode controls have accessible names, 40px desktop/44px mobile hit heights,
  and no overflowing labels. Old `charts` storage is seeded during browser tests
  and never activates chart rendering.
- Sixteen screenshots and animation-frame measurements are generated under
  `artifacts/config-sidebar-20261022/`. Desktop, narrow desktop, and mobile outputs
  were visually inspected. Test endpoints and records are synthetic, not live data.

The focused harness can serve an isolated configuration preview with:

```powershell
$env:CONFIG_SIDEBAR_PREVIEW_PORT = '1428'
node test/config-sidebar-20261022.browser.mjs --serve
```

This preview does not provide the separately owned root homepage or a database.
Only the four requested legacy files listed below were edited in the follow-up.
`home-change-ui-contract.test.mjs` was already passing on current disk and was
left unchanged. The parent/Euler owns `navigation.test.mjs`; the parent owns
root/profile CSP/startup fixture integration. The full repository suite and live
deployment were not claimed green by this task.

## Changed Files

- `private/home.html`
- `public/js/home.js`
- `public/js/home-workspace.js`
- `public/js/navigation/sidebar.js`
- `public/js/navigation/model.js`
- `public/js/navigation/preferences.js`
- `public/js/shared/config-sidebar.js` (new)
- `public/css/workspace-layout.css`
- `public/css/ui/config-sidebar.css` (new)
- `test/config-sidebar-20261022.test.mjs` (new)
- `test/config-sidebar-20261022.browser.mjs` (new)
- `test/helpers/config-sidebar-fixture-20261022.mjs` (new)
- `test/category-search.test.mjs`
- `test/ui-components.test.mjs`
- `test/task-taxonomy-update.test.mjs`
- `test/quiet-actions.test.mjs`
- `docs/config-sidebar-20261022.md` (new)
