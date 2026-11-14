# Topic navigation and mobile workspace follow-up

Branch: `codex/cloud-handoff-20261101`.

## Behavior

- The homepage header keeps profile access visible after secondary actions move
  into More. Desktop hover previews only Favorites and Configured topics;
  clicking opens `/me`. The preview uses the current account's authorized topic
  directory and clears on sign-out. Touch devices keep direct profile navigation.
- Popular, Recent and Mine header buttons are removed. Search works at the top
  and in the frosted header. Orange Topics appears beside the logo only in the
  frosted header.
- The mobile bottom selector enlarges while held and can be dragged. The pages
  follow continuously, then settle on release. Its labels and icons remain in
  place: a clipped darker copy highlights only the area under the moving glass
  lens. Native page swipes, taps and keyboard navigation also work. Cancelling a
  drag restores its starting page.
- Undo and Reset retain their size and opacity while the composition page slides
  away. Weight-source button labels remain visible during asynchronous switches;
  a small adjacent spinner supplies loading feedback. “your way” stays together
  in the personal-weight creation button.
- The mobile header action row has matching, smaller gaps above and below it.
  The chart toolbar also has matching compact gaps. The chart retains a small
  top inset so selected outlines are visible.
- Scene dialogs leave a clear scrollbar lane on every card, including Safari's
  overlay-scrollbar layout. Scores that cannot fit inside short homepage bars
  are centered directly above the bar; bar and vendor positions stay centered.
- Favorite icons/counts use 14 px text; configured dots use 8 px. Topic cards on
  Home and profiles omit reporting controls. The workspace report entry remains
  beside creator information.

## Scene summaries

Every scene inherits its topic summary, including workspace text, reference
descriptions, navigation and search metadata. Scene names remain searchable;
independent scene summaries no longer participate in search.

Both topic and individual-scene editors omit scene-summary fields. Scene write
requests reject that field, and scene serialization does not expose it. New and
edited scene rows write an empty string to the existing schema column; runtime
reads use the topic summary. No schema migration or data backfill is required.
How It Works now explains the shared summary.

## Runtime scope

The change includes homepage/workspace HTML and CSS, shared header/profile/card
and mobile-panel modules, scene editors and navigation, treemap spacing, plus
`private-topic-service.js`, `topic-scenes-service.js` and
`topic-reference-service.js`. Rebuild both home and index assets. Release the API
and corresponding frontend together and restart the application for the service
changes. Generated bundles remain build artifacts.

Do not replay historical migrations or replace the production checkout wholesale.
This cloud task changes no production data and adds no operations workflow.
GitHub publication does not confirm a server deployment.

## Verification

- Changed JavaScript passes ESLint and the diff passes whitespace checks.
- `npm test` passes: 3,261 tests passed, six skipped, no failures. The cloud
  browser environment was loaded before running browser-backed tests.
- Home and index builds pass.
- `test/header-profile-weight-motion-20261114.browser.mjs` passes against source
  and built assets in Playwright WebKit and Chromium. It checks responsive
  headers down to 320 px, desktop preview interaction and sign-out, scene
  scrolling at the beginning/middle/end, short-bar label alignment, scene
  creation without independent summaries, layout gaps and stable switch labels.
- The same browser checks cover fixed labels during partial dock drags, press
  enlargement, release/cancellation, Safari-engine touch taps and Chromium touch
  drags. Screenshots are outside Git under
  `/workspace/benchpoll-work/header-profile-20261114`.

These are local synthetic-fixture checks, not tests against the production
database or a physical iPhone.
