# Showcase Return From Public Composition

## Context Map

| File | Role | Scope |
| --- | --- | --- |
| `public/js/home-workspace.js` | View changes and Public composition visibility | Keep the formal composition subview out of the overview. |
| `public/js/workspace/showcase-view.js` | Overview entry, scroll scenes and exit | Reference existing entry and handoff behavior. |
| `public/js/workspace/chart-workspace.js` | Shared read-only weight charts | Verify weight content and layout remain unchanged. |
| `public/css/ui/chart-workspace.css` | Read-only view layout | Inspect exclusions for formal-only content. |
| `public/js/workspace/public-composition.js` | Category contribution pie/list | Preserve formal composition selection. |
| `scripts/frontend/showcase-composition-20261021.mjs` | Reproduction and regression | Exercise composition, overview entry, data scene and return. |
| `test/showcase-view.test.mjs` | Existing overview contracts | Add a narrow visibility regression if needed. |

Dependencies: `renderAll()` calls `renderModeState()` before the chart and
overview renderers. `setWorkspaceDisplay()` changes display without changing the
ranking inputs. Composition uses a second SVG inside the pie stage and a category
list outside that stage. The charts stylesheet hides the stage, but currently
does not exclude the category list.

Risk: frontend view state only. No scoring changes, API changes, stored weight
writes, database migration or account actions. The shared dirty worktree must be
preserved. Map reviewed against the current renderer order and DOM before repair.

## Reproduction Brief

- Target: local fixture preview, dirty worktree based on `d1511a7`.
- Expected: entering the overview from View composition shows only benchmark
  weights and the model chart. Returning to the formal view remains usable.
- Reported actual: abnormal overview display after View composition. Initially
  unverified; do not treat the suspected category-list leak as proven yet.
- Minimal steps: open the formal Public view, open View composition, then use
  the heading or mobile pull gesture to return to the overview.
- Safe next check: run the browser reproduction twice before changing runtime
  code and record visible composition content and chart bounds.

Reproduced twice at 1440x900 and once each at 390x844 with normal and reduced
motion. The unwanted category list is 163 px tall in every case. On mobile it
reduces the benchmark-weight viewport to 72 px. There are no page errors or
unexpected ranking calculations: this is leaked formal-view content, not missing
scores. Before screenshots and measurements are in the `before-1`, `before-2`
and `before-mobile` directories under
`D:/Codex-artifacts/website1/showcase-composition-20261021/`.

The reproduction phase is complete. Repair uses display-aware composition
visibility rather than discarding the user's formal-view selection. Both the
composition SVG and category list are hidden in the overview; the existing
selection is restored when returning to the formal view.

The local WebKit renderer also closes its page during the old native root-view
transition, with or without composition open. This reproduces with normal motion
but not reduced motion. Use the existing opacity-only transition consistently;
do not add a temporary transform to an ancestor of the fixed overview charts.
The scroll scenes and intentional scroll-to-formal handoff stay unchanged.

## Additional Requested Changes

- Default new/invalid browser preferences to Available results and put that option
  first, while keeping a user's explicit saved Score range choice.
- Narrow model columns, replace brightness hover with plot-background hover,
  and enlarge the plot area on phones without clipping names or creator marks.
- Remove the numeric AGI teaser and use the statement "AGI needs a public standard."
- Inspect actual touch scrolling inside weights before attributing page movement
  to performance; preserve deliberate page scrolling when starting at an edge.
- Replace the weight-expansion plus action with clear show-more semantics.

Additional owned modules: preferences/state, homepage markup, the two showcase
chart stylesheets and chart-workspace renderer. Startup and its strict CSP hash
must be rebuilt/reviewed together when preference defaults change. Two scoped
workers handle the disjoint visual and default/copy modules; the parent owns
view transitions, scrolling, integration, release and verification.

