# Benchmark Discussion Scope

## Context Map

| File to modify | Responsibility | Scoped change |
| --- | --- | --- |
| `public/js/discussion.js` | Panel lifecycle, benchmark identity, feed filters, drafts and posting context | Toggle category scope without dropping benchmark identity; preserve benchmark view on workspace context refresh; expose the existing category entry in the mobile panel |
| `public/js/workspace/discussion-entry.js` | Category URL and asynchronously refreshed discussion count | Show `Category discussion` while the benchmark panel is open; retain the count for ordinary discussion |
| `public/css/discussion.css` | Discussion-only layout | Compact, borderless scope control and mobile entry placement |
| `private/home.html` | Discussion panel DOM | Replace checkbox/clear action with one toggle; add a mobile slot for the existing entry |
| `test/benchmark-discussion-scope.test.mjs` | Focused unit coverage | State transitions, context refresh, entry count races and DOM contract |
| `scripts/frontend/benchmark-discussion-scope.mjs` | Local-only browser fixture | Desktop/mobile filtering, templates, drafts, threads, validation and request races |

Read-only dependencies: `shared/http.js`, `shared/context-selection.js`, `shared/account-identity.js`, `workspace/benchmark-scores.js`, `home-workspace.js`, `discussion-service.js`, and the existing frontend fixture server/data. No changes to these dependencies are required.

Related coverage: `test/discussion-service.test.mjs`, `test/panel-read-lifecycle.test.mjs`, `test/benchmark-row-inspection.test.mjs`, `test/quiet-actions.test.mjs`, and the benchmark discussion checks in `scripts/frontend/workspace-ui-20261008.mjs`.

Reference patterns: the existing quiet discussion entry, Font Awesome icons, the panel's full-screen mobile/inert lifecycle, and sequence-guarded asynchronous reads. The map has been reviewed against the requested file ownership before implementation.

## Design Contract

| Field | Decision |
| --- | --- |
| Screen job | Read discussion of one benchmark within this category or across categories, then deliberately return to ordinary category discussion |
| Primary action | A single scope button switches between `This category` and `All categories` |
| Hierarchy | Benchmark introduction, scope-specific discussion heading, scope/sort controls, task filter, posts, collapsed composer |
| Navigation | Only the category entry deliberately exits the benchmark view; context refresh retains benchmark identity and scope |
| Visual language | Existing orange tokens and Font Awesome icon; no new cards, accent edges or shared primitives; label/icon hover together |
| Required states | Both scopes, ordinary discussion, thread, private information-only view, pending/error reads, guest composer and saved drafts |
| Responsive behavior | Move the same category entry into the mobile benchmark panel so workspace inertness does not block it; restore it on exit; toolbar wraps without overflow |
| Evidence used | Repository quiet-action and panel patterns. [UIZZE catalogue](https://uizze.com/web-ui-references) was consulted, but current catalogue redirects and search did not expose relevant discussion screen references; no external layout was imported |
| Forbidden defaults | Checkbox plus clear action, heavy cards, one-sided accent borders, background/underline on these secondary controls |
| Acceptance criteria | Scope changes retain benchmark/version and posting context; task filter clears only on scope changes; count refresh cannot overwrite the category-entry label; mobile focus remains in the panel; no real writes or deployment |

## Risk Review

- No database, migration, configuration or server API changes.
- Existing dirty changes in unrelated modules are preserved.
- `private/home.html` edits are limited to the discussion panel DOM.
- Browser tests use an isolated localhost fixture with synthetic records. Posting checks are intercepted and rejected or stubbed in the browser, never forwarded to a real service.

## Verification

14 focused unit tests passed. Browser fixtures passed Chromium 1440/1024/390/320 and WebKit 390, including scope switches, preserved benchmark identity/drafts, template locking, request races, mobile panel focus and ordinary category navigation. Posting checks were stubbed locally; no real discussion messages were posted.
