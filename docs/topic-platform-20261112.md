# Topic platform and canonical URLs

The prelaunch topic platform replaces Proposal Hall with owner-controlled publication. A signed-in user can publish a private topic immediately and can have at most three active public topics. Making a topic private frees a slot. Official topics are managed by the catalogue and cannot be published, unpublished or edited through owner APIs.

`setTopicVisibility` holds the shared topic graph lock and then the authenticated account row lock before checking the public count. The visibility change, cap check and idempotent write response commit together. Editing, scene changes, reference saves and favorite writes use the same graph lock order. Public publication refuses references to a different private topic; cycles among accessible topics are allowed.

## Identity and routes

Internal `categories.ID` and ranking context IDs remain storage identities. The new identities are independent of names:

- Public topic: `/<publicID>` or `/<publicID>/<sceneNumber>`.
- Private topic: `/private/<privateID>` or `/private/<privateID>/<sceneNumber>`.
- The official catalogue occupies public IDs 1–26 in the requested order. The explicit prelaunch reconciliation renumbers existing public IDs to this layout, followed by other topics in creation order. After this setup, runtime creation allocates monotonically; private topics reserve a number too, and publication preserves that number.
- `private_ID` is a cryptographically random alphanumeric token. The token remains stable after publication, when its URL redirects to the canonical public URL. The token is omitted from public metadata unless the viewer is its creator.
- A public URL for a topic made private returns 404, including for the owner. Only the authorized private URL resolves.
- Scene numbers start at one within each topic and are allocated in creation order. Rename, reorder and default changes preserve numbers. Removal does not recycle numbers.
- A missing scene redirects to the default numeric scene. Slug paths, `/personal`, `/topics` and scene/context query aliases are not routed.

The route resolver and all topic read APIs enforce active status and ownership. Cached ranking pages and home previews reauthorize their root and referenced topics before returning cached data. Topic structure and visibility mutations invalidate in-process ranking snapshots.

## API and metadata

Business payloads for write APIs are combined with the existing account transport identity, CSRF token and `Idempotency-Key`:

- `POST /api/set_topic_visibility`: `{categoryID, isPublic, expectedRevision?}`. Returns owner-visible topic metadata and `editRevision`; the cap returns `409 public_topic_limit`.
- `POST /api/set_topic_favorite`: `{categoryID, isFavorited}`. Returns `{categoryID, favoriteCount, isFavorited}`.
- `POST /api/get_topic`: `{categoryID}` for internal lookups, or `{publicID|privateID, sceneNumber?}` for route lookup. Route lookups also return `selectedScene` and `canonicalPath`.
- `POST /api/get_topic_preview` accepts `mode: "public"|"personal"`. Public topics default to public weights; private topics use personal weights. Explicit personal previews require a signed-in viewer and isolate caches by viewer.

Topic metadata includes `publicID`, owner-only `privateID`, `url`, `isOfficial`, `isMine`, public creator `{id,handle,name,avatarURL,url}`, `favoriteCount`, `isFavorited`, `configuredContextIDs`, `configuredPersonalContext`, `configurationCount` and `coverageIndex`. Official topics display “Official” rather than an author. `coverageIndex: null` means no ranking computation has been requested; previews return the computed coverage index, never a fabricated zero. Scene `ID`/`contextID` remain internal; `sceneNumber` is its URL identity.

Profile queries always restrict Published to public active topics. Favorites and Configured also restrict to public active topics for other viewers. The owner may see their own private topics in those collections. Hidden profile tabs are not queried.

The flag icon beside topic creator metadata opens `/contribute/topics/<categoryID>/report`. It uses the existing private `report_issue` review queue with `issueType: "topic_report"` and the internal `targetCategoryID`. Both the form load and submission authorize the topic; the server replaces prefilled names and URLs with current canonical metadata. A valid scene URL can be retained as context.

## Favorites and Popular

A unique `(category_ID, user_ID)` row stores active favorite state. Removing a favorite deactivates the row, and reactivating it preserves its original timestamp. Deleted and currently banned accounts do not contribute to the count.

Popular score is `log1p(totalFavorites) + 2 * log1p(recentFavorites)`, where recent means first favorited within the preceding 14 days and still active. Recent count is bounded by total; future timestamps are excluded. Ties use total favorites, then ascending durable public ID, then storage ID. Featured status and topic names do not override this ordering.

## Installation

`node scripts/migrate-topic-platform-20261112.mjs` prints the plan without opening a database. `--apply` requires an explicit `BENCHPOLL_MIGRATION_DATABASE`, with separate `BENCHPOLL_MIGRATION_HOST`, `PORT`, `USER` and `PASSWORD` variables; no application database default or `.env` is read. This module never runs at server startup.

The schema installer adds identities, the scene allocator, the explicit official flag and favorites. Existing topic identities are backfilled by `created_at, ID`; scene numbers by context creation ID. It preserves storage identities and existing data. Profile pages require their separate profile schema migration before the application uses creator handles.

For a fresh empty catalogue, `--apply --initialize-official` seeds `official-topic-catalogue.js` transactionally with the 26 requested English topics, numbered in catalogue order. Coding includes General, Frontend and the ten retained programming languages; Natural Language includes General and the eight retained languages. Image and Video have the requested reference scenes. The seed refuses a nonempty categories table or an allocator that has already issued IDs. See the [current catalogue and copy](official-topics-20261112.md).

For an existing catalogue, `--plan-current` reads the explicitly selected database and prints a concrete read-only plan, even before identity columns have been installed. It shows previous and desired public IDs. `--apply --reconcile-official` installs the platform schema, then reconciles the catalogue in one transaction under the topic graph and identity allocator locks. Semantic matches retain internal topic IDs, private identifiers, matching scene IDs and saved configurations. Public IDs are reassigned to 1–26 in catalogue order; all other topics, including retired and private topics, follow in creation order. Their content and private URLs stay unchanged. The next allocation starts after the final assigned number.

Renames include AGI → ASI, Office → Professional Work, Medical Diagnosis → Medicine, Writing → Creative Writing, Low Hallucination → Factual Accuracy, Memory & Long Context → Long Context, and 3D Creation → 3D Generation. Missing topics/scenes are created; obsolete official topics/scenes become inactive. A topic losing scenes reuses its General/default context as the root, preserving that context's configurations. Retired configurations remain stored. Ambiguous official matches abort the transaction. Old numeric URLs are replaced without redirect aliases. Apply this explicit prelaunch update with application traffic paused, then restart the application so cached metadata uses the new numbers.

No production migration, production write, mail notification or deployment was run during implementation. Schema and catalogue migrations were tested only in generated disposable loopback MySQL databases. Historical migration scripts retain their own old identity normalizer solely for reproducible archived migration tests; runtime routes never import it.

## Verification

Focused tests cover simultaneous publication at the cap, ownership and official protection, idempotent favorites, persistent aliases, numeric scene defaults, scene identity stability, profile visibility and popularity ordering. HTTP tests exercise real redirects and private 404 responses. Chromium checks exercise optimistic favorite synchronization/rollback, publish/private editor controls and the topic report form. The optional MySQL lifecycle and catalogue reconciliation integrations passed against a disposable loopback MySQL 8.4 instance; they require explicit local configuration and skip when unavailable.
