# Traffic And Login Audit

Read-only investigation. No tracking, account, authentication policy, WAF or
cookie configuration was added or changed. No source IPs, account IDs, private
mailboxes, OAuth codes or raw access-log lines are included here.

## Screenshot Evidence

- The 24-hour screenshot shows 101 unique visitors, 1.55k requests and 27.68%
  cached. This is Cloudflare zone traffic, not a count of registered users or
  confirmed humans.
- Direct system clipboard-image retrieval failed. The previously attached
  30-day screenshot (`codex-clipboard-0bc04dea-5a0f-4f68-af74-4bc115716745.png`)
  covers September 18 to October 18: 2.29k unique visitors and 180.77k requests.
  It shows a request peak around October 7-8 of about 34k without a comparable
  visitor spike. Do not assume it is a different, newer clipboard image.
- Monthly unique-IP counts cannot be divided by 30 to obtain actual daily human
  visitors. Requests per unique IP are not requests per person or conversion.

Cloudflare's definition includes requests from unique source IPs, including
automated clients and partial-content fetches that never load a page:
https://developers.cloudflare.com/analytics/faq/about-analytics/

## Origin Evidence

The first inspection covered October 18 09:40 to October 19 09:40 UTC (October
18 17:40 to October 19 17:40 Asia/Shanghai). Of 2,368 parsed origin requests:

- 769 advertised an automation-like user agent; 599 included HeadlessChrome.
  These include our own browser checks and are not all outside crawlers.
- 237 targeted probe-like paths such as PHP/WordPress, `.env` or `.git` routes.
  This group overlaps the user-agent classification and cannot be added to it.
- Eight source IPs successfully POSTed to the ranking-workspace endpoint. These
  include the owner and automated tests; they are not eight confirmed humans.
- No `/api/prepare_github_login` or `/github_callback` request was observed.
- Eighteen HTTP 502 responses occurred at October 19 04:48:55-04:49:13 UTC
  (12:48:55-12:49:13 Asia/Shanghai), including privacy-page assets. This matches
  the mail-activation outage already recorded and repaired, not proof of an
  ongoing OAuth failure or proof of zero affected users.

An expanded inspection could only cover retained logs, October 5 00:03 UTC to
October 19 09:42 UTC, not the whole screenshot's 30 days:

- 149,977 requests from 1,769 source addresses.
- 66,560 automation-like requests, including 57,328 HeadlessChrome requests.
- 10,481 probe-path requests, overlapping the group above.
- 60 source IPs successfully requested ranking workspaces, including tests.
- October 7 UTC: 33,033 requests, 15,659 HeadlessChrome, five successful
  ranking-workspace source IPs. October 8 UTC: 25,510 requests, 13,321
  HeadlessChrome, five such source IPs.
- Four `/github_login` GET redirects and three `/github_callback` redirects
  were logged over the retained interval. These are not distinct users or proof
  of completed new-account signups. No new-flow preparation POST was observed.

Origin data cannot reproduce Cloudflare edge analytics: cache hits and blocked
requests may never reach origin; direct-IP probes may bypass Cloudflare. User
agents can be forged, and browser-like does not mean human. Do not report a
percentage of the screenshot's visitors as bots from these data.

## Account And Login Constraints

The database contains two account records; one has verified email and an avatar,
and one has no verified email or avatar. Neither record's identity was printed.
These records do not prove two real active users or a new signup in the period.

Current sign-in is GitHub-only and requires a GitHub account at least 90 days
old, plus the site's explicit legal and age choices. The restriction is an
actual barrier for newer GitHub accounts, but the 24-hour logs contain no OAuth
start, so they cannot establish that it caused the lack of new users.

The useful next measurement is a filtered funnel: load the actual ranking,
change weights, open sign-in, start GitHub authorization, complete sign-in. It
must exclude known self-tests and not silently introduce third-party analytics.
Anonymous browsing and weight editing are already possible, so browsing alone
does not imply intent to register. Current evidence supports substantial
automation and limited verified engagement, not an exact human count or a
conclusion that the product has already been rejected by 2,290 people.
