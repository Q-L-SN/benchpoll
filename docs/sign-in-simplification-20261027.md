# Sign-In Simplification (2026-10-27)

## Context Map

Reviewed before edits in `codex/flat-topics-home-20261022`. Preserve unrelated
dirty changes and never interact with already-open user pages.

| Files | Purpose and scoped change |
| --- | --- |
| `server.js`, `privacy-controls.js` | Serve a dedicated sign-in page; retain OAuth/CSRF/version/hash/age evidence; omit research changes unless explicitly chosen; guard the completion route |
| `private/sign-in.html`, `public/js/sign-in.js`, `public/css/sign-in.css` | Compact single-action sign-in, visible Terms/Privacy/16+ notice, loading/retry, no optional settings |
| `public/js/shared/sign-in.js`, `public/js/global.js`, `public/js/topics-home.js`, `public/js/shared/account-center.js` | Consistent popup entry, blocked-popup fallback, verified completion notification and Home profile refresh |
| `private/loginCallback.html`, `public/js/loginCallback.js` | Close successful popups without an extra confirmation; usable same-window/blocked-storage fallback |
| `private/home.html`, `public/js/home.js` | Replace blocking success dialog with existing shared toast |
| `private/account-privacy.html` | Link to processing details instead of repeating operator geography in the short notice |
| `test/privacy-controls.test.mjs`, `test/account-privacy-ui.test.mjs`, new sign-in tests | Consent preservation, actual authenticated completion, popup flow and responsive behavior |

Dependencies: existing `postJSON`, account/privacy status and safe-provider URL
validation, exact account-write ownership, shared UI actions/toast, legal document
hashes, session regeneration and guarded frontend build/release tooling. Sign-in
itself adds no provider, database migration, OAuth scope, third-party script or
cookie. The subsequent proposal/profile features require the additive schema
preparation recorded below.

Risk review: preserve current research permission on every sign-in, never grant
research from button assent, never trust a query/local-storage flag as account or
legal evidence, do not weaken callback state/age/hash checks or mutate on GET.

## Design Contract

| Field | Decision |
| --- | --- |
| Job and action | Sign in with GitHub; one compact continuation action |
| Hierarchy | BenchPoll logo, sign-in heading, one short account-data explanation, Terms/Privacy/16+ statement, GitHub action |
| Navigation | Same shared popup from Home/configuration/contributions; same-window fallback if blocked |
| Visual language | Existing typography and shared action tokens, unframed white surface, neutral dividers, no accent side decoration |
| States | Loading, ready, submitting, retryable status/provider failure, expired notice, success/fallback |
| Responsive | Centered constrained content on desktop/popup, readable at 320px and keyboard accessible |
| Acceptance | No required checkboxes or privacy-request/research UI in login; explicit button click records current notices and age; existing optional preferences unchanged |

Repository evidence is the existing shared control and account UI. UIZZE search
references: Spotify Create Account (`https://uizze.com/screens/975055bfffd63b89502ee2efe5558d64`),
Amazon Sign Out (`https://uizze.com/screens/69957af80019fb313b8e`) and X Display
Settings (`https://uizze.com/screens/9ed6c008075fc7672b5bae49c4be1dbc`). Transfer only
single-action hierarchy, adjacent notice, and separate settings; not branding or
visual details not inspected. ICO layered-notice guidance and GitHub OAuth docs
were consulted. This change is not a legal compliance certification.

Operator geography comes from the operator's earlier statement, not user IP or
inferred nationality. Accurate hosting/administration disclosures remain in the
Privacy Policy; no fake US establishment or replacement identity is introduced.

## Follow-Up Scope

The same user turn also requests universal topic summaries at the former AGI
context position (no special AGI claim/help), creator metadata on the right,
stronger sidebar-card selection, more prominent Home summaries, a chevron entry
icon, blended sidebar surroundings, and a clear Home-only beta feedback entry.
The five sidebar mode buttons use solid orange selected glyphs, not a colored
button background. These are distinct from the topic-card selected state.

