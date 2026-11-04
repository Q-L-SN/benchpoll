# Site wording, private-topic proposals and treemap labels

Pending release on `codex/cloud-handoff-20261101`. The cloud workspace has not
installed these changes in production.

## Behavior

- User-facing score help, contribution instructions, account notices, policy
  explanations and search-discovery text describe the calculation or next action
  directly. Repeated defensive comparisons and generic guarantees are removed.
  Coverage, missing-score endpoints, review requirements, data retention,
  operator access, source restrictions and statutory rights remain explicit.
- Policy effective versions stay unchanged because this is an editorial update.
  The pages separately date the wording update, and sitemap/document metadata
  use November 4. Acceptance continues to record the actual document hashes.
- New proposals require an owned private topic. Scenes travel with its snapshot.
  The hall no longer offers a standalone public-scene target, and the create API
  rejects `parentTopicID` and text-only submissions. Existing proposal records
  remain readable and reviewable; no historical records are rewritten.
- Proposal creation has two steps: choose a private topic, then review/edit its
  name and summary. The second step explains that later updates reset support
  to zero while retaining the collection deadline. Back preserves text edits.
  Publishing a snapshot leaves the source topic's metadata unchanged.
- The private-topic list loads on opening and on returning to the source step
  from another tab. The permanent Refresh button is removed; failed reads offer
  an inline Retry. Account changes invalidate in-flight source reads. The picker
  uses the shared accessible select component.
- Treemap percentages can appear in a 40 px-high tile, down from the previous
  58 px minimum for a one-line name. Compact weights use 15 px type; roomy tiles
  retain 18 px type. A long name fades independently while the percentage stays
  visible. Names remain intact, without ellipses, and numbers must fit in full.
- The homepage header and settings island start their shared transition 80 px
  earlier in the document. Their 220 ms fades, reversal behavior and reduced
  motion support are retained.

## Runtime scope

```
private/account-privacy.html
private/community-guidelines.html
private/contribute.html
private/cookies.html
private/home.html
private/how-it-works.html
private/privacy.html
private/terms.html
private/topic-proposal-preview.html
private/topic-proposals.html
public/css/topic-proposals.css
public/js/account-privacy.js
public/js/contribute.js
public/js/home-workspace.js
public/js/shared/aa-ranking-policy.js
public/js/shared/account-center.js
public/js/topic-proposals.js
public/js/topics-home.js
public/js/workspace/benchmark-settings.js
public/js/workspace/estimation-control.js
public/js/workspace/fallback-picker.js
public/js/workspace/model-scores.js
public/js/workspace/pie-label-layout.js
search-presentation.js
topic-proposal-service.js
```

No schema migration, historical migration replay or production data update is
part of this change. The root service and search modules need an application
restart when installed. Reconcile the pending personal-weight, compact-settings,
workspace-availability and separate scene-data releases first; use a narrow
hash-checked install and rebuild both entry points from the reconciled sources.

## Verification

- Full `npm test`: 3,326 passed, 6 existing skips, zero failures.
- `npm run lint` and both home/index builds passed.
- Chromium and WebKit exercised the private-topic picker, final metadata edits,
  back navigation, publication, support reset, automatic source reload, failed
  read retry, empty accounts and guest entry at 320, 390 and 1440 px.
- Treemap browser checks covered 40 px tile labels, full-name fading, percentage
  bounds, hover/keyboard behavior and save/reload across desktop and mobile.
- The 18 homepage header cases passed in Chromium/WebKit, including both scroll
  directions, interrupted fades and reduced motion. All 25 combined personal-
  start and topic/scene/reference browser checks passed against the final build
  for the personal-start cases and source fixtures for the scene cases.
- Screenshots are local artifacts under `artifacts/topic-proposal-wizard-20261104`;
  the existing treemap/header suites also retain their fixture screenshots.
  WebKit verification is browser-engine coverage, not a physical iPhone test.
