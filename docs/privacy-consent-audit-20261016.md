# Consent and Storage Audit - 2026-10-16

## Scope

The operator reports being located in mainland China, with US hosting, an English-only interface and potential users worldwide. This is a technical inventory and preliminary compliance assessment, not a legal certification. No terms, privacy policy, consent interface or provider settings were changed in this audit.

## Verified Implementation

- Terms and Privacy pages exist and are linked from the homepage and contribution page. Their presence does not record acceptance or supply consent for every purpose.
- No dedicated terms/privacy acceptance checkbox or versioned acceptance record was found in the inspected application flow.
- The application session cookie is `sid`, configured for seven days, HttpOnly, SameSite=Lax and secure on HTTPS. `saveUninitialized` is false.
- Browser storage supports guest settings, saved preferences and contribution-form handoffs. Some handoff entries are created before a user opens the corresponding form; storage exceptions must be assessed by purpose rather than assuming every localStorage key is essential.
- A clean anonymous production visit set no cookies in the inspected context. This does not establish what every logged-in, challenge or geographically different session uses.
- The same anonymous visit loaded `static.cloudflareinsights.com/beacon.min.js/...` with `data-cf-beacon`, then made a POST to `benchpoll.com/cdn-cgi/rum`. The provider-side injected analytics is not visible as a script in the inspected repository source. No payloads, identifiers or cookie values are included in this report.
- Cloudflare describes Web Analytics as using the browser Performance API for real-user monitoring. Vendor privacy claims alone are not a determination of every jurisdiction's storage/access exception.
- The account-deactivation action is not complete erasure. Privacy-request handling must account for saved weights, private categories, discussions, audit records and backups as appropriate.

## Recommended Separation

| Activity | Recommended treatment |
| --- | --- |
| Browsing public rankings | Do not impose an unnecessary agreement gate. |
| Creating/using an account | Prominent Terms acceptance and Privacy notice; record the accepted Terms version and time. This is not blanket consent to optional processing. |
| Login/security storage | Document necessary storage and retain it only for the relevant purpose. |
| Requested draft/preference storage | Assess the specific exception and defer writes until needed; do not silently add secondary purposes. |
| Analytics | Verify regional exemptions and required choices or disable non-essential collection until the appropriate control is available. No-cookie does not automatically mean no consent requirement. |
| Optional private-category research or future public weighting | Determine an appropriate legal basis; give separate, specific choices and renewed consent when required. |
| Category maintenance | Preserve private mixes where possible; do not overwrite another mix or silently manufacture a new public-weighting choice through an ambiguous merge. |
| Marketing email | Keep separate from transactional review notices and apply the relevant opt-in/opt-out rules. |

## Jurisdiction Checks

- Mainland operation and access to personal data require a Chinese personal-information and cross-border assessment; US hosting and English UI are not blanket exemptions. Small-scale exemptions from particular outbound mechanisms do not waive all notice, consent, impact-assessment or security obligations.
- Mere EU website accessibility alone does not establish GDPR targeting. Offering services to people in the EU or monitoring their behavior requires a separate territorial-scope assessment. EU/UK representation and transfer arrangements must be assessed if the relevant rules apply.
- Other markets' applicable requirements depend on actual operation and data processing, not only the interface language. There is no single worldwide website approval or consent banner that resolves all of them.
- Priorities include accurate operator/contact information, a usable privacy-request channel, retention/erasure procedures, provider agreements and actual transfer safeguards. Further content-platform obligations require separate scope analysis for the discussion feature.

## Official References

- [PIPL](https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2023/art_f374e8245320413181742e6d1baf4366.html)
- [Chinese cross-border data provisions](https://www.cac.gov.cn/2024-03/22/c_1712776611775634.htm)
- [EDPB territorial-scope guidelines](https://www.edpb.europa.eu/documents/guideline/guidelines-32018-on-the-territorial-scope-of-the-gdpr-article-3-version-adopted_en)
- [ICO storage/access exceptions](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/)
- [Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/about/)
- [California privacy-policy guidance](https://oag.ca.gov/node/36676)
