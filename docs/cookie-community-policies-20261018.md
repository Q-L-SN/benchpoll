# Cookie And Community Policies - 2026-10-18

Internal implementation and evidence reference for the BenchPoll operator and the
parent legal-policy task. This is not a legal opinion, a production audit or a
certificate of worldwide compliance. Both new public documents are in English,
effective and last updated October 18, 2026.

## Reviewed Context Map

| File | Purpose and scoped change |
| --- | --- |
| `private/cookies.html` | New Cookie & Local Storage Policy; existing legal-page structure and assets. |
| `private/community-guidelines.html` | New Contribution & Community Rules; actual platform workflows and visibility. |
| `server.js` | Two `sendFile` page routes before the category catch-all. No authentication, session mutation, database or mail operation in either handler. |
| `public/js/shared/category-route.js` | Reserve `cookies` and `community-guidelines` with existing NFKC/case/separator normalization. |
| `private/home.html`, `private/contribute.html`, `private/how-it-works.html` | Legal footer links only; allow footer/nav wrapping within the existing sidebar. |
| `private/dialogPage.html` | Legal links only, in the existing global-header slot to avoid covering the bottom-aligned mobile dialog. |
| `private/account-privacy.html` | Existing legal navigation only; short labels for all four documents. |
| `test/legal-documents.test.mjs` | Real-handler fixture, reserved-name tests, cross-page links, content/storage contracts and opt-in browser checks. |
| `docs/cookie-community-policies-20261018.md` | Implementation evidence, official references and unresolved requirements. |

Dependencies reviewed without changes: `public/css/legal.css`, `public/js/legal.js`,
`public/js/shared/taxonomy-drawer.js`, `privacy-headers.js`, browser-storage modules,
contribution navigation/templates, score-source policy and existing tests. Existing
`private/terms.html` and `private/privacy.html` are owned by another agent and were
read only for integration. `privacy-controls.js` and
`public/js/account-privacy.js` were not edited. No README change.

Risk review: no API behavior change, schema migration, new runtime JavaScript,
package, consent banner, submission field or access-policy change. The shared
workspace was already dirty. Edits used narrow patches and did not restore any
other contributor's files. No production application was started or deployed.

## Session Evidence

- `server.js` computes `sessionMaxAgeMs` from the required positive environment
  setting `SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000`. The same lifetime configures
  the MySQL session store and `sid` cookie. Cleanup uses
  `SESSION_CLEANUP_INTERVAL_MINUTES`, with `clearExpired: true`.
- The cookie is named `sid`, HTTP-only, `SameSite=Lax`, `secure: 'auto'`, with the
  default site-wide path. It is a signed identifier; session contents are on the
  server. `saveUninitialized: false` prevents untouched anonymous page reads from
  persisting sessions. Static assets precede session middleware.
- `/api/get_privacy_status` uses `ensurePrivacyCSRF(req.session)`, including for
  guests. Opening privacy controls can therefore create a necessary session.
  There is no separate CSRF cookie. Preparing GitHub login stores `githubOAuth`
  state, redirect URI, creation time and legal choice in that session. Callback
  handling consumes/removes the state and checks a maximum age of ten minutes.
  An abandoned state has no independent physical-deletion timer.
- Logout destroys the current request session and clears `sid`; logout-all also
  removes the user's stored sessions. Account deactivation is not full erasure.
  None of these server handlers clears every browser storage key.
- **Lifetime verification limit:** no environment/secret file, production cookie,
  live database or provider account was read in this task. The checked source
  does not fix a numeric deployment lifetime. Consequently the new policy names
  the configuration and issued browser expiry rather than inventing a seven-day
  universal limit. The other agent's Privacy page currently says seven days; the
  parent must verify that separately or align it with the configurable disclosure.
  Test-fixture seven-day values are synthetic, not production evidence.

## Browser Storage Inventory

The public policy groups related uses and lists representative keys rather than
publishing every internal suffix. Storage is origin/browser-profile specific;
account suffixes are identifiers, not an encryption or access-control boundary.

