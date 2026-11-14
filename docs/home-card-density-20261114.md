# Homepage card density

The homepage now saves height primarily in model identities, preserving more
space for bars and the background weight map. Mobile cards shrink from 364 px
to 344 px; their normal plot grows from 109 px to 135 px in the fixture. Scene
cards also use the compact identity layout.

Model names use 10 px type on desktop and 9 px on mobile, with smaller vendor
marks, shorter diagonal label boxes and matching text measurement. The normal
identity region drops from 124 px to 110 px on desktop and 90 px on mobile.
Comparison fields use the same responsive font and remain inside their label
region. Favorite controls retain their larger size and touch targets.

Columns use closer spacing, less outer inset and a larger fraction of each slot
for the bar. In a normal card with many models, the measured visible counts are:

| Viewport | Before | After |
| --- | ---: | ---: |
| 320 px | 5 | 7 |
| 390 px | 7 | 9 |
| 1440 px, ordinary card | 5 | 7 |

Score calculation and the 65% bar-height envelope are unchanged. Full weights
still use the complete visual region, and wider pages prefetch enough models to
fill the denser view.

Runtime sources: `public/css/topics-home.css`, `public/js/topics-home.js` and
`public/js/topics-home/layout.js`. Rebuild index assets. No server, schema or
production-data change is required.

Validation: 56 focused unit/contract tests, six homepage browser cases and ESLint
pass. Source and built previews were checked in WebKit and Chromium at 320, 390,
768 and 1440 px, including both comparison fields and full weights. Names remain
inside the chart boundaries with no document overflow. Measurements and
screenshots are outside Git at `/workspace/benchpoll-work/card-density-20261114`.
