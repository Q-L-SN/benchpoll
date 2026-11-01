# Sidebar Guide Links

## Context Map

| File | Role | Change |
| --- | --- | --- |
| `private/home.html` | Homepage sidebar markup | Move How it works above Beta under the brand; move its question icon after the text. |
| `public/css/ui/navigation.css` | Navigation layout | Share a compact link group; hide it only in the collapsed mobile header. |
| `public/css/ui/showcase.css` | Overview sidebar overrides | Remove the old direct-child Beta layout rule. |
| `test/pie-controls.test.mjs` | Existing navigation contracts | Replace the obsolete mobile-header Beta expectation. |
| `public/js/workspace/model-list.js` | Available-results row rendering | Replace visible coverage text with a named miniature pie. |
| `public/css/ui/workspace.css` | Coverage indicator layout | Keep the pie a stable 16px circle beside the model name. |
| `test/coverage-pie.test.mjs` | Miniature-pie rendering | Test endpoints, fractional values, invalid values and accessibility. |
| `scripts/frontend/sidebar-coverage-20261021.mjs` | Browser regression | Check desktop, mobile header/drawer, overview drawer, coverage pies and links. |
| `public/css/ui/control-policy.css` | Shared input focus policy | Fill the whole framed control and keep its inner input transparent. |
| `public/js/workspace/model-scores.js` | Detailed-score search | Match prompt, empty state and filtering to the current evidence level. |

Dependencies reviewed: `ui-components.js` already enhances both quiet actions;
`components.css` supplies spacing, inherited icon color and keyboard focus;
`taxonomy-drawer.js` owns opening/closing without relocating these links.
`shell.css` provides the sidebar/header breakpoints. Existing navigation and
overview overrides must not make the hidden mobile header group visible.

## Design Contract

- Use the existing Beta action treatment, not a new button skin.
- Order: Logo, How it works with trailing question icon, Beta with trailing arrow,
  then category navigation. Remove the old bottom guide action and its wrapper.
- Both links are borderless, transparent and not underlined. Hover changes text
  and icon color together; keyboard focus remains visible.
- The guide label is self-explanatory; remove its old long help popover, which
  would otherwise cover Beta when the guide receives keyboard focus.
- At widths up to 760px the collapsed header contains neither link. Opening the
  standard or overview sidebar reveals both in the same order, with touch-sized
  targets. Desktop sidebars show both beneath the brand.
- Preserve the guide URL and Beta feedback prefill. No ranking, stored weight,
  account, API, database, consent or startup-script changes.
- Available-results rows use a 16px filled pie for measured weighted coverage,
  with a pale remainder. It replaces visible percentage text, not the coverage
  calculation. Exact wedge proportions remain unrounded; a short tooltip and
  accessible name retain the meaning. Score range is unchanged.

The map and contract were reviewed against the current DOM, shared quiet-action
enhancer and drawer styles before implementation. The user's correction is
explicit: mobile drawer links remain available; only the header hides them.

## Release Plan

Test the source and exact candidate bundle in Chromium and WebKit at desktop and
phone widths. Capture the current production files, review only this scope, then
build on a guarded production copy. Verify the unchanged startup CSP pin, source
guards and installed file hashes. Use the existing recoverable release installer
and stop rather than overwrite any concurrent change. Finish with fresh public
browser checks. Temporary files and screenshots belong on D: because C: is low.

## Input Focus And Score Search Follow-Up

Reported expected: focusing a framed search/input changes its whole interior,
including icon and padding areas. Reported actual: only part changes. Inspect the
existing shared `:focus-visible` input fill and the surrounding `:focus-within`
frame before repair; record repeatable browser evidence first. Target environment
is the isolated frontend fixture on the same dirty worktree, Node 22.22.1 and
Playwright Chromium/WebKit; no production data is needed for reproduction.

