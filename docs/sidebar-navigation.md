# Sidebar navigation

The native-module homepage has two independently selectable navigation scopes:
**All categories** and **Configured**. Changing either scope never changes the
current ranking context or Personal/Public weight source. Selecting a configured
row restores its exact category and complete template values, keeping the source.

## Membership and ordering

The account index contains saved, nonempty personal pies, whether or not they
have fallback rules or equal the current public weights. Full-tree pie marks
indicate an own-category configuration in any context, never an inherited mark
from a configured descendant.

Configured navigation adds at most one temporary current context. Filled pie
marks indicate saved configurations; an outline mark indicates the temporary
row. There is no separate current-context section or per-row saving text.
Only confirmed saves change membership; clearing the final weight turns the
current row into a temporary row without moving to another location.

Rows follow taxonomy preorder (sibling ID order), with a category's templates
adjacent in dimension/option order. An outermost configured ancestor defines
each saved-forest group. Only these top-level groups receive extra whitespace.
There are no collapsible rows, internal group gaps, or colored group bars.
Unconfigured intermediate ancestors are omitted. A temporary common ancestor
does not merge saved groups; actually saving/removing that ancestor does.

Search matches category names, complete paths, and template labels. Retired or
invalid contexts remain identifiable but cannot silently navigate to defaults.

## State and API

`POST /api/get_personal_navigation` is authenticated, private/no-store, and uses
only the validated session owner. It returns location metadata, not weight or
model-score payloads. Reads use a consistent read-only transaction and the same
context-dimension resolver as the ranking workspace. No migration is required.

The index is account-scoped in memory, with aborted/superseded reads ignored.
Logout clears it immediately. Detecting a different signed-in account reloads
the workspace so old editable weights cannot be submitted under the new session.
Session storage contains only the navigation scope, scroll offsets, and full-tree
expansion preferences, not account configuration records. Existing pie-mode and
Public fallback visibility preferences remain separate. Personal fallback
continues to reflect the current context's saved rule or local draft.

Navigation waits for pending personal saves before changing location. The
workspace publishes confirmed context snapshots on a separate channel from
navigation requests, preventing feedback loops and premature saved markers.

## Verification

- `npm run lint`
- `npm test`: includes `test/navigation.test.mjs` for identity, preorder/grouping,
  invalid contexts, owner isolation, transaction cleanup and preference storage.
- `npm run test:frontend`: existing synthetic Chromium regression suite.
- `npm run test:navigation`: real page modules with isolated API fixtures for
  exact-context navigation, tree marks, save/clear, failed saves, search, retired
  entries, stale responses, account changes, history, scrolling, keyboard focus,
  and mobile widths 320/390.

Screenshots and JSON results are generated under `artifacts/navigation/`.
Fixtures do not exercise production MySQL, GitHub OAuth, or real account data.
