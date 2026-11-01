# Shared Select Field

## Context Map

### Files to Modify
| File | Purpose | Change |
| --- | --- | --- |
| `public/js/shared/ui-components.js` | Five public UI primitives and adoption | Mount the select adapter as a field, not a sixth primitive |
| `public/js/shared/custom-select.js` | Select field adapter | Native form backing, popup, keyboard and synchronization |
| `public/js/global.js` | Dialog lifecycle and global adoption | Start observation and coordinate Escape/Tab with dialog focus traps |
| `public/css/ui/components.css` | Shared control presentation | One select field and listbox skin |
| `public/css/site-palette.css` | Component stylesheet import | Refresh the shared stylesheet version |

### Dependencies (Read-Only)
| File | Relationship |
| --- | --- |
| `public/js/contribute.js`, `public/js/contribution/score-fields.js` | Rerendered forms, delegated native input/change handlers |
| `public/js/workspace/comparison-controls.js` | Dynamically created operators and direct value assignments |
| `public/js/discussion.js`, `public/js/workspace/benchmark-scores.js` | Version/context selectors |
| `public/js/censor.js`, `public/js/shared/overlays.js` | Disabled selectors, editor overlays and programmatic focus |
| `public/css/ui/selection.css`, `public/css/ui/control-policy.css` | Existing internal focus contract |
| `scripts/frontend/server.mjs` | Synthetic, database-free preview |

### Test Files
| File | Coverage |
| --- | --- |
| `test/custom-select.test.mjs` | Inventory, adoption, styling and native-backing contracts |
| `scripts/frontend/custom-select-20261013.mjs` | Real browser behavior, site adoption and screenshots |
| `test/ui-components.test.mjs` | Existing five primitives and search icon/padding regressions |
| `scripts/frontend/search-field-spacing-20261013.mjs` | Existing search geometry |

### Reference Patterns
| Source | Decision |
| --- | --- |
| `docs/ui-components.md` | Compact workbench; one field skin; existing Font Awesome icons |
| [WAI select-only combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-select-only/) | Focus remains on the trigger; active descendant; explicit commit and Escape cancellation |
| [HTMLSelectElement](https://developer.mozilla.org/en-US/docs/Web/API/HTMLSelectElement) | Preserve native options, form association and constraint validation |
| [UIZZE catalogue](https://uizze.com/) | Catalogue landing page was accessible, but no inspectable select screen was returned. Existing repository controls are the visual evidence; no external screen inspection is claimed |

### Risk Assessment
- Public primitive inventory and business APIs remain unchanged.
- No database, production deployment, dependency or package configuration change.
- Native form validation and overlay focus are the highest-risk behavior and require browser tests.
- Review complete: all implementation edits stay within the assigned shared files and dedicated tests/docs.

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Choose an existing form/filter value without a browser-native menu |
| Primary user and action | Contributors, readers and reviewers select an existing option |
| Content hierarchy | Field label, committed value, grouped options |
| Navigation and controls | Select-only combobox; no search field, including the template chooser |
| Visual language | Existing field border, 6px corners, compact list icon and chevron; neutral hover, tinted selection with check; internal keyboard cue |
| Required states | Empty, disabled, required/invalid, selected, active, grouped, dynamically updated |
| Responsive behavior | Touch-sized rows; wrapped menu labels; ellipsized committed value; viewport-clamped popup |
| Evidence used | Existing shared controls and the WAI interaction reference |
| Forbidden defaults | Extra skins, external focus frames, single-sided accent bars, native user-visible menus |
| Acceptance criteria | Native submission/event compatibility; dynamic adoption; Chromium desktop/mobile and WebKit mobile checks; existing search spacing unchanged |

## Verification

- `node --test test/custom-select.test.mjs test/ui-components.test.mjs test/frontend-modules.test.mjs test/help-popovers.test.mjs test/content-motion.test.mjs test/comparison-settings.test.mjs`: 38 passed. The separate `quiet-actions` suite also passed on the final concurrent-worktree state.
- Scoped ESLint passed for all three shared JavaScript modules and the dedicated test/browser script.
- `node scripts/frontend/custom-select-20261013.mjs`: six passed cases: Chromium 1440/1024/390/320px, WebKit 390px, and Chromium 390px with an old unversioned `ui-components.js` response.
- Each case checked backing invisibility, input/change and focus/blur callbacks, required/custom validation, submission data, normal/cancelled reset, fieldset/option/group disabledness, grouping, hidden options, value/selectedIndex/option/collection/prototype assignments, keyboard navigation, typeahead, outside dismissal, multiple values, dynamic adoption, clone/replacement cleanup, label changes, long text, internal focus and touch selection.
- Global dialogs, native modal dialogs and legacy editor overlays were exercised. A forced no-Popover path checked a viewport-positioned layer outside transformed custom-dialog content and inside native modal dialogs, using the same field/menu skin.
- Actual contribution, moderation and advanced-filter pages adopted the field. The parent's `Effort value` and `Harness value` selects retained their selections and focus after business rerenders. The template chooser remained search-free.
- `node scripts/frontend/search-field-spacing-20261013.mjs`: all four Chromium/WebKit cases passed. Model/search gaps stayed 12-13px and vendor search gaps stayed 8px; input padding variables and static flex icons were not changed.
- An esbuild bundle of `ui-components.js` passed with `write: false`; no business source or compiled-home file was written. Scoped `git diff --check` passed.
- Screenshots and geometry/verification JSON: `D:/Codex-artifacts/website1/custom-select-20261013/report.json` and adjacent PNG files.

## Integration Notes

- Include all five assigned source paths in the parent's release manifest. `custom-select.js` is a new transitive dependency.
- The shared module import, custom adapter import, Shadow DOM component stylesheet and palette stylesheet import use `v=custom-select-20261013`. The old-module-cache browser case deliberately served the pre-adapter API for the unversioned UI module; the versioned global import still installed and synchronized the adapter.
- Every native select is hidden by shared CSS, including before JavaScript initialization. A select-only prototype focus bridge adopts a newly attached select before forwarding immediate `.focus()` calls. Other input/element focus methods are untouched. Mounted controls keep per-instance `value`, `selectedIndex`, option-selected and focus/showPicker adapters; a single 200ms document poll covers silent native collection/prototype setters. Removed controls restore their own descriptors and release their observers.
- Native names, IDs, form association, option identities and delegated event targets remain unchanged. New user-facing selection is performed through the combobox/listbox; do not use `getByRole('combobox').selectOption()` in future browser tests. The combobox is now a button, not a visible native select.
- This task made no database calls, production requests, deployment, dependency changes, commits or edits outside the assigned shared files and dedicated tests/docs. Existing dirty work was preserved.

## Limits

- Browser checks were headless Chromium/WebKit with mobile viewport/touch emulation, not physical iOS/Android devices or screen readers. ARIA relationships and focus were exercised, but assistive-technology compatibility still needs manual validation.
- The fallback was forced in current engines; obsolete browser engines were not installed or certified.
- Full historical browser suites were not rewritten or run. Some still target visible native selects with `selectOption()` and must migrate to combobox/listbox interaction. The parent owns the complete production bundle/release validation.
