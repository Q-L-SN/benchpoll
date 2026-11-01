# Search Discovery: SEO and GEO

Updated: 2026-11-01. This document describes implemented discovery behavior, not a promise of search ranking or AI citations.

## Public Pages

- The homepage includes public topic names, summaries and ordinary topic/scene links in the initial HTML. Scene lists use native expandable details. JavaScript replaces these cards with the existing interactive previews rather than duplicating them.
- A public topic has its own title, description, canonical URL, Open Graph and Twitter preview metadata. Nondefault scenes use `?scene=ID`; the default scene canonicalizes to the topic URL. Tracking, model-focus and comparison parameters do not create separate indexed pages.
- Where public weights exist and the ranking service responds in time, the initial topic HTML includes the first page of public model scores, measured coverage and evaluation weights. These use the same public preview service, eligibility rules and AA exclusions as the homepage. No private or session-personal ranking is rendered for discovery.
- Snapshot scores are explicitly described as **Estimated score**, not raw measurements. Coverage is already expressed in percentage units by the ranking API. Weight basis points are divided by 100. Ineligible/non-finite model rows are omitted.
- JSON-LD describes BenchPoll, the website, the current page, breadcrumbs and visible item lists. It does not invent reviews, ratings, laboratory results or a special AI schema. Once the interactive topic UI takes over, the snapshot ItemList is removed so later filters/personal weights cannot leave stale structured rankings behind.
- The methodology and four policy pages have descriptive titles, canonical addresses and social preview metadata. The method guide explicitly distinguishes measurements, estimates, ranges, coverage, public/personal weights and live references.

## Discovery Endpoints

| Endpoint | Contract |
| --- | --- |
| `/robots.txt` | Permits public crawling and assets; excludes account, private, API, login, contribution, moderation, proposal and dialog routes. Declares the sitemap. |
| `/sitemap.xml` | Public documents, active public topics and nondefault scenes. Private topics never enter the catalogue. No fabricated topic modification timestamps. |
| `/llms.txt` | Optional human-readable and machine-readable navigation with methodology, public topics/scenes and policy links. Not a requirement for AI search and not an instruction to favor the site. |

These routes run before session middleware, support GET/HEAD, and cache for 60 seconds. The catalogue is single-flight, retries failed loads and is invalidated on relevant application writes. Public ranking snapshots wait at most 1.5 seconds, share concurrent requests for the same scene, and permit at most two crawler-triggered preview jobs. An unavailable ranking does not prevent the topic identity and links from rendering.

Robots directives are not authorization. Private data continues to require the existing server-side owner checks. Sensitive/action responses also receive `X-Robots-Tag: noindex, nofollow, nosnippet`. No Google/Bing ownership verification token, IndexNow key, analytics tag or new training-crawler policy is fabricated by this release.

## URLs and Error Semantics

Canonical public-topic redirects use HTTP 308. Unknown topics and invalid scene IDs return the existing styled error page with the actual HTTP 404 status, not a redirect to a 200 dialog page. Service errors retain their actual status, use `no-store`, and are not indexable. Error-page assets use absolute paths so a nested unknown URL still loads its styling and controls.

## Verification

Run:

```sh
node --test test/search-presentation.test.mjs test/search-legal-release.test.mjs test/home-assets.test.mjs
node --test test/search-discovery.browser.mjs
node --test --test-concurrency=4 "test/**/*.test.mjs"
```

Checks cover escaping, private-data exclusion, scene canonicalization, snapshot units, structured-data consistency, cache concurrency/timeouts, real HTTP error status, static metadata and GET/HEAD endpoints. Browser tests exercise Chromium and WebKit at desktop/mobile widths, JavaScript-disabled content, hydration, CSP and terms readability.

The release uses an explicit source-file allowlist plus generated home/index bundles, captured production hashes, backup and rollback checks. It requires no database migration. The Terms version is `2026-11-01`; Privacy remains `2026-10-30`. Acceptance continues through the existing inline legal notice rather than a new mandatory settings journey.

## Production Verification

Production verification on 2026-11-01:

- Releases `search-legal-20261101-1793466600013` and the no-script layout follow-up `search-legal-20261101-1793466600014` are live, with healthy service checks and no database migration.
- The public catalogue contains 32 topics and 200 nondefault scenes; the sitemap contains 238 canonical URLs including the six public documents.
- The final unit run passed 3,223 tests, with two existing conditional skips. Focused browser checks passed 38 tests; the subsequent no-script layout checks also passed. All four production HTTP/browser checks passed, including Chromium desktop, WebKit mobile and script-disabled mobile.
- The existing CSP still blocks Cloudflare's edge-injected telemetry beacon. That expected privacy block is reported separately from application/CSP failures; no third-party script permission was added.

## External Operations

After deployment, the owner can submit `https://benchpoll.com/sitemap.xml` in verified Google Search Console and Bing Webmaster Tools, inspect representative topic/scene URLs, and monitor indexing and actual search referrals. Those account-level actions require ownership access and are separate from the implemented website changes. Search engines decide crawl frequency, inclusion and ranking; AI systems decide citations. A readable site and accurate evidence improve eligibility, not guaranteed visibility.

The Terms remove draft-like editorial language and describe the actual service and proposal rules. Mandatory rights, privacy boundaries and third-party source restrictions remain. The operator's real public legal name/address still require confirmation; the release does not invent a company or represent that a legal review has occurred.

## Primary References

- [Google: AI features and your website](https://developers.google.com/search/docs/appearance/ai-features): normal SEO foundations apply; no special AI text file or schema is required.
- [Google: Introduction to structured data](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data): structured data describes the page's actual content.
- [Bing Webmaster Guidelines](https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a): useful crawlable content without search/AI manipulation.
- [OpenAI: Overview of crawlers](https://developers.openai.com/api/docs/bots): search discovery and model-training crawler controls are distinct.
- [Supreme People's Court: Contract interpretation](https://www.court.gov.cn/zixun/xiangqing/419382.html): formal wording does not replace required notice of material standard terms.
