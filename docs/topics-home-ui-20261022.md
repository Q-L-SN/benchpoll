# Root Topics Home: Design and Integration Contract

## Follow-Up Release: Island Directory

Recorded before the follow-up runtime edits. This supersedes the prior freeze
only for the owned root frontend/tests/fixtures. Backend, slug routes, shared
account center, sidebar and ranking target stay read-only. No deployment,
package change or commit is authorized here.

| Field | Decision |
| --- | --- |
| Screen job | Discover community topics, revisit authorized recent topics, or create/manage one's own |
| Hero | Existing large BenchPoll logo and an unframed masthead: "Your topic. Our weights." Copy emphasizes selecting topics/benchmarks and shaping weights together, never that benchmarks are useless |
| Navigation | Centered Popular / Recent / Mine / Configured / Search island below hero; sticky with a small existing logo after hero scrolls away. Search morphs in place; close/Escape restores the prior view |
| Data | Popular preserves server order with 54 pinned. Mine/configured use isMine/configured booleans. Recent reads account-scoped readRecentTopics and intersects authorized metadata, deduplicating IDs. Private entries require a confirmed account and isMine; storage never supplies names/URLs/permissions |
| Creation/account | Public/private create actions live in Mine. Prefer topic.url; shared topicURL(ID,name,isPrivate,slug) is fallback. reserved_topic_name/topic_name_exists get clear inline errors and retain drafts. Call shared openAccountCenter({profile,onProfileSaved,onSignedOut}); callbacks refresh account/topics and immediately remove private previews on sign-out |
| Controls | Existing score/reasoning/harness/view groups remain minimally changed, quiet and sticky below the directory navigation, outside prime hero space |
| Cards | Normal footer contains only prev/next arrows; retry only on error, no counts/page text. Narrower bars with 5px top corners. Fit centered white score labels to actual height/width down to 9px; dark outside-right only when physically unable to fit |
| Themes | Persistent soft multicolor/black, neutral paper/black with dividers, and restrained dark/white candidates. All retain sorted top-row multiblocks, exact D3 Slice/Dice area/Other, default fade/25% label exposure and full weights view |
| Model URL | Real native anchor based on authoritative topic.url, preserving unrelated params/hash. Set focusModel to raw comparisonIdentity or stable positive numeric modelID/ID; scoreMode=available or range, compareReasoning=1 or 0, compareHarness=1 or 0. Public cards use mode=public; private cards use mode=personal (confirmed with Boole; target also enforces verified private context). Use URLSearchParams; keep keyboard/context-menu/new-tab support |
| Preserved | Fixed card heights; centered complete snapping columns/readable full parameters; max-two lazy previews, stale guards, metadata-preserving pagination, manual bounded snapshot refresh; no external input focus frames or one-sided accent borders |
| Gate | Focused unit/lint plus native and actual CLI-built Chromium/WebKit at 320/390/768/1280/1440, retaining existing 1024 check. Screenshot/geometry/pixels cover island/search/views/create/account, low scores 16/14/11, theme persistence, fade, target URLs and privacy. Local fixtures only |

Context: the four owned runtime files, `scripts/frontend/topics-home-*.mjs`,
homepage unit tests and this document. Added read-only dependencies are
`navigation/preferences.js`, `shared/topics.js`, and worker-owned
`shared/account-center.js`. Preserve the parent's default label exposure fix
already on disk and the native/actual-build UMD adapter.

## Published Integration: 2026-10-23

The parent integrated the ordered-row handoff and added one final constraint:
default-view labels are fitted within the exposed top quarter, so a two-line
name and its share take priority over an optional version. Labels below that
band do not become faint ghost text behind model columns. Weights-only continues
to fit labels against each complete tile. The added regression checks every
rendered default label against that exposed band at all supported widths.

Final source and actual CLI-built Chrome/WebKit reports are in
`D:/Codex-artifacts/website1/flat-topics-home-20261022/topics-home-final-20261023/`
and the adjacent `-built/` directory. Both passed six widths, geometry, pixels,
parameter readability, hover, pagination, retry and snapshot recovery checks.
The exact server candidate then passed real-data desktop/mobile Chromium checks;
the published HTTPS origin passed four Chromium/WebKit desktop/mobile cases.
Public report/screenshots: the adjacent `public-browser/` directory. Runtime and
release-tool lint passed; the full application suite had 2,311 passes and two
existing opt-in skips, followed by 24 passing launcher regression scenarios.