| Group and source | Real storage and content | Retention/removal observed in code |
| --- | --- | --- |
| Guest pies: `workspace/guest-drafts.js`, `workspace/draft-records.js` | `sessionStorage`, `benchpoll:guest-pie:v3:`; selections, weights and fallbacks. Legacy `benchpoll-guest-weights-v2-ordered` is read/migrated. | No timed expiry. Matching draft removal/adoption can remove a record. Legacy entries are filtered when discarded. Otherwise tab-session lifetime. |
| Owned recovery: `workspace/pie-recovery.js` | `sessionStorage`, `benchpoll:owned-pie:v1:`; account/category/context, draft, revision, pending request body and retry identity. | Removed after a matching acknowledged save or discard; newer edits can retain a checkpoint. Failures can retain it. No timed expiry. |
| Workspace/navigation: `workspace/preferences.js`, `navigation/preferences.js` | `sessionStorage`, `benchpoll-workspace-preferences-v1`, `benchpoll-sidebar-preferences-v1`; Public/Personal/score modes, expansion, navigation/scroll state. | Updated on relevant interaction; no extra TTL. |
| Write retry: `shared/write-intent.js` | `sessionStorage`, `benchpoll:unconfirmed-write:`; digest-keyed retry UUID, not a complete request body. | Removed after validated success or specified identity errors; uncertain failures retain it. A separate recovery draft can contain the request. |
| Comparison: `workspace/comparison-settings.js`, `workspace/comparison-profiles.js` | `localStorage`, `benchpoll-comparison-settings-v1:`, `benchpoll-comparison-profiles-v2:`. Guest named profiles and last settings; signed-in local last-configuration cache, with named account profiles on the server. | No application-set automatic expiry. Applicable named-profile deletion removes that item, not all settings. |
| Display/welcome: `workspace/preferences.js`, `home-welcome.js` | `localStorage`, `benchpoll-workspace-display-v1`, `benchpoll-welcome-seen-v1`. | Written for selected display/dismissed welcome. No automatic expiry. Clearing the welcome flag can show it again. |
| Cross-tab login: `loginCallback.js` | `localStorage`, `user-profile-update`; timestamp signal, not OAuth credentials. | Overwritten on a later callback or removed with site storage; no TTL. |
| Contribution handoff: `shared/contribution-navigation.js` | `localStorage` and `sessionStorage`, `benchpoll:contribution-entry:`; source/object identifiers and supplied prefill/details. | Local entry valid for 30 minutes; expired/malformed entries physically removed only on later activation. Destination copies details to tab storage for reload/back without a new 30-minute TTL and does not consume/delete the local copy. |

`buildContributionURL` only prepares/deduplicates in-memory links. Persistence is
in `activateContributionURL`, triggered by trusted click, middle-click or context
menu activation and explicit form-opening controls. Rendering links must not
read, write or clean browser storage; existing contribution-navigation tests
exercise that distinction.

Tab storage survives ordinary reload and navigation; browser restore/duplication
can retain or copy it. Closing a browser is not guaranteed to clear persistent
preferences or `sid`. Cookie-only deletion, history deletion and cache deletion
are not interchangeable with deleting all site storage. Users can clear local
storage and each live tab's session storage in browser tools. Live/in-memory or
restored pages can recreate feature records. None of these browser actions erases
account data, public posts, moderation records, infrastructure logs or backups.

## Community Workflow Evidence

- Rankings are context-specific. Community/Public Weights aggregate personal
  pies saved in public categories; private categories do not contribute. The new
  page preserves existing visibility and separates optional private-category
  research (off, withdrawable) from necessary operation.
- Scores must identify the actual model, effort, harness/version and material run
  conditions, with source/evidence and honest uncertainty. No new mandatory form
  fields or real-name verification were introduced.
- `score-source-policy.js` rejects manual new scores for a non-null synced source.
  Supported tracked-score corrections retain their version; source-mapping
  issues can go through feedback. `contribute.js` already disables synced-version
  choices for new manual results and links corrections from score details.
- A source snapshot, retrieval date or routine refresh is not by itself a new
  benchmark version. Duplicate/fabricated scores, manipulated vendor claims,
  spam votes, weighting abuse, harassment and privacy disclosures are prohibited;
  evidence-backed criticism of benchmarks/vendors/operator methods is welcome.
- Actual links checked through `contributionRoute`: `/contribute/feedback`,
  `/contribute/benchmark-correction`, `/contribute/reports/new`. The existing
  `/contribute` sidebar contains **Request bulk import** and uses the existing
  editable template. No template was changed or invented.
- Private rights, copyright/trademark concerns and access-blocked challenges use
  `/account/privacy#request`. No mailbox, legal identity, address, operator profile,
  DMCA agent, guaranteed appeal button, immediate adoption or guaranteed email
  delivery is promised. Ordinary discussions and approved facts can be public;
  review-only notes, feedback/private reports do not automatically become posts.

## Official References And Limits

Reviewed on 2026-10-18. These sources inform disclosure, not a conclusion that all
listed processing is lawful in all jurisdictions.

- [ICO: What are storage and access technologies?](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-storage-and-access-technologies/)
  explains that PECR is technology-neutral and covers web storage and pixels, not
  just cookies. Storage that is local or does not contain personal data is not
  automatically exempt. Browser restoration also complicates session durations.
- [ICO: What are the exceptions?](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/)
  describes the narrow requested-service/security exception. Current UK guidance
  also contains statistical and appearance exceptions with separate requirements,
  including information and a simple free objection route. This task does not
  import those UK exceptions into every other country or label every persistent
  preference globally exempt. Necessity, duration and each feature's trigger
  still require assessment. No nonessential default tracker or acceptance banner
  was added.
