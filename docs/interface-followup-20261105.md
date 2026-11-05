# Workspace, guide and contribution follow-up — November 5

Deployed through `dbab95c` in the reconciled
[`November 5 rollout`](releases/20261105-github-merge-rollout.md), including both
small follow-ups and the earlier homepage changes in `topics-home.js`. The
feature and source-verification notes below describe the handoff; use the rollout
record for current installed hashes and operations. No migration was required.

## User-visible behavior

- Searching and confirming a model locates the exact ranking row. Scrolling
  near either end loads adjacent segments automatically. Existing rows and their
  viewport positions survive prepend/append, including mobile and chart views.
  Retry/Refresh appears only after a failed or expired segment request.
- Shallow treemap tiles can place the percentage at the right of the name.
  The name fades before the percentage's reserved area; it is not ellipsized.
- Separate benchmark version names are omitted from ordinary presentation,
  including homepage weight tooltips, reference lists and generated discussion
  mentions. Score lists, score details, advanced configuration and necessary
  contribution/edit/review controls retain them. Exact condition IDs and links
  are unchanged. Existing user-written discussion text is not rewritten.
- Starting personal weights reveals the shared Public/Personal selector, slides
  from Public to Personal, then opens the two equal-height source choices over
  an inert preview of public weights. The chooser has no close icon. Entering
  it selects Personal for subsequent topic navigation without saving weights.
  Unconfigured topics offer the chooser when public weights exist; otherwise
  they start blank. A same-topic refresh preserves an already chosen blank start.
  Returning an empty Personal view to Public restores the orange creation button.
- Resets still require confirmation before replacing allocations/version/fallback
  choices. Without public weights they go straight to blank-reset confirmation.
  Revision/account/context invalidation, draft behavior and Undo are preserved.
  The start chooser and reset confirmation hide the entire lower editing area,
  including Add benchmark or topic, topic references and Contribute your expertise.
  Cancelling or completing the flow restores that area's ordinary visibility.
- The desktop workspace's outer document is constrained to the viewport; lists
  and panels retain their own scrolling. The no-JavaScript view remains scrollable.
- Opening a private topic without a scene path no longer interprets its numeric
  topic ID as a public scene slug, so the topic can select its default scene.
- How It Works now has a spacious illustrated layout, animated example rankings,
  flowing community-weight graphics, interactive score/range examples and
  expandable technical details. The example models are explicitly illustrative.
  Animation can be paused and honors reduced-motion settings. Existing deep
  links, including `#calculation-details`, reveal the relevant details.
  Promotional headings use no comma-based phrasing; homepage branding is unchanged.
- All contribution forms show a persistent Artificial Analysis benchmark/score
  submission notice. Version Name and Description fields share a narrow left
  column, with primary/delete controls below. Name now wraps and grows while
  retaining validation, length limits, rename confirmation and payload semantics.
- Textareas across shared UI resize with typing, pasted/restored values, clearing,
  visibility and width changes. Manual resize handles are disabled globally.
  Field-specific minimums remain; bounded composers scroll when reaching their
  existing maximum. Email review notices share the feedback-template tip styling.
- The control to the right of discussion scenes now reads `All` instead of using
  a layer icon. Its all-scenes toggle and selected-scene return behavior remain.

## Runtime allowlist

```text
discussion-service.js
private/contribute.html
private/home.html
private/how-it-works.html
public/css/contribute.css
public/css/global.css
public/css/how-it-works.css
public/css/ui/workspace.css
public/css/workspace-layout.css
public/css/workspace-model-focus.css
public/js/contribute.js
public/js/discussion.js
public/js/home-workspace.js
public/js/home.js
public/js/how-it-works.js
public/js/shared/textarea-autosize.js
public/js/shared/ui-components.js
public/js/topic-proposal-preview.js
public/js/topics-home.js
public/js/workspace/benchmark-link.js
public/js/workspace/fallback-picker.js
public/js/workspace/model-bar-chart.js
public/js/workspace/model-focus.js
public/js/workspace/model-list.js
public/js/workspace/model-scores.js
public/js/workspace/model-scroll-window.js
public/js/workspace/personal-pie-start.js
public/js/workspace/pie-label-layout.js
public/js/workspace/pie-renderer.js
public/js/workspace/topic-references.js
public/js/workspace/weights.js
```

Rebuild both home and index from the reconciled source set. Install each compiled
HTML, manifest and hashed assets together, including the new shared modules.
The static guide and contribution pages additionally load the listed unbundled
sources. Preserve production-only differences outside this allowlist, including
`db.js`, `navigation-service.js` and `public/css/ui/navigation.css`.

`discussion-service.js` changes only read-time mention labels and needs an
application restart. No schema changes, migrations or production-data writes
are included. Do not replay historical migrations or replace the whole checkout.
No GitHub Actions operations channel is added.

## Validation

All write journeys use disposable local fixtures. No production writes are used.

- Lint and home/index builds pass (149 / 65 source inputs).
- Full `npm test`: 3,355 cases, 3,349 passed, 6 skipped, 0 failed.
- Continuous-ranking journeys: Chromium/WebKit at mobile/desktop widths, source
  and compiled views; exact search, both edges, duplicate-request protection and
  unchanged visible anchors through 220 synthetic rows.
- Home model-focus journeys pass all four Chromium/WebKit source/compiled
  matrices, including public/private topic links, exact effort/harness identity,
  bounded deep jumps, URL cleanup and preserved comparison preferences.
- Personal start/reset journeys: 16 source and 15 compiled cases, including
  intermediate slider positions before the chooser, public-weight background,
  equal button heights, mode persistence, empty scenes, reset cancellation,
  revision invalidation and viewport-contained scrolling.
- Guide: 7 Chromium/WebKit cases spanning 320/390/1440 px, linked disclosures,
  score examples, keyboard activation, pause/resume and reduced motion. Desktop
  and mobile screenshots were visually reviewed.
- Contribution form regression: 18 cases preserve validation, naming, IDs,
  descriptions, primary choices, confirmation/deletion and source handoffs.
  Four additional mobile/desktop cases check field layout, growth/shrink,
  programmatic values, persistent AA guidance and matching email-tip styles.
- Community versions/discussion: 4 browser journeys retain the permitted version
  names and existing advanced configuration behavior. Treemap: 6 source journeys
  include shallow labels with reserved percentage space.
- Existing score-field refresh fixtures include the new shared autosize module;
  their four real-browser cases pass together with the affected unit contracts.
- The later `All` label follow-up passes the home build and both existing
  discussion-scene browser journeys at 390 / 1440 px; mobile layout was reviewed.
- The lower-controls follow-up passes the home build, focused lint and 5 source /
  4 compiled personal start/reset journeys. Direct Chromium/WebKit checks confirm
  controls stay hidden through reset choice and confirmation, then return after
  cancellation or completion; the mobile screenshot was reviewed.

Browser-engine emulation is not a physical iPhone/Safari-device test.
