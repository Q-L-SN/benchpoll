# Discussion Replies, 2026-10-16

## Context Map

| File | Responsibility |
| --- | --- |
| `private/home.html` | Return navigation, original message and replies heading; existing IDs remain stable |
| `public/css/discussion.css` | Shared discussion typography, reply hierarchy, composer and action spacing |
| `public/js/discussion.js` | Existing thread navigation, root/reply state and shared action controls; owned by the paging worker |
| `scripts/frontend/discussion-replies-20261016.mjs` | Desktop/mobile screenshots, geometry, writing and navigation |
| `test/discussion-replies.test.mjs` | Structural and shared-control contracts |

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Read the original message, understand the replies and contribute a reply |
| Primary action | Post a reply, with the original message remaining reachable in the same scroll area |
| Hierarchy | Return navigation, original message, replies, persistent composer |
| Controls | Existing shared quiet actions for secondary commands; filled Post reply; one internal keyboard focus cue |
| Visual language | Unframed text, neutral separators, 14px body, compact 12px metadata, consistent 8px icon-label gaps; no decorative accent borders |
| States | Feed/thread, loading, exhausted, retry, empty replies, deleted message, signed out, draft and confirmation |
| Responsive | Same reading order in the desktop rail and full-screen mobile panel; 44px touch targets; composer respects the viewport |
| Evidence | Inspected current 1440px/390px reply screenshots and repository shared components. UIZZE's public landing/catalogue route was accessible, but returned no inspectable discussion screens; no external screen evidence is claimed |
| Forbidden | Nested cards, heavy buttons for secondary actions, repeated empty task metadata, per-message decorative stripes |
| Acceptance | No horizontal overflow at 320/390/1024/1440px; working reply, vote, delete, report and return navigation; Chromium and WebKit checks |

No discussion schema or permissions are changed by this presentation update.

## Verification

Source and server-built candidate both passed Chromium 1440/1024/390/320 and
WebKit 390 checks: original/reply hierarchy, viewport geometry, quiet action
spacing and touch sizes, voting, posting a synthetic reply, deletion confirmation
cancellation, report/permalink targets, return navigation, empty and guest states.
All interaction writes were confined to the local synthetic fixture.
