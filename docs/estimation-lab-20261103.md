# Estimated-score experiments

The owner requested a test selector on 2026-11-03 (Asia/Shanghai), superseding
the earlier instruction to keep the algorithm selector removed. The existing
rational whole-score method remains the default.

## Where to use it

Open a topic workspace, choose **Estimated score**, then use **Test algorithm**
below the ranking toolbar. It works for Public and Personal rankings and on
mobile. The choice belongs to this browser tab's session, survives navigation
and reload, and does not write public weights, saved personal weights or account
settings. A blocked storage write does not prevent an in-memory trial.
Score range hides the selector and retains its ordinary calculation.

Changing algorithms recalculates and orders the complete ranking on the server
before pagination. The algorithm is part of the calculation cache key, startup
request identity, recovery scope and save-refresh presentation identity. Late
responses cannot replace a more recently selected calculation. Returning to
**Current** restores the established formula.

## Formulas and limits

Let `c` be measured coverage from 0 to 1, including successful fallbacks;
`m = 1 - c`; `O` is the original weighted measured contribution. Each new method
keeps `O` fixed, including real zero and negative scores. Predictions retain
their original weight and are bounded to 0–100. If their weighted contribution
is `I`, and the wholly unresolved weight is `u`, set `M = I + 50u`.
Let `g(c) = 5c / (1 + 4c)`.

| Choice | Point estimate |
| --- | --- |
| Current · whole score | Existing observed/predicted average `U`, then `U g(c)` for nonnegative scores or `U (2-g(c))` for negatives. Unresolved weight is excluded from `U`. |
| Missing · unadjusted | `O + M` |
| Missing · rational | `O + g(c) M` |
| Missing · linear | `O + c M` |
| Missing · square root | `O + sqrt(c) M` |
| Missing · midpoint | `O + c M + (1-c) 50m` |

The midpoint method shrinks the missing part toward 50 and can raise or lower
its estimate. All five alternatives lie within `[O, O + 100m]`, the corresponding
Score range. Fully measured scores, measured coverage, evidence eligibility,
reference resolution and fallback selection do not change. A model without a
real result on any weighted test remains unranked.

These are experimental assumptions, not statistically calibrated confidence
estimates. In particular, 50 is a fixed scenario midpoint, not a mean derived
from the selectively tested model population. The alternatives reuse the same
pairwise predictions; they do not claim to fix cross-benchmark correlation or
selection bias. The original algorithm and historical trace validation remain
available unchanged.

Model details show before/after scores and explain unresolved midpoint weight.
Algorithm explanations live in the selector's help and How it works, rather
than adding formulas to each model dialog.

## Validation and release

Focused tests cover immutable observed contributions, both directions of
midpoint shrinkage, bounds, negative/zero measurements, wholly unresolved gaps,
fallback weights, matched comparisons, no-evidence eligibility, paginated trace
validation and invalid requests before any database read. The opt-in MySQL test
uses a fresh loopback-only database and proves cache isolation and unchanged
saved weights. Browser tests cover reordering, rapid changes with a delayed
response, reload, range toggling, model details and mobile overflow.

Commands use Node 22 and the existing lockfile:

```bash
npm test
npm run lint
npm run build:home
npm run build:home -- --index
node --test test/estimation-algorithms.browser.mjs
BP_TEST_BUILT=1 node --test test/estimation-algorithms.browser.mjs
LIFECYCLE_MYSQL_ENV_FILE=/workspace/benchpoll-mysql.env node --test test/estimation-algorithms.mysql.mjs
```

Verified on 2026-11-03: the full suite passed 3,257 tests with 6 explicit skips
and zero failures. All 4 source browser journeys (Chromium at 320, 390 and
1440 px; WebKit at 390 px), the compiled Chromium journey and the isolated
MySQL cache test passed. Both frontend builds, lint and whitespace checks
passed. Browser screenshots, including the six-option menu, are retained in
`artifacts/estimation-lab-20261103/`.

This feature needs no migration. The combined pending release also includes the
earlier topic lifecycle, named scene URLs, mobile UI, public sample and brand
changes. Their one additive snapshot table still requires a fresh verified
backup before installation; no historical migrations may be replayed.

Deployment remains authorized but blocked by the cloud environment's missing
production TCP/SSH route. The observed network policy still reports no VPN and
an empty TCP destination list. No production connection, data change or
deployment is claimed.

Export the complete pending release, including the preceding work, with:

```bash
node ops/export-estimation-lab-20261103.mjs /workspace/benchpoll-release-20261103
```

The exporter verifies build-source hashes and writes a narrow allowlist,
per-file checksums and a manifest outside the checkout. It identifies the source
as the current working tree relative to the handoff commit, and leaves
`readyForInstallation` false until live baseline, network and backup checks are
completed. `PRIOR-CHANGES.md` records the earlier release scope.
