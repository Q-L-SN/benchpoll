# Search and Translatable Feedback Guidance

## Reproduction Brief

- Target: `codex/flat-topics-home-20261022`, base commit `d1511a7` with the existing working-tree changes preserved.
- Environment: Windows, Node 22.22.1, isolated local fixtures, Chrome 151.0.7922.34 and WebKit 26.5. No production writes used for reproduction.
- Expected search: one dismiss/clear control and one input surface.
- Actual search: the browser's native search-clear control appears beside the custom Close search control, inside a second outlined capsule. Reproduced twice per browser; the custom button exits instead of clearing.
- Expected form: instructions are ordinary translatable page text; the editor contains only the user's message.
- Actual form: bulk-import instructions and bracketed placeholders are inside the editor value, with no external guidance element. Reproduced twice using the same contribution entry flow.
- Evidence: `D:/Codex-artifacts/website1/search-feedback-guidance-20261024/` contains the before screenshots and workspace baseline. An initial WebKit run timed out with inherited proxy settings; the repeat with the existing fixture's proxy-free launch environment passed.

## Context Map

| File | Change |
| --- | --- |
| `public/js/topics-home.js` | Single search action: clear nonempty input, close empty search; accurate accessible name. |
| `public/css/topics-home.css` | Suppress native clear UI and remove the inner search frame; preserve keyboard and touch access. |
| `public/js/shared/feedback-templates.js` | Short paragraph guidance, legacy-template conversion, payload composition and length budgeting. |
| `public/js/contribute.js` | Render guidance above an empty editor; prepend it only when composing the submission. |
| `public/css/contribute.css` | Plain, unframed instruction paragraph consistent with the form. |

Dependencies: Home's Beta entry, benchmark discovery, merge requests and the contribution sidebar already use the shared template functions. Their handoff route and `details` entry remain compatible. `server.js` accepts feedback `details` up to 4,000 UTF-16 units, so the client must budget the complete submission, not only the message. The existing account-scoped write and retry mechanisms remain unchanged.

Related tests: `test/topics-home.test.mjs`, `test/feedback-templates.test.mjs`, `test/contribute-ui-contract.test.mjs`, the Home source/built browser harness and a focused search/form browser regression.

Reference patterns: the sidebar search already suppresses its native clear control; contribution entry activation already keeps handoff context out of the visible URL.

Map review: changes are confined to these UI boundaries. No database migration, backend API change, dependency change or unrelated revert is needed.

## Design Contract

- Screen job: search topics or submit a useful free-text request without editing instructional boilerplate.
- Search: one full input surface and one 44px action target. With text, the action clears and retains focus; without text, it returns to the previous collection. Escape always exits.
- Forms: one concise instruction paragraph above the editor, followed by the existing Your message label. Instructions are text nodes, not an input value or placeholder. The existing textarea sizing stays unchanged.
- Submission: canonical instructions and contextual object/topic information precede the user's message exactly once. Validation measures the user's contribution independently and respects the full 4,000-character server limit. Retries never mutate the draft or duplicate the prefix.
- Same-form navigation: an incoming `#entry` handoff reloads the contribution page so its instructions and context are read again, rather than leaving the previous request displayed. Other hash navigation is unchanged.
- States: empty input, nonempty input, no matches, empty/short message, maximum-length message, legacy entry, submission failure and retry.
- Responsive/accessibility: test mobile and desktop, keyboard focus, associated guidance, ordinary browser-translatable DOM text and escaped user-provided context. Keep reduced-motion behavior.
- Evidence: the user screenshot, the repeated local reproductions, and the repository's existing controls. No new external design reference is needed for this defect repair.
- Forbidden: duplicate search icons, nested focus frames, bracketed filler inside a new message, prefix-only submissions, silent truncation and loss of entry context.

## Verification

- 2,399 unit/regression tests passed; two optional integration tests skipped. The focused template and handoff tests were re-run after the same-form navigation fix. ESLint passed for all changed JavaScript and test tools.
- The Home source layout and actual CLI-built entry passed Chrome/WebKit at 320, 390, 768, 1024, 1280 and 1440px. The built entry also passed its 18 interaction groups, including search, themes, pagination, focus and account changes.
- The focused search/form suite passed 44 cases locally: both engines at 1440, 390 and 320px, six request entry types, clear/close/Escape, separate instructions, legacy context, empty/short messages, exact 4,000-character payloads, failed submission/retry, escaped context, oversized instructions and same-form request changes.
- Actual merge-entry checks passed at 1440 and 390px. All four fixed-choice score-form browser cases passed, including the sidebar bulk-import entry.
- Public-asset checks passed 22 Chrome and 22 WebKit cases. Every form API request in these checks was routed to isolated fixtures; no actual production contribution or email was created. The first public WebKit run incorrectly cleared the system proxy; its corrected proxy-preserving rerun passed. Both reports and the combined 44-case result are retained.
- Four additional unmocked public Chrome/WebKit checks passed for Home, preview settings, model navigation and discussion entry, with no unexpected page error or CSP violation.
- Native translation providers were not automated. Translatable DOM text, `translate="yes"`, associated guidance, and preservation of the draft/canonical submission while the displayed instructions are translated were checked.
- Artifacts: `D:/Codex-artifacts/website1/search-feedback-guidance-20261024/`.

## Release

- URL: https://benchpoll.com/
- Release: `topics-refinement-20261024-1792834231726`, published at `2026-10-24T09:34:58.905Z` (17:34:58, Asia/Shanghai).
- Five UI source files changed. Fourteen installed source/generated files and 167 unchanged dependencies were verified by SHA-256 after publishing.
- No database, scoring, backend API or dependency changes. The app and score-sync timer remain active; the timer was not modified or restarted.
- The rollout retained before-images and compare-and-swap/source-hash guards. No concurrent production differences were found, and no unrelated changes were reverted.