Published release and recovery evidence is recorded in
`docs/flat-topics-home-20261022.md`. All older redesign/ordered hashes and reports
below describe their own historical handoff, not the final parent label change.

## Active Redesign: 2026-10-23

### Final Integration Corrections

The previous binary-layout freeze is superseded: it let the second-largest
weight fall below smaller rectangles in normal cards. The scoped correction uses
contiguous descending-weight row groups, with `min(entries, max(2, round(width /
200)))` entries per row. Official D3 Slice partitions row area vertically and
Dice partitions each row horizontally. The top row must contain exactly the
first N sorted entries; no lighter row can sit above a heavier entry. Existing
palette, proportional area, Other aggregation, labels, fade and 75% cap stay.

When comparison fields are enabled, the current loaded models' parameter text
is measured using the existing comparison-display parser at its normal 11px
font. Column slots may exceed the default 112px cap to fit that text plus the
shared fitter's icon/padding allowance, but never exceed chart width. Reduce
whole-column count and retain centering/snap instead of using unreadable
microtype. Default no-field density is unchanged. Acceptance must scroll to
Claude's real long harness at 320px and verify full text, icon and font >= 9px.
Only a genuine single-column physical-width limit may require further fitting.
Both native and actual CLI-compiled browser suites now pass these corrections;
the 40-character fixture harness is 11px in a centered 256px slot in both engines.

This user-requested redesign supersedes the visual decisions and screenshot
results in the original sections below; those remain a historical record.
Backend, routing/build implementation, packages and shared account/profile
modules remain read-only. Parent has paused publication.

| Contract | New decision |
| --- | --- |
| Screen job | Scan community benchmark priorities, open a canonical topic, or create one |
| Masthead | Crisp white canvas; existing large BenchPoll wordmark moves into the product header beside quiet navigation. Left-aligned exact headline/subtitle, with only 'should count' accented |
| Toolbar | One coherent desktop row for scoring, comparison, view, search and creation; two compact rows on phones. No visible Topics heading or count. Plus-only creation on narrow screens retains an explicit accessible label and tooltip |
| Topic cards | Repeated 8px cards only, no section cards or nested cards. Topic name at 20px (featured 24px), creator beside it when space permits, otherwise wrapped beneath. Normal 384px, featured 424px; 54 full-row, server order otherwise unchanged |
| Models | Default bounded whole-column density is unchanged. Fields measure parsed parameter text at 11px and may expand the slot up to chart width, reducing visible whole columns instead of making microtype. 24px contained vendor logos, 11px names and a 92px identity reserve remain. Preserve center/snap, integer score placement and the exact 75% cap/shared baseline |
| Scores and hover | White in-bar integers are horizontally and vertically centered on the colored bar itself; undersized bars retain dark outside-right labels. Pointer hover changes only a neutral plot background, never bar fill/score/logo/name styling. Static bars gain no click behavior. Assert label centers geometrically and compare local hover/rest pixels |
| Score range | One complete opaque neutral light-gray upper column shares the known column's X/width/baseline and is at least as tall, painted behind the unchanged vendor-color known column. Never splice it into segments or tint it by vendor. Assert geometry/order and actual gray/foreground pixels |
| Treemap | Official D3 Slice at the root and Dice within contiguous descending-weight row groups. Each row has up to min(entries, max(2, round(width / 200))) entries. The first N sorted weights are exactly the top row, including #2 in normal cards; wide cards show adaptive parallel blocks. Exact proportional area, deterministic ties, no equal-area fabrication or padding loss; heavier entries never sit below lighter rows |
| Theme | Fixed varied dark tiles, exclusively white labels with measured fitting and contrast checks. Other remains the exact sum of entries strictly below 1%; full membership tooltip. Only the default view fades below the exposed top quarter; weights view is full/unmasked |
| Preserved behavior | Max-two lazy requests, immediate metadata, stale-filter cancellation/ignoring, independent snapshot pagination/expiry recovery, queued retry guard, expectedUserID creation, profile integration, complete parameter values, policy links and no external input focus frame |
| Finish gate | Focused unit tests plus source and actual CLI-compiled Chrome/WebKit checks at 1440/1280/1024/768/390/320. Real pixel/geometry/label/contrast/top-count checks and visual screenshot review. No deployment or commit |