Public/private topic creation is fixed by the clicked entry, named in its title,
not changed with a checkbox/radio. Public submissions use the existing review
queue and verified-email decision outbox; only approval creates a public topic.
Private topics remain immediate. Both forms show the established email notice
only for public submissions. No real test topic will be published or reviewed.

The later request supersedes immediate review: public entry opens
`/topic-proposals`. A public proposal is voted on by distinct authenticated
accounts; 30 supports promote it once to the review queue. The hall owns public
proposal input, while the Home/sidebar dialog creates private topics only.
Sponsorship is reserved for future work, not payment UI or a current bypass.
Only future directly sponsored topics display creator metadata; current ordinary
public topics do not. The new hall route is reserved against topic-name collisions.

The account center gains an explicit default-off public GitHub link setting.
Canonical usernames come from the provider, never the editable display name.
Opt-out/deletion must remove the link from public payloads. Desktop sidebar state
defaults collapsed only when no valid preference exists, then persists normally.

The experiment was resolved by the user: only Rational (a=5), 5c/(1+4c), remains
for fresh Available results calculations. Remove the selector and preference,
update concise guide/help and retain zero/full/negative-score safeguards.

Additional files are `topic-service.js`, existing moderation/email/reviewer
integration, sidebar/Home creation controllers, topic presentation CSS, ranking
modules/contracts/startup and focused tests. Deployment uses a restricted
`topics-account-20261027` code scope with candidate builds, code backups,
source hash guards, bounded restart, health checks and conflict-aware rollback.
Its code manifest has no embedded migration; separate guarded preparation adds
two proposal tables and two profile columns. No old identity, Pie, discussion or
score records are rewritten or discarded.

## Verification and Release

- Branch: `codex/flat-topics-home-20261022`; no changes to the original checkout.
- Full suite: 2,644 passed, 2 skipped, 0 failures. Dedicated Chromium/WebKit
  sign-in, profile, topic-presentation and proposal browser suite: 86 passed.
- ESLint passed for changed application and release files, excluding the
  unchanged vendored D3 distribution from project-owned-source linting.
- Real MySQL rehearsal used a release-owned temporary database and ran both
  schema preparations twice. Existing records/timestamps were identical and
  existing GitHub visibility remained off. Generated columns are recomputed
  instead of being explicitly copied. The temporary database was removed.
- A verified complete gzip database backup (165,134,820 bytes) preceded schema
  application. Protected production data counts/digests remained unchanged.
- Release: `topics-account-20261027-1793116037417`, 69 files, healthy at
  `2026-10-27T15:58:56.352Z` (2026-10-27 23:58:56 Asia/Shanghai).
- Stage: `/home/ubuntu/benchpoll/scripts/topics-account-20261027/topics-account-20261027-1793116037417`.
  Code backup: `/home/ubuntu/benchpoll-code-backups/topics-account-20261027-1793116037417`.
- The first code replacement failed on the pre-existing root-owned generated
  index asset directory. Conflict-aware rollback restored 63 replaced files and
  restarted the previous app. Only that directory's owner was corrected; a new
  writable-parent preflight now rejects this condition before stopping the app.
  The retry passed installed-file/source hashes and health checks.
- Candidate inline startup hash matched the pinned CSP; no unsafe-inline policy
  exception was introduced.
- Fresh public Chromium 1440px/390px and WebKit 390px checks covered Home,
  fully loaded configuration including sidebar persistence, proposal hall and
  panel, compact sign-in, and guest completion-route rejection. No page errors,
  unapproved mutation requests, account edits, proposals, votes, approvals or real
  emails were generated. Only deliberately blocked Cloudflare analytics were
  observed. Existing user tabs were not used.
- Resend runtime reported valid delivery configuration; historical queued IDs
  remain below the existing future-only notification floor. No queue was flushed.
- Sponsorship and dynamic topic references remain unimplemented by design.

Local verification artifacts are under
`D:/Codex-artifacts/website1/sign-in-simplification-20261027/`, with final public
screenshots and results in the release subdirectory's `public-complete` folder.