Detailed-score search currently visits ranking contributions, recorded model
configurations, benchmark versions, or one version's source rows. It must name
that scope rather than promising benchmarks at every level. Use scope-specific
placeholders and no-match messages, with a synchronized accessible label. A
single-version source query should filter source rows, and clearing or changing
levels must restore the appropriate rows and labels. Do not fetch other ranking
contexts or change calculation/evidence validation.

The minimal input-focus failure was reproduced twice in Chromium at 1440px.
Benchmark search kept a `rgb(250, 251, 253)` frame while the focused input changed
to `rgb(246, 247, 249)`; navigation and score searches kept white frames with the
same tinted input. The tag editor stayed white. No page errors occurred. Evidence
is in `focus-before-1` and `focus-before-2` under the D: task-artifact directory.
Repair uses the shared focus policy: the complete frame receives the focus fill
and the input remains transparent. Existing error-border colors and no-external-
frame behavior remain intact. This evidence was recorded before editing runtime
focus/search behavior.

The source-score regression also exposed adjacent text nodes being concatenated:
an index and `88%` became `188%` for numeric search. Indexing DOM text nodes with
spaces fixes this without relying on CSS visibility or altering the shared
search engine. Source URLs are searchable alongside their visible labels.
Source tests now cover all four hierarchy prompts, individual numeric-source
matches, no-match messages and restoring rows after clearing or returning.

## Verification And Release

The full regression gate caught a custom-select keyboard-focus conflict before
release: its trigger also uses `bp-ui-field`. The shared text-frame selector is
therefore constrained with `:has(input, textarea)`, retaining the select button's
existing internal focus indicator. Moderation checks now pass at all ten
Chromium/WebKit width combinations. No test was weakened to hide that regression.
The guide-link tests were deliberately updated to reflect direct navigation
without a redundant help popover.

Final full suite: 2,204 passing tests, zero failures and two existing optional
skips, out of 2,206 tests. Targeted ESLint checks passed. The exact production
candidate passed eight sidebar/coverage browser cases and four input/search
cases. These cover Chromium/WebKit, 320px phones, the 760/761px boundary,
overview and standard drawers, keyboard focus, navigation, coverage endpoints,
score-dialog activation, both scoring modes, full focus surfaces and all four
score-search levels. Test artifacts are under
`D:/Codex-artifacts/website1/sidebar-coverage-20261021/`.

The final reviewed seven-source diff has SHA-256
`b59694aaaac026152d019962fdc66607af513b9539fc8f740cb2a6f9ccdb66ec`.
Release `showcase-20261012-1792584294360` installed 11 source/generated files,
with 102 unchanged-source guards. Installed hashes and application health passed.
The startup CSP hash remains
`sha256-nLFZnYb6njLiGF8CsezKE5LUjhPhNV5VJTlHsnEBEDM=`.
No restart, database changes, email, sign-in or account actions were performed.
Recoverable prior files are in
`/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792584294360/`.
Earlier partial staging directories were not installed.

Fresh public Chromium checks passed at desktop and phone sizes, including guide
navigation, sidebar availability, coverage pies and model-dialog activation.
Public input-focus checks also passed for benchmark search, category search and
the detailed-score search at those sizes. Production contribution forms require
sign-in, so their authenticated focus behavior is covered by the isolated exact-
candidate checks rather than bypassing authentication or accepting terms.

Longer public WebKit navigation/return workflows encountered loading timeouts.
Their captured report had successful initial read responses and no page error,
but it does not establish the cause; these runs are not counted as passed
end-to-end checks. The same complete workflow passes in the isolated exact
candidate. Keep this live-run limitation separate from the source/candidate and
Chromium results. All browser runs were headless and did not alter user-open
pages. Temporary data and screenshots are on D:; C: remains critically low.

The final targeted public WebKit smoke also timed out before DOMContentLoaded
after 60 seconds. No public WebKit pass is claimed. Its exact-candidate checks
remain passing; further live navigation/network diagnosis is outside the verified
results recorded here.
