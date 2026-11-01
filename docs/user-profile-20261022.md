# Public User Profiles (2026-10-22)

## Context Map

| Authorized path | Purpose |
| --- | --- |
| `user-profile-service.js` (new) | Idempotent schema export, effective profile loader, validated saves. |
| `public/js/shared/profile-editor.js` (new) | Shared accessible profile dialog and raster upload normalization. |
| `public/css/ui/profile-editor.css` (new) | Scoped dialog and discussion-author presentation using existing tokens. |
| `test/user-profile.test.mjs` (new) | Validation, schema, default/custom fallback and safe account IDs. |
| `test/profile-editor.test.mjs` (new) | Focused editor contract and validation tests. |
| `test/profile-editor.browser.mjs` (new) | Actual dialog, upload, async errors, cancellation and responsive checks. |
| `discussion-service.js` | Shared author SQL/response projection; subsequently authorized flat topic navigation query. |
| `public/js/discussion.js` | Author name/avatar and profile-update rendering; subsequently authorized topic labels. |

Read-only integration dependencies: `server.js`, `privacy-headers.js`,
`public/js/shared/account-identity.js`, `public/js/shared/http.js`,
`public/js/shared/ui-components.js`, `public/css/ui/tokens.css`, `db-transaction.js`.
Existing reference tests: account identity/precision/transport, discussion service,
privacy headers and browser fixture tests.

Risks: parent must register routes, call the schema export from the unified
migration, include the stylesheet and update CSP. These files do not connect to
the database on import; no database connection/apply is part of this work.

## Design Contract

- Job: edit the public name and picture used by topic creators and discussions.
- Hierarchy: profile title, avatar preview with upload/reset, display name, error,
  Cancel and Save. No account ID or extra GitHub username field is rendered.
- Controls: native modal dialog and file input, labeled text input, existing
  Font Awesome icons/action styling, one primary save command.
- Appearance: existing tokens/type; compact unframed form; complete neutral
  outline; no accent side stripe, nested cards, marketing copy or decorative art.
- States: draft, decoding/cropping, saving, validation/server/account error,
  success and cancellation; late async work cannot mutate a closed dialog.
- Responsive: constrained dialog width, stable avatar dimensions, wrapped actions,
  keyboard focus, Escape dismissal and focus restoration at desktop/mobile widths.
