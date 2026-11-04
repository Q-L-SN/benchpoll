# Common language scenes and sidebar direction — 2026-11-04

This change is prepared on `codex/cloud-handoff-20261101`, based on the verified
November 4 rollout. It has not been applied to production by this cloud session.

## Result

- Language: General (default), English, Chinese, Japanese, Korean, Spanish,
  French, German and Arabic. The other 176 active language scenes are retired.
- Coding: General (default), Python, JavaScript, TypeScript, Java, C, C++, C#,
  Go, Rust and PHP. General reuses the original Coding root context ID, so its
  saved weights, incoming references and discussions remain attached to it.
- New programming-language scenes start with independent, empty community
  weights. General's weights are not copied into them or presented as evidence
  for a specific programming language.
- Retained language scene IDs, names, slugs, descriptions and histories stay
  intact. Retired scenes are marked inactive, not deleted. Existing references
  to them retain their allocation as unavailable weight; nothing is silently
  redirected or redistributed. The inspection lists every retired scene for
  review before applying.
- C, C++ and C# use `/coding/c`, `/coding/c-plus-plus` and `/coding/c-sharp`.
  Scene slug generation preserves `+` and `#` as words for new scene paths.
  Existing stored paths remain authoritative. Reference links use stored slugs,
  and private scene creation/editing accepts these three names together.
- The desktop sidebar control uses a left chevron while open and a right
  chevron while closed. It no longer mounts the vertical disclosure adapter.
  Its accessible state and saved preference remain unchanged.

## Narrow installation

The live baseline is documented in
[the November 4 rollout](releases/20261104-scene-community-rollout.md).
Do not replay the old taxonomy, snapshot, community-version, discussion or ARC
migrations. Do not edit their historical specifications to represent this change.

`node ops/export-common-language-scenes-20261104.mjs /absolute/new/directory`
exports only the changed source, the new migration/specification and fresh
bundles. Verify live file hashes and dependencies against the current deployed
manifest before installing the allowlist. Install the source/bundles before
activating the new scene catalogue, so reference URLs and scene editors support
the programming-language names. No production environment or credentials are
included in the export.

The new migration defaults to a read-only inspection:

```sh
node scripts/migrate-common-language-scenes-20261104.mjs
```

Review its retained/retired/added lists and `planHash`. Pause application and
background writes, verify a fresh backup using the existing manifest format,
then apply exactly that plan:

```sh
node scripts/migrate-common-language-scenes-20261104.mjs --apply --expect-plan=<reviewed-planHash> --backup-manifest=/private/path/manifest.json
node scripts/migrate-common-language-scenes-20261104.mjs --check
```

It requires the existing transactional schema, takes the topic graph lock,
checks the live plan again, archives the previous catalogue, and commits all
scene changes atomically. Digests verify saved weights, fallback choices,
references, discussions and proposals are unchanged. A failure rolls back;
repeating a completed migration verifies without making another change. The
`--rehearse` backup exemption is limited to explicitly named disposable databases.
After resuming services, verify both topic APIs, default-path redirects, scene
lists, C/C++/C# links, and the sidebar in both states.

Ordinary code rollback must retain the stored-slug and scene-slug support while
these scene names exist. A catalogue reversal needs a separately reviewed plan
using the migration archive; do not delete new contexts with user activity or
restore a whole database over subsequent work.

## Local verification

Tests use synthetic data in randomly named local MySQL databases. They cover
read-only inspection, stale-plan rejection, rollback after partial writes,
identity/history preservation, repeat execution, private scene editing and
canonical URLs. Chromium and WebKit exercise the real migrated homepage at
390 and 1440 pixels. The sidebar is checked in source and built pages, including
both directions, reload persistence and mobile visibility. Neither these checks
nor a GitHub push establish production deployment.

After incorporating the concurrent `a8f3a7e` ranking-memory fix, 3,320
unit/contract tests passed, six explicit skips and no
failures; 16 isolated MySQL tests passed, including the existing lifecycle
journey. The migrated directory passed all four Chromium/WebKit viewport
journeys. Four source/built sidebar journeys passed. Both frontend builds and
lint passed.