Repository evidence and the explicit new direction drive this redesign. UIZZE's
catalogue was revisited; the Apollo, GitLab and Binance screen links listed below
again returned HTTP 410, so no unseen reference screen is claimed as inspected.
The [official D3 tiler documentation](https://d3js.org/d3-hierarchy/treemap#treemapSlice)
and pinned local distribution provide Slice/Dice without adding a dependency or
changing the parent's namespace/default-or-global UMD interop behavior.

### Final Ordered-Layout Verification and Freeze

**Ready for the parent's exact-candidate rebuild and real-database rehearsal.**
Runtime work is frozen after the ordered-row/readable-fields corrections. The
parent explicitly requested no further runtime edits while exporting the isolated
candidate. No new blocker was found in final visual review. No backend, package,
node_modules, vendored D3, shared account/profile, routing or build-script edits
were made in this redesign. No deployment, staging or commit was performed here.
All fixture servers used by this pass closed with their browser contexts; no
new background preview was left running.

- Focused six-file unit suite: **55 passed, 0 failed, 0 skipped**. New assertions cover normal/wide top rows as exact sorted prefixes, area/non-overlap/Y order, and measured-slot bounds with unchanged no-field density.
- Repository-native ESLint on the owned runtime/tests/scripts: **passed**, without browser-global overrides. Parent's `globalThis` prefixes remain intact.
- Native source: **12 layouts, 14 interaction groups, 0 pageerrors**.
- Actual `node scripts/build-home-assets.mjs --index` output served as root: **12 layouts, 14 interaction groups, 0 pageerrors**.
- Both suites used Chrome Headless Shell **151.0.7922.34** and WebKit **26.5**, local HTTP fixtures with the production-shaped CSP. The real custom onLoad loader and lazy shared profile chunk were exercised; this is not only a standalone esbuild check.
- Standalone esbuild retains its previously documented static UMD no-export warnings; both native/global and actual-CLI namespace paths execute successfully.

| Width | Card columns | Complete featured model columns | Treemap rectangles touching the top |
| --- | --- | --- | --- |
| 1440 | 3 | 16 | 7 |
| 1280 | 3 | 14 | 6 |
| 1024 | 2 | 12 | 5 |
| 768 | 2 | 8 | 3 |
| 390 | 1 | 4 | 2 |
| 320 | 1 | 3 | 2 |

Geometry confirms exact proportional tiling, non-overlap, upper-left largest
tile, exactly the sorted first N weights across each normal/wide top row, fitting white
labels with at least 4.5:1 base-tile contrast, complete centered columns, and
the shared baseline/75% cap. In-bar label centers are checked on both axes
against their actual colored bar, not just color or containment. Range columns
are checked for full baseline/width overlap, upper >= known height, rear DOM
paint order and exact exposed pixels **[229,231,235]**, while known pixels retain
their vendor RGB. Hover tests change **9,845 Chrome / 9,847 WebKit plot pixels**,
**0 identity pixels** and **0 interior bar/score pixels**; the white gap changes from
[255,255,255] to [244,244,245]. No static-model click behavior was added.

The full earlier interaction coverage remains: immediate/lazy metadata, max-two
requests, stale filters despite ignored transport abort, horizontal touch/wheel/
keyboard paging, short-page auto-fill, omitted-page metadata preservation,
manual expiry recovery with fresh-snapshot replacement/anchor preservation,
queued double retry, legal/auth draft retention, creation/server order and the
actual shared profile name/PNG-avatar save. Focus has no external input frame;
full parameter values, policy links and canonical topic URLs remain verified.
The 320px fields test explicitly scrolls to Claude, rather than capturing the
short first-model harness: `Mini-SWE-Agent 2026.10 long harness name` is complete
on one line with its icon at **11px**, in **one centered 256px column**, in source
and actual compiled Chrome/WebKit. Visible fixture parameters are asserted >=9px
without ellipsis, clipping, width scrolling or icon/value overlap. No-fields
counts remain the table's 16/14/12/8/4/3.

There are **132 new screenshots**, **66 per variant**, with automated pixel and
geometry checks across all six widths and both engines. Representative captures
were visually reviewed across desktop/tablet/mobile, including the ordinary-card
28%/21% top row, wide weights, and the actual compiled WebKit 320px long harness.
The earlier binary version's artifacts were not overwritten. Current evidence:

- `D:/Codex-artifacts/website1/flat-topics-home-20261022/topics-home-ordered-20261023/report.json`
- `D:/Codex-artifacts/website1/flat-topics-home-20261022/topics-home-ordered-20261023-built/report.json`
- In each folder: `{chrome,webkit}-{1440,1280,1024,768,390,320}-{default,weights,featured,composition}.png`, footer/focus/parameter/snapshot captures, `{chrome,webkit}-1280-model-{rest,hover}.png`, and `{chrome,webkit}-1280-range-neutral.png`.
- `D:/Codex-artifacts/website1/flat-topics-home-20261022/topics-home-ordered-{unit,source,built}.log`

Worktree originals are under `artifacts/frontend/topics-home-ordered-20261023{,-built}/`.
Reproduce with the same unit command in the original verification section,
`node scripts/frontend/topics-home-ui.mjs`, and its `--built` variant.
Historical binary evidence remains in `topics-home-redesign-20261023{,-built}/`
and must not be used as the acceptance record for the final ordered layout.

**This redesign changed exactly these nine source/test/doc paths:**

The final two-blocker correction changed only `public/js/topics-home.js`,
`public/js/topics-home/layout.js`, `test/topics-home.test.mjs`,
`scripts/frontend/topics-home-ui.mjs` and this document. HTML, CSS and the two
showcase test files were not edited again. After the parent's export notice,
only this document was updated; the following runtime hashes are unchanged.

| Runtime (frozen) | Supporting files (frozen) |
| --- | --- |
| `private/index.html` | `scripts/frontend/topics-home-ui.mjs` |
| `public/css/topics-home.css` | `test/topics-home.test.mjs` |
| `public/js/topics-home.js` | `test/showcase-view.test.mjs` |
| `public/js/topics-home/layout.js` | `test/showcase-composition.test.mjs` |
| | `docs/topics-home-ui-20261022.md` |

All nine paths currently have Git status `??` (untracked) in this worktree.
Parent must explicitly include them in the exact candidate rather than assume
a tracked-files-only export contains them. This agent did not git-add them.

Runtime SHA-256 lock for the parent's rebuild (not generated asset hashes):

| Path | SHA-256 |
| --- | --- |
| `private/index.html` | `02D16F01645ED7CEBA97431EB6F8F23D2922783D94E0D17AAFD6050A2A948743` |
| `public/css/topics-home.css` | `9CCC8FD736A6A4F765A4618FFB42A8CC9267097FA85CE2C6260A1B31B8577D34` |
| `public/js/topics-home.js` | `8C57B9DB03B112F66CBC4EFAF88EF33EBE49A594B47770701ACD5D4C451A75EF` |
| `public/js/topics-home/layout.js` | `77A9E8337153CDDE32AA04EA9E31953F54647B0EE3BBE70D54284C2D1015468A` |

API/ownership assumptions are unchanged: preserve server heat/discovery order
except pinned 54; public/private weight selection is backend-owned; pages keep
omitted metadata; expiry is explicit `410 ranking_snapshot_expired`; creation
uses the shared `expectedUserID` write scope. Parent must rebuild real root
assets from these final sources before preparing its exact candidate.

## Original Scope and Context Map

Reviewed before implementation on `codex/flat-topics-home-20261022`.

| New file | Responsibility |
| --- | --- |
| `private/index.html` | Root-only semantic document, header, controls, topic creation dialog |
| `public/js/topics-home.js` | Metadata, lazy preview queue, filters, pagination, account/create integration |
| `public/css/topics-home.css` | Scoped responsive home, fixed cards, treemap/bar layering |
| `public/js/topics-home/layout.js` | Pure, testable treemap, label and whole-column geometry |
| `public/js/vendor/d3-hierarchy-3.1.2.js` | Official pinned D3 hierarchy distribution, no package changes |
| `test/topics-home.test.mjs` | Deterministic layout, aggregation and merge contracts |
| `scripts/frontend/topics-home-*.mjs` | Isolated local fixtures and Chrome/WebKit acceptance checks |

Read-only dependencies: `shared/organization-logos.js`, `workspace/score-colors.js`,
`shared/comparison-display.js`, `shared/ranking-number.js`, `shared/http.js`,
`shared/account-identity.js`, existing Manrope fonts, BenchPoll logo, Font Awesome,
`ui/tokens.css`, `ui/profile-editor.css`, `site-palette.css`, and `typography.css`. Existing home and backend
files are not changed. Parent owns production root routing/build integration.

No database migration, package modification, production access, branch switch,
commit, or reversion of another contributor's work is part of this change.

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Scan all flat topics and open a topic's canonical configuration page |
| Primary user/action | A visitor compares community benchmark priorities, then chooses a topic; a signed-in member can create one |
| Hierarchy | Large existing BenchPoll logo, exact requested headline/subtitle, global controls, featured topic 54, remaining topics |
| Navigation | No sidebar. Quiet How it works and account/sign-in links. Topic titles use the returned canonical URL |
| Controls | Available results selected on the left; Score range; circular brain/harness toggles; icon Default/Benchmark weights view switch; search and New topic |
| Surfaces/type | Existing Manrope and neutral site tokens, white cards, complete 1px neutral outlines, 8px corners, no decorative accent edges or gradients |
| Cards | Topic 54 is first/full-row and 400px tall; normal cards are 360px tall. Title above small creator avatar/name. Desktop three columns, tablet two, mobile one |
| Treemap | True proportional D3 layout in weight-sorted horizontal bands. The largest entries occupy the highest possible band, ties deterministic. Light tiles with exclusively black text, fixed theme, no palette control |
| Treemap labels | Benchmark name and rounded share; condition/version only when measured space permits. Share-only for small tiles, no label when even the share does not fit. Native tooltip and accessible label retain full details |
| Other | Entries strictly below 1% of total positive weight merge into one Other tile. Exact basis-point sum, stable member order, member/share tooltip. Other is treated as its actual aggregate weight when sorting |
| Layering | Shared baseline. Every bar endpoint is at most 75% of treemap height. Only the treemap has an opacity mask: solid through the exposed top quarter, fading between 25% and 68%, transparent below. This required alpha fade is not decorative color styling |
| Benchmark weights | No bars, no fade; the complete treemap and fitting labels remain visible in the same fixed card geometry; not the retired Public composition feature |
| Model columns | Whole-column viewport centered inside plot; width 54-112px, count based on available width and model total. Initial/resting positions align to complete columns. Horizontal native touch scroll, column snap, previous/next controls, no clipped logos |
| Data states | Metadata cards render together immediately. At most two preview requests in flight. Offscreen cards defer previews. Loading, refreshing, empty weights/results, partial pagination, error/retry and creation/legal/auth states are explicit |
| Responsive/accessibility | 1440/1280/1024/768/390/320px; no page overflow; keyboard/focus labels; 44px header/comparison targets and compact segmented/arrow controls; native dialog focus; reduced motion respected |
| Input/parameter fit | Search focus changes its complete existing border and neutral background, never an external frame. Form/profile inputs retain shared focus surfaces without outlines/shadows. Action buttons retain keyboard outlines. Parameter icon and whole value remain on one line using the existing shared font fitter, without ellipses or width scrolling |
| Acceptance | Pixel/geometry checks for complete resting bars, centered strip, shared baseline and 75% cap; label-fit/Other/top-order/fade assertions; stale response and page-merge tests; Chrome and WebKit screenshots at every required width |

## Evidence

Repository evidence is primary: the current orange/neutral site palette, existing
logo, compact comparison controls, vendor marks/colors, integer rounding and
comparison name rendering. The older `design-reference/benchpoll-home-ui.webp`
was inspected for product nouns/density, not its obsolete sidebar or purple theme.

The [UIZZE catalogue](https://uizze.com/) was browsed. Search surfaced
[Apollo filters](https://uizze.com/screens/6995634a0013a4ec6281),
[GitLab home](https://uizze.com/screens/69a2453c0002c7ab7d35), and
[Binance repeated offers](https://uizze.com/screens/69a11ac800321a9ef971), but all
three detail pages returned HTTP 410. These are reference-discovery evidence only,
not claimed visual inspection. Local product evidence and the explicit user
layout therefore determine the design; no third-party branding is copied.

Treemap geometry uses [official D3 hierarchy](https://github.com/d3/d3-hierarchy)
and its [documented proportional tiling API](https://d3js.org/d3-hierarchy/treemap).

## API and Ownership Contract

- `POST /api/get_topics {query?}` returns `{topics, featuredTopicID:54}`. All returned
  metadata renders before any preview completes. Featured ID 54 is always sorted
  first. All remaining order is preserved exactly from the server, including heat
  order and controlled new-topic discovery slots. No client heat calculation or
  independent new-topic promotion is performed. No taxonomy tree or fallback
  `get_category_navigation` request is needed.
- Topic metadata is `{ID,name,url,description,isPrivate,creator:{name,avatarURL},hasWeights?}`.
  English naming remains the existing backend's responsibility. URLs are used
  as returned, subject only to safe same-origin HTTP URL validation.
- `POST /api/get_topic_preview` receives `{categoryID,scoreMode,reasoning,harness}`;
  following pages also include `{snapshotID,offset}`. Initial ranking pages are
  bounded to 25 with the parent's separate lightweight home snapshot store, not
  rankingPager. The UI does not request a custom size. Backend snapshot LRU/TTL
  and discovery eligibility remain backend-owned.
- Preview supplies `{topicID,contextValues,comparison,weights,models,pagination,scoreScale}`.
  Comparison uses existing `{keys,fields,models,availableKeys}`. Weights use
  `{conditionID,name,conditionName,weightBasisPoints}`; `name` is the benchmark name.
- Subsequent pages may omit weights/comparison/context/scale; preserve them.
  Append/deduplicate models, preserve the current scroll position, and request
  the next snapshot page only near the visible end (or to fill an undersized page).
- `410 {error:'ranking_snapshot_expired'}` stops continuation. The explicit
  Refresh preview action sends a new initial request without snapshotID/offset,
  replaces the entire prior snapshot, and preserves an available model anchor
  or clamps its prior column position. Neither expiry nor refresh failure starts
  an automatic retry loop. Status text distinguishes expiry, refreshing and a
  refreshed preview. End-key navigation uses the current extent after append.
- Previews are public/community weights for public topics and the owner's Personal
  Pie for private topics; public topics are never personalized. Only lightweight
  model properties are needed, not score/member traces. Server cache/coalescing
  and save invalidation remain backend-owned.
- Root asset integration uses `buildHomeAssets({pageName:'index'})` and the parent's
  source-hash-verified `index-built.html` renderer. External module markup retains
  `src` before `type="module"` for the existing build's capture convention.
  The shared profile stylesheet is an explicit HTML dependency so the build
  includes it in source hashing as well as the combined CSS.
- Filters cancel queued/active work and ignore obsolete replies even if abort
  is not honored. Benchmark weights is local and does not change API scoring.
- `POST /api/get_user_profile {}` returns a profile or HTTP 204/401 for guests.
  Canonical `userID` binds `pageAccountWriteScope` from the shared identity module.
- `pageAccountWriteScope.write(postJSON, '/api/create_topic', {name,description,isPrivate})`
  injects **expectedUserID**, never accountUserID. A returned topic is inserted
  immediately, then metadata is refreshed to recover authoritative server order
  without replacing existing previews. Name maxlength is 128; description is
  1000. Legal/auth errors retain drafts and link to sign-in or Privacy & account
  choices.
- Signed-in account entry integrates with the shared `openProfileEditor({profile,onSaved})`
  module. Saved name/PNG avatar updates the account entry and refreshes creator
  metadata. This change does not implement shared account/profile UI.
- Local preview/test fixtures only; no requests are proxied to production.

## Verification Log

### Final Follow-Up Contract

The final scoped pass removes external input focus frames in favor of complete
border/background changes, retains action-button keyboard outlines, and lets the
shared comparison-label helper fit whole single-line parameter values. The
fixture will serve either native source or `private/index-built.html`; compiled
acceptance must invoke the actual `scripts/build-home-assets.mjs --index` CLI
(including its custom onLoad loader), not a substitute esbuild configuration.
The parent's D3 namespace/default-or-global import fix is read-only here.

A pagination `410 ranking_snapshot_expired` must stop automatic continuation.
Only explicit retry acquires a fresh initial preview, replacing all old snapshot
data. Preserve the visible model anchor when still present, otherwise clamp its
column position to the new page. Explain expiry/refresh in status text; a failed
refresh remains manually retryable and cannot start an automatic retry loop.

The later test-only follow-up explicitly authorizes these existing files:
`test/showcase-scroll-gate.test.mjs`, `test/showcase-weight-scroll.test.mjs`,
`test/showcase-view.test.mjs`, `test/showcase-composition.test.mjs`, and
`test/chart-workspace.test.mjs`. Their retired entry/DOM expectations are replaced
with contracts for the actual root directory. Meaningful standalone chart math
is retained; no showcase implementation is restored.

### Final Results

- `node --test test/topics-home.test.mjs test/showcase-scroll-gate.test.mjs test/showcase-weight-scroll.test.mjs test/showcase-view.test.mjs test/showcase-composition.test.mjs test/chart-workspace.test.mjs`: **48 passed, 0 failed, 0 skipped**.
- `node scripts/frontend/topics-home-ui.mjs`: native source, **12 layout runs and 12 interaction groups passed, 0 browser errors**.
- `node scripts/frontend/topics-home-ui.mjs --built`: actual compiled root, **12 layout runs and 12 interaction groups passed, 0 browser errors**.
- `node --check public/js/topics-home.js` and scoped `git diff --check`: passed.
- Official pinned D3 package SHA-512 is verified by the vendoring script, with the ISC license retained. The standalone esbuild layout test is retained, but is not treated as proof of root bundling.

The `--built` runner copies current public assets and `private/index.html` into
an isolated OS temporary directory, invokes the **actual**
`node scripts/build-home-assets.mjs --index` CLI there (27 hashed sources,
4 generated assets), and serves generated `private/index-built.html` with the
same in-memory API fixtures. It verifies the root imports `/build/index/` assets
rather than the native entry. This covers the real custom onLoad JS loader,
module classification, dynamic profile-editor chunk and combined CSS. The
temporary build is removed after contexts close; real root build outputs,
package files and node_modules are not changed by this runner.

Actual browser binaries: **Chrome Headless Shell 151.0.7922.34** and **WebKit 26.5**.
The system Chrome channel was absent and the installed full Chrome-for-Testing
binary could not spawn; the functioning official Chrome Headless Shell was used.
This is not a claim of interactive/system Chrome or physical-device testing.

| Width | Card columns | Complete featured model columns at rest | Preview request cap |
| --- | --- | --- | --- |
| 1440 | 3 | 20 | 2 |
| 1280 | 3 | 18 | 2 |
| 1024 | 2 | 14 | 2 |
| 768 | 2 | 10 | 2 |
| 390 | 1 | 5 | 2 |
| 320 | 1 | 4 | 2 |

Both engines verify fixed card heights, centered whole-column frames, no page
overflow, fully decoded/contained vendor marks, actual tile-label bounds, area
proportions, descending top placement, and exact Other sums/member tooltips.
Bar and treemap baselines agree within 0.2 CSS pixels; model endpoints stay at or
below 75% of treemap height. Screenshot pixel sampling verifies vendor-colored
foreground bars, visible top tiles, white background below the fade, and colored
bottom tiles with no fade in Benchmark weights. Footer links include Terms,
Privacy, Cookies (`/cookies`) and Community (`/community-guidelines`), with bounds
checked at every width and extra 320px footer screenshots.

Input focus is checked at every layout width: no outline or shadow on the input
or search container, a complete container border/background change, and a
retained keyboard outline on New topic. Creation input/textarea/checkbox and
the actual shared profile input are checked too. Reasoning/harness icon and
entire value bounds, same-line centers, no clipping/scroll and absence of
ellipsis are checked at desktop and 320px after the stale-filter test.

Interaction coverage includes keyboard/native horizontal wheel scrolling,
Chrome native touch-drag events and WebKit touch-tap navigation, snap after
resize, near-end pagination, page errors/retry, metadata/scale retention on
omitted fields, scroll-node/offset preservation, and smooth Next navigation while
pages append. A three-model-per-page fixture also verifies internal loading past
an exact-fit initial viewport. Transport-abort-ignoring fixtures verify that late
responses cannot overwrite the latest range/reasoning/harness selection.
Expired-snapshot coverage changes model order, weights and scoreScale together,
asserts exactly one explicit fresh initial request and no old-only rows, verifies
the available model anchor, then exercises another expiry plus a failed refresh
and manual retry. Both request slots are deliberately occupied before a double
Refresh click to verify queued retries cannot reenter or enqueue two snapshots.
This runs in both engines and both source/build variants.

All metadata appears before preview completion; offscreen previews remain lazy.
Search, empty weights/results, metadata/preview retry, private creation,
expectedUserID ownership, guest sign-in guidance, legal-error draft retention,
server-order preservation after creation, and the actual shared profile editor
are covered. Name and PNG-avatar saves update both the account entry and creator
metadata; both images must actually decode under the fixture CSP
`img-src 'self' data: https:`.

Failures found and fixed during implementation: synchronous ResizeObserver
rebuild feedback in WebKit; full chart replacement interrupting smooth scrolling;
and WebKit re-snapping from an old constrained end target after append. The last
case is covered by repeated WebKit runs and the complete final two-engine run.
The parent additionally fixed D3 UMD interop: native modules expose its global,
whereas the custom build exposes a namespace with named exports (`__esModule`
means default may be absent). The earlier standalone esbuild check missed this
real-root failure; complete actual-CLI build browser checks now cover it. The
vendored file and parent's import fix were not edited in this final pass.
Standalone esbuild still prints static no-export warnings and executes via its
global fallback; the actual CLI bundle and both browser variants pass.

An initial second-expiry test exhausted all fixture pages and therefore never
requested an expired page; it was corrected to leave additional pages. One
WebKit process closed during startup before opening a page. An isolated rerun
and both subsequent complete two-engine suites passed; no product pageerror
was hidden or excluded.

### Artifacts and Preview

Final artifacts are archived outside the worktree at:

- `D:/Codex-artifacts/website1/flat-topics-home-20261022/topics-home-ui/report.json`
- `D:/Codex-artifacts/website1/flat-topics-home-20261022/topics-home-ui-built/report.json`
- `D:/Codex-artifacts/website1/flat-topics-home-20261022/topics-home-focused-unit.log`
- `D:/Codex-artifacts/website1/flat-topics-home-20261022/topics-home-{source,built}-browser.log`
- `D:/Codex-artifacts/website1/flat-topics-home-20261022/topics-home-ui/{chrome,webkit}-{1440,1280,1024,768,390,320}-{default,weights,featured,composition}.png`

There are **120 screenshots**, 60 per variant in `topics-home-ui/` (source) and
`topics-home-ui-built/` (actual compiled root). Each has the earlier 50 layout/
footer screenshots plus two search-focus, two creation-focus, four complete
parameter-value and two snapshot-refreshed screenshots. Layout, weights, focus
and parameter captures were visually reviewed in addition to pixel/geometry
assertions. Worktree originals remain under
`artifacts/frontend/topics-home-20261022{,-built}/`.

To serve the parent's already-generated local root directly with the same APIs,
set `TOPICS_HOME_BUILT=1` before running the fixture script. Optional
`TOPICS_HOME_ROOT` selects another build directory. Default remains native source.

A local, memory-only fixture preview formerly ran at `http://127.0.0.1:56810`.
Its command line and listening-port owner were verified, then background Node
PID 85608 was stopped at final freeze on 2026-10-23. The port is no longer
listening; stdout/stderr logs remain in the same D: artifact directory. It never
forwarded requests to production. No runtime code changed during this cleanup;
public deployment remains pending and parent-owned. Reproduce with
`node scripts/frontend/topics-home-fixtures.mjs`, which prints an available port.

Not performed: production/real-database validation, deployment, migration, global
test-suite repair, or a commit. The earlier `unit-second.log` has other failures
outside this frontend/test follow-up; this document claims only the focused
suites above. Parent owns final root asset rebuild/render integration and all
backend/deployment work.

## Changed Paths

- `private/index.html`
- `public/js/topics-home.js`
- `public/css/topics-home.css`
- `public/js/topics-home/layout.js`
- `public/js/vendor/d3-hierarchy-3.1.2.js`
- `scripts/frontend/topics-home-fixtures.mjs`
- `scripts/frontend/topics-home-ui.mjs`
- `scripts/frontend/topics-home-vendor.mjs`
- `test/topics-home.test.mjs`
- `test/showcase-scroll-gate.test.mjs`
- `test/showcase-weight-scroll.test.mjs`
- `test/showcase-view.test.mjs`
- `test/showcase-composition.test.mjs`
- `test/chart-workspace.test.mjs`
- `docs/topics-home-ui-20261022.md`