- Evidence: existing account dialog and shared control styles. The
  [UIZZE catalogue](https://uizze.com/) was checked; its screen search was not
  accessible through the available browser tool, so no external screens are
  claimed as design evidence.

## Integration Contract

The custom table is `user_public_profiles`, keyed by `user_ID` (BIGINT UNSIGNED),
with nullable `display_name` and `avatar_data_url`. GitHub-owned `users.name` and
`users.profile_picture_URL` remain untouched. `NULL` means use the current GitHub
default. Creator projections should join this table and `COALESCE` the custom
columns with those source columns, retaining deleted-account checks.

Authentication transport is unchanged: `pageAccountWriteScope.write(postJSON,
path, body)` injects `expectedUserID`; `requireAccountWriteOwner` validates and
strips it before calling the strict save service. There is no `accountUserID`
transport field.

The browser accepts PNG/JPEG/WebP uploads and converts a centered square crop to
a small PNG, stripping canvas-added ancillary/ICC metadata (including WebKit's
`sBIT`/`iCCP` chunks). The server deliberately supports only the validated canonical PNG
storage format (8-bit, non-interlaced RGB/RGBA). JPEG/WebP uploads therefore do not
require a partial server decoder or new dependencies. Unsupported PNG variants,
SVG, URLs, animations and metadata-bearing payloads are not storage formats.
Validation follows the [PNG specification](https://www.w3.org/TR/png-3/), with
bounded inflation using [Node zlib](https://nodejs.org/api/zlib.html).

Parent owns the `/api/save_user_profile` route with same-origin, authentication,
current-terms and account-write-owner guards, plus `/api/get_user_profile`
integration. Both profile responses must use `Cache-Control: private, no-store`.

The CSP inspected before parent integration was `img-src 'self' https:` and did not allow data images.
Parent should use `img-src 'self' data: https://avatars.githubusercontent.com`
(and update related header tests). No `blob:` permission is needed by the editor.

## Service API

```js
import { ensureUserProfileSchema, loadUserProfile, saveUserProfile } from './user-profile-service.js';

// Parent's unified migration only; never called by a profile request or import.
await ensureUserProfileSchema(connection);

const profile = await loadUserProfile(db, authenticatedUserID);
const saved = await saveUserProfile(db, authenticatedUserID, businessBody);
```

`loadUserProfile` accepts a pool/connection with `execute`, returns `null` for an
invalid/missing/deleted account, and otherwise returns:

```js
{
    userID,                      // canonical decimal string, never a rounded Number
    userName, userProfilePictureURL,
    hasCustomDisplayName, hasCustomAvatar, // booleans
    defaultUserName, defaultUserProfilePictureURL,
    role, hasVerifiedEmail
}
```

The defaults are for the authenticated account's editor only; do not spread the
whole private profile response into public topic/discussion APIs. Public author
projections need just the effective name/avatar, not another GitHub username or
the account ID. The loader rejects a DB row whose exact identity differs from
the requested identity. Default avatar URLs must be credential-free HTTPS URLs
on `avatars.githubusercontent.com`.

`saveUserProfile` accepts the application's pool (`getConnection`) and a strict
body containing `displayName` and/or `avatar`. Omitted keys retain existing
custom/default behavior. An empty body and unknown fields are rejected. The
route guard must already have removed `expectedUserID`. The service returns the
effective profile above, not `{ profile: ... }`.

- `displayName`: a trimmed, NFC-normalized string of 1-60 Unicode code points;
  reject controls, lone surrogates, bidi control marks and invisible-only names.
  Unicode letters, combining accents and emoji ZWJ sequences are supported.
  Names are not unique. `null` is not a display-name reset command.
- `avatar`: canonical `data:image/png;base64,...` or `null` to resume the latest
  GitHub default. No remote URL, SVG, JPEG or WebP is accepted as stored input;
  JPEG/WebP are supported by the browser normalization path.
- Maximum serialized UTF-8 business payload: 307200 bytes. Each PNG side must be
  1-256 pixels. PNG signature, chunk lengths/order/CRC, 8-bit RGB/RGBA header,
  complete bounded zlib stream and every scanline filter are checked. Only
  `IHDR`/`IDAT`/`IEND` are accepted; no interlace, APNG, ancillary chunks, trailing
  bytes or compressed expansion beyond the declared pixel buffer. The server
  re-encodes validated scanlines before storage.
- Save locks the active, non-banned user row, updates only the custom table,
  reloads the effective profile and commits with existing transaction helpers.
  Concurrent partial saves do not clear unrelated custom fields. Uncertain
  commit acknowledgements discard the leased connection.
- Runtime needs `node:zlib.crc32`, available in Node 20.15+/22.2+; verified here
  on Node 22.22.1. No package installs or dependency changes were made.

The 300 KiB service limit is checked after the shared guard strips identity
metadata; the client reserves 2 KiB for name/JSON/transport fields. The global
Express JSON parser was 1 MiB at inspection. If an exact raw HTTP body limit is
also wanted (including whitespace/JSON escapes), the parent route/body-parser
layer must impose it before the global parser consumes the stream.

## Editor API

```js
import { openProfileEditor } from '/js/shared/profile-editor.js';

const result = await openProfileEditor({
    profile: currentAuthenticatedProfile,
    onSaved(effectiveProfile) { /* refresh this view */ }
});
// result is the effective saved profile, or null for local dismissal.
```

The editor binds only through `pageAccountWriteScope`; its shared HTTP request
requires a JSON acknowledgement and times out after 20 seconds. It sends only
changed business fields, so replacing a photo does not pin the current GitHub
name as a custom name. Native uploads are limited to 10 MiB, 8192px per side and
32 megapixels, decoded and center-cropped to <=256px; exceptionally large PNG
encodings are reduced further until below the payload budget.

Successful saves synchronously dispatch:

```js
document.dispatchEvent(new CustomEvent('benchpoll:profile-updated', {
    detail: effectiveProfile
}));
```

This happens exactly once, before calling `onSaved`. Callback failures do not
reclassify an acknowledged save as a failed write. Errors retain the in-memory
draft, never local/session storage. Closing aborts outstanding upload/read work
and requests and ignores late responses/callbacks. Closing or timing out cannot
undo an update already received by the server; refetch before reopening after
an uncertain outcome.

The native modal has explicit Tab cycling, Escape cancellation, labels, an error
live region, focus restoration, stable avatar dimensions and touch targets.
It reuses the existing Font Awesome/action primitives. Include
`/css/ui/profile-editor.css` (and normal shared UI styles) at page load so
discussion avatars have styles before anyone opens an editor; editor opening
also lazily includes its stylesheet if the marked link is absent.

When a caller disables its edit button while awaiting this dialog, it must
re-enable that button before restoring focus. When opened via a pointer on
WebKit, native buttons may not take focus; callers that need a particular return
target should explicitly focus it after resolving the editor.

## Discussion Integration

The shared selection used by feed roots, thread roots and reply pages now joins
`user_public_profiles` and selects effective names/avatars. Response decoration
returns `authorName` and `authorAvatarURL`, never a public author account ID.
Deleted-message avatars are redacted even for legacy/mocked rows; SQL also
redacts deleted accounts. Existing post/reply relationships remain unchanged.

The discussion client renders names as text, allows only the canonical PNG or
GitHub-default avatar URLs, gives decorative avatars an empty alt text and
`no-referrer`, and removes broken images without replacing the author's name.
Profile events immediately update visible own-author labels and retain the new
identity for any subsequently completed/in-flight discussion reads. An explicit
`null` avatar does not fall back to an old post avatar.

The navigation category query now selects `NULL AS parentID` and visible scope
labels say "topic"/"topics". Legacy API keys/DOM IDs remain stable; post
`parent_ID` still describes discussion replies and is not flattened.

## Verification

Run without a database or application server:

```powershell
node --test test/user-profile.test.mjs test/profile-editor.test.mjs test/profile-editor.browser.mjs
$env:PROFILE_EDITOR_BROWSER = 'webkit'
node --test test/profile-editor.browser.mjs
```

The default browser is Chromium. The WebKit fixture clears only its child
browser's proxy environment for loopback requests; all non-local network traffic
is intercepted/blocked. Browser fixtures exercise the proposed image CSP, not an
assumption that the parent's production header has already changed.

Security/unit coverage: exact unsigned BIGINT account identities, Unicode and
control limits, canonical fallback/custom flags, preservation across simulated
OAuth refresh, partial saves, strict field allowlists, whole UTF-8 payload size,
PNG corruption/truncation/metadata/animation/expansion rejection, schema
idempotence and transaction cleanup. Real discussion service tests cover custom
identity in feed/thread/reply projections and flat navigation.

Browser coverage: native modal and keyboard flow; screenshots/layout at
1440x1000, 390x844 and 320x640; PNG/JPEG/WebP center crop and pixel inspection;
reset; server errors/retry; malformed success acknowledgements; async callback
errors; upload supersession; dismissal during upload/save; account mismatch and
in-flight invalidation; request timeout; no CSP violations or uncaught errors.
Screenshots are generated outside the checkout in
`$env:TEMP/benchpoll-profile-editor-20261022`.

Expanded existing-suite runs found out-of-scope fixture drift during the parent's
flat-topic work: discussion listing fixtures expected the old hierarchical
category lookup/navigation SELECT, account-write fixtures expected the old
private-category INSERT parameters, and privacy browser inventory/navigation
expected `private/home-built.html` and `/Intelligence` instead of flat-topic
navigation. Those pre-existing test files were not changed by this task. Do not
describe the full repository suite as passing on the basis of the focused tests.

No database apply, deployment, commits, branch switches or reverts were run.
