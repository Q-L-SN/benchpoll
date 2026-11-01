# Topic Identity and Coverage Power

## Context Map

| Area | Files | Change |
|------|-------|--------|
| Public topic identity | `public/js/shared/topics.js`, new name-URL migration | Unreserve existing topic words; require name-derived URLs; preserve old aliases |
| Coverage policy | `public/js/shared/available-score.js` | Replace the current square-root multiplier with measured weighted coverage to power 0.35 |
| Validation and detail | `public/js/workspace/contracts.js` | Use the same shared formula to validate the calculation trace |
| User help | `private/home.html` | Remove obsolete square-root wording; the concise guide remains accurate without extra formula copy |
| Fixed home appearance | Home HTML/CSS, `topics-home.js`, `topics-home/layout.js` | Frost colors with Hatch texture, Outline cards, no appearance pickers or stored overrides |
| Treemap percentages | Home chart rendering and CSS | Smaller percent symbol; bold digits may crop inside small tiles instead of shrinking excessively |
| Verification | Topic/coverage unit tests and frontend fixtures/browser checks | Address consistency, alias collisions, inference boundaries, current response validation |
| Release | Existing staged release, database backup and metadata rehearsal tools | Add one bounded policy-release migration; preserve protected business data |
| Startup CSP pin | `privacy-headers.js` | Replace the reviewed build hash after verifying that the startup diff is minifier identifier renaming only |

## Scope Review

The public catalogue currently has 54 topics. Only Security and Media have
name/URL mismatches, caused by the previous reserved-word migration. Their
names and IDs remain unchanged; only canonical slugs and legacy aliases change.
Private ID-based addresses remain unchanged. New public addresses must equal
the normalized topic name; conflicts are rejected instead of adding suffixes.
There is currently no topic-rename UI/API to extend.

The score change affects only Available results after measured and inferred
contributions have been combined. Keep zero measured evidence incomparable,
full coverage unchanged, negative scores downward-only, and finite saturation.
The user explicitly does not want compatibility work for already-open pages.
Update the current formula directly, without adding another protocol version.
Score range and pairwise inference itself remain unchanged.

## Verification

Implemented and published as `topics-policy-20261026-1792985164298`.

- Public names and IDs are unchanged. Security now uses `/security`, and Media
  uses `/media`. Name normalization is mandatory for new public topic URLs;
  conflicting or reserved names are rejected without suffixes. Previous URLs
  redirect with query strings preserved.
- The existing inference version remains 4. The current coverage factor is
  `coverage ** 0.35`; no compatibility version or already-open-page support was
  added. Zero measured evidence stays incomparable, full coverage is unchanged,
  and the existing negative-score treatment cannot reward missing evidence.
- Home appearance is fixed to Frost colors with Hatch texture and Outline
  cards. Both appearance pickers and preference overrides are removed. Percent
  symbols are half the digit size; small tiles intentionally crop large digits
  while benchmark names retain the existing centered-or-faded layout.

### Tests

- Full unit suite: 2,429 passed, 0 failed, 2 opt-in tests skipped.
- Built-home acceptance: 12 responsive layouts and 38 interaction groups passed
  in Chromium and WebKit at widths from 320 to 1,440 pixels.
- Current coverage-detail browser checks: 6 cases passed across both engines,
  including positive and negative scores at 50% coverage.
- Public browser checks passed in Chromium and WebKit at desktop and mobile
  widths. Screenshots confirm the fixed styles, smaller percent symbols,
  centered/faded labels, and continuous model-edge transitions.
- Read-only public API verification from the release staging directory passed:
  all 54 active topic URLs match their normalized names; four URL redirects
  preserve their queries; 25 inference rows use the new power; 25 preview rows
  agree with their configuration-page scores. The local direct-fetch attempt
  hit a transport timeout, so its failed report is retained separately rather
  than treated as a pass.

### Release Safety

- Metadata-only rehearsal covered 75 public topic records, changed exactly two
  slugs, inserted two aliases, and confirmed idempotency, uniqueness, unchanged
  topic identity, and unchanged production metadata. The rehearsal database
  was removed.
- The production migration used a fresh full database backup, preserved
  protected row counts and digests, and installed 9 runtime source files plus
  15 generated files. No score results, weights, users, or discussions were
  removed.
- The reviewed startup-script diff contains only minifier identifier renaming.
  Its exact CSP hash was replaced without permitting additional scripts.
- Post-release audit verified 187 file hashes with no mismatches. The app and
  score-sync timer are active, and the public release is healthy.

Evidence: `D:/Codex-artifacts/website1/topic-identity-coverage-20261026/`.
The final receipts are under `release-final/`; public API evidence is
`public-policy/report-server.json`, and browser evidence is under
`public-browser/`.