Real Chromium touch input confirms that gestures starting inside the list already
stay in the list and new outward gestures at its edges scroll the page. The
heading is outside the native scroll viewport, however: starting there moves the
page by 70 px without moving the list. A small panel-scoped handler forwards only
heading/gutter gestures to the existing viewport. The contents retain native
scrolling, controls/pinch/horizontal input are not intercepted, and a new gesture
at an edge remains native page scrolling. The seven real-touch cases pass after
this change, including the previously failing heading case.

## Local Verification Interruption

C: ran out of disk space during the first full-suite attempt. That run was
stopped rather than reported as passing. Unreferenced generated home bundles
were archived to D:, with the active manifest's files preserved; subsequent
temporary test/browser directories use D:. A failed write truncated the release
helper, which was restored from the source read earlier in this task before
adding the new guarded release scope. No production data or user files were
deleted. Native WebKit transition crashes were reproduced again after space was
available, so they are not attributed solely to the storage interruption.

## Final Visual Contract

The AGI teaser is a statement, not a question or a numerical certification claim.
Model-column hover and keyboard focus shade only the plotting lane: the shade
stops at the chart baseline and leaves the vendor mark and model name unchanged.
The existing creator colors are not brightened. Column widths, chart geometry,
click targets and score values do not change in this refinement. Reduced-motion
preferences also disable the plot-background transition.

## Release Gates

The first guarded release, `showcase-20261012-1792555671882`, installed the
composition, preference, layout and weight-gesture fixes. It verified 14 installed
files and 100 unchanged build sources, passed health checks and made no database
changes. Three live Chromium/WebKit checks passed, including the composition
round trip without ranking recalculation or a ranking-updated notice.

The final copy/hover refinement is independently captured against that live
baseline. Its reviewed diff contains only `private/home.html` and
`public/css/ui/chart-workspace.css`; SHA-256 is
`6767d74d5530d039a19e99c3fcd0e7c46771f6c154843c185f8dfbcc47868da2`.
The release helper accepts a validated revision name so this capture does not
overwrite the original evidence. The existing staged installer checks source
hashes before replacement and preserves concurrent changes during rollback.

Local verification after the refinement: 2,195 passing tests, zero failures and
two existing optional skips. Fourteen Chromium/WebKit chart cases pass in both
scoring modes, including short screens and reduced motion. They check plot-only
hover/focus, label and logo bounds, mobile chart height, internal weight scrolling
and explicit ten-item expansion. Targeted ESLint checks pass. Artifacts are under
`D:/Codex-artifacts/website1/showcase-composition-20261021/plot-hover-visuals/`.

The refinement candidate rebuilds 109 guarded sources into eight assets. The
reviewed startup CSP hash is unchanged and verified against the exact built HTML.
Deployment remains gated on the candidate browser round trip, installed-file
hashes, application health and fresh public-site checks. A failed gate must stop
the release; no concurrent-source guard may be bypassed.

## Final Deployment Verification

The exact candidate passed all seven Chromium/WebKit composition round trips.
Release `showcase-20261012-1792581975368` then installed five source/generated
files with 107 unchanged-source guards. Installed hashes and application health
passed; no restart or database changes were needed. Recoverable prior files are
in `/home/ubuntu/benchpoll-code-backups/showcase-20261012-1792581975368/`.

Three fresh anonymous public-site checks passed at Chromium 1440x900,
Chromium 390x844 and WebKit 390x844. They verified Available results as the new
default, option order, hidden composition content in the overview, preserved
composition selection on return, compact columns, mobile plot height and no
extra ranking calculations, saves, update notices, page errors or page overflow.
Desktop hover checks confirm only the plot background changes. All three also
loaded AGI and verified the final statement with no percentage teaser. These are
headless browser/input checks, not a claim of physical-device testing.

Final public screenshots and results are in
`D:/Codex-artifacts/website1/showcase-composition-20261021/live-plot-hover/`;
candidate results are in the adjacent `candidate-plot-hover-browser/` directory.
The local generated homepage assets were also rebuilt successfully. User-open
browser pages were not changed, and unrelated worktree changes were preserved.