- [EDPB: Guidelines 2/2023, final version](https://www.edpb.europa.eu/documents/guideline/guidelines-22023-on-technical-scope-of-art-53-of-eprivacy-directive_en)
  and the [official version 2.0 PDF](https://www.edpb.europa.eu/system/files/documents/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf)
  address the technical scope of Article 5(3), including information that is not
  personal data and tracking beyond cookies. Paragraph 4 explicitly does not
  decide consent exemptions; those require case-by-case national analysis.
- [Resend: Custom Tracking Domains](https://resend.com/blog/introducing-custom-tracking-domain)
  states that open/click tracking is disabled by default and configured per
  domain. Its [official tracking explanation](https://resend.com/blog/open-and-click-tracking)
  describes open pixels and link rewriting. This verifies provider defaults, not
  the current BenchPoll domain dashboard. Keep tracking off for service notices
  and verify actual settings before any later assertion. Templates alone do not
  prove that provider-side tracking was never enabled. Service notification
  receipt is not marketing consent.

Cloudflare proxy/security logging remains separate from Web Analytics. Current
`privacy-headers.js` has self-only scripts/connections, blocks the observed external
analytics origin, and permits HTTPS images and same-origin resources. This is
not a blanket tracker blocker. No new claim is made about deployed edge challenge
cookies, Cloudflare log retention, Resend delivery-log retention or every possible
image request; configuration and provider arrangements were not audited here.

## Verification

The new fixture executes the actual production page, public privacy-information
and session registrations extracted from `server.js`, using an isolated
`express-session` MemoryStore and local public assets. It never imports the full
server, `dotenv`, database startup or email worker. All browser requests outside
the loopback fixture are blocked.

```powershell
node --test test/legal-documents.test.mjs
$env:BENCHPOLL_LEGAL_BROWSER = '1'
node --test test/legal-documents.test.mjs test/clean-urls.test.mjs test/static-session-isolation.test.mjs test/contribution-navigation.test.mjs test/feedback-templates.test.mjs test/workspace-preferences.test.mjs test/privacy-headers.test.mjs test/score-source-policy.test.mjs
npx eslint test/legal-documents.test.mjs public/js/shared/category-route.js
node --check server.js
```

- New focused tests passed, including the opt-in Playwright check. The browser
  checks cover both documents at 1440, 390 and 320 pixels, active-section navigation,
  mobile drawer open/close and focused destination, no horizontal overflow,
  real `/api/privacy_information`, no page errors, no cookie and zero storage
  writes on policy load. Route checks include uppercase/trailing slash handling
  and NFKC/separator reserved-name variants.
- All four policy documents link each other. Owned entry-page navigation uses the
  short labels Terms / Privacy / Cookies / Community. Notice-page legal links
  also fit inside the existing header at all three widths.
- Screenshots are local, generated evidence at
  `C:\Users\18665\AppData\Local\Temp\benchpoll-cookie-community-20261018`:
  `{cookies,community-guidelines}-{1440,390,320}.png`, `-viewport.png` variants,
  mobile `-navigation.png` variants and `dialog-legal-links-{width}.png`.
  The full-page desktop capture shows the actual inner-scrolling legal content;
  mobile full-page captures contain the entire document. These are fixture, not
  production screenshots.
- Related regression run: **86 passed, 0 failed, 1 skipped** (87 including nested
  cases). The skipped test is the separately opted-in production edge-injection
  check; it was intentionally not enabled. The focused file has eight content /
  route contracts plus one opt-in browser test.
- Targeted ESLint, `node --check server.js` and scoped `git diff --check` passed.
  Existing CRLF conversion warnings are not whitespace errors. Desktop policy,
  mobile viewport and drawer screenshots were visually inspected; the dialog
  legal navigation received an additional width constraint to preserve the
  existing brand and avoid covering the bottom-aligned dialog.

## Remaining Release Requirements

1. No publicly disclosable operator legal identity/address was supplied. Public
   copy therefore says BenchPoll operator and links only the private request
   route for operator contact. It does not substitute a GitHub handle or personal
   profile. This identity/disclosure gap still needs legal/operator resolution;
   neutral wording is not a finding of compliance.
2. Verify runtime session lifetime and cleanup interval through a separately
   authorized, non-secret deployment check; align the other Privacy page's
   seven-day statement if it cannot be supported.
3. Independently confirm provider-side tracking settings, relevant infrastructure
   retention, contracts/transfer safeguards and any local consent requirements.
   No fixed provider retention was invented. A future non-exempt use needs a real
   prior choice and withdrawal mechanism, not a policy-only update.
4. Another agent owns Terms/Privacy copy and their legal-page navigation layout.
   This task checks reciprocal links but does not change those pages or shared
   CSS. Their expanded header/footer must receive their own narrow-width QA.
5. No deployment, production email send, migration or secret read occurred. Local
   HTTP fixtures and browsers close after testing. The parent task retains release
   responsibility and should re-run integration checks after concurrent edits.
