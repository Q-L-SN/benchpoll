# Compliance implementation context

## Reviewed Scope

| File | Purpose | Change |
| --- | --- | --- |
| `privacy-controls.js` (new) | Consent evidence, preferences and private requests | Validate and persist versioned choices; no inferred consent |
| `scripts/migrate-privacy-controls.mjs` (new) | Additive database migration | Four private tables, explicit apply and verification |
| `server.js` | OAuth, authentication and API wiring | Consent screen before OAuth, explicit mutation guards, privacy endpoints |
| `public/js/shared/http.js` | Shared JSON errors | Actionable legal-acceptance message without losing drafts |
| `public/js/global.js` | Shared account UI | Link to the consent page when a write requires acceptance |
| `private/home.html`, `private/contribute.html` | Account and private-category entry points | Privacy controls links and accurate optional-research notice |
| `public/js/legal.js` | Legal-document navigation | Public operator metadata; anonymous request entry |
| `privacy-headers.js` (agent) | Browser privacy and security | Block unnecessary third-party telemetry before static routes |
| `private/account-privacy.html`, related JS/CSS (agent) | Public privacy controls page | Explicit choices and private request form/operator queue |
| `private/privacy.html`, `private/terms.html` (agent) | English notices | Match real processing and flag unresolved identity/provider obligations |
| `public/js/shared/contribution-navigation.js` (agent) | Form prefill handoff | Create necessary local handoff storage only upon activation |

## Dependencies And References

- Exact string account IDs and owner protection: `public/js/shared/account-identity.js`.
- Bounded transaction and rollback helpers: `db-transaction.js`.
- Existing migration pattern: `scripts/migrate-moderation-email-notifications.mjs`.
- Static assets remain before session middleware; privacy headers must precede static assets.
- Existing account deactivation is not erasure; preserve that distinction.
- Existing SMTP outbox is unconfigured. No sending, DNS edits or automatic backlog delivery in this change.

## Verification

- New service tests: version checks, unchecked consent, optional research withdrawal, CSRF, request validation, private pagination and transactional rollback.
- OAuth/mutation integration contracts, privacy-page tests and policy semantic tests.
- Full existing suite and browser desktop/mobile checks before rollout.
- Additive schema dry run, verification and source-hash guarded release; never replace concurrent unrelated changes.

## Risk Review

- Intentional API change: authenticated account mutations require current Terms; reading, logout, deactivation and privacy rights remain available.
- Database migration required before enabling routes; no request-time DDL.
- Existing OAuth sessions must restart via the new consent screen.
- No operator legal name, verified domain inbox, provider agreement, or international-transfer assessment is invented.
- No claim that code changes alone establish worldwide legal compliance.

Reviewed before implementation: keep privacy request content restricted to the requester submission and senior operator queue; no public lookup by reference.
