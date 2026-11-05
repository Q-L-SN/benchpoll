# Inline benchmark settings and plain How it works

Deployed at `cd45740` by release `github-merge-20261105-cd45740`. See the
[verified rollout](releases/20261105-workspace-rollout.md) for the current
baseline, checks and rollback. The preceding update is documented in
[`personal-start-polish-20261105.md`](personal-start-polish-20261105.md).
All three follow-ups were installed together; do not replay their overlays.

## Behavior

- Contribute your expertise expands version and fallback settings directly below
  its button. Public and Personal views use the same inline section. The expanded
  state is retained when changing benchmarks, scenes and topics in the same tab,
  including page reloads. Each context displays its own data; unsaved custom
  fallback drafts are cleared when the benchmark or context changes.
- Version choices retain their compact wrapping buttons. Fallback retains the
  existing horizontal cards, chain connectors, community shares, selection and
  deselection controls, and custom-order editor. Cards use the existing narrow
  layout inside the treemap column. Following the community remains an implicit
  state without a separate button.
- In Evaluation items, benchmark detail links occupy the name instead of spanning
  the identity grid and the space around the score count. Mouse and keyboard
  activation still open details.
- Wheel input adjusts selected personal weights only over the treemap. Lists,
  headers and other controls keep ordinary scrolling. The global right-click
  interception and the dark floating adjustment notice are removed. Selecting a
  benchmark shows a solid banner with white instructions above the chart: scroll
  on desktop or drag vertically on touch devices. Saves and Undo retain their
  existing gesture boundaries.
- How it works uses ordinary headings and explanatory paragraphs. Decorative
  captions around headings, slogan-like wording, forced title line breaks and
  the background glow are removed. Interactive ranking and score examples,
  animation pause controls, reduced motion and expandable calculation details
  remain available. The fallback explanation points to the new inline entry.

## Runtime scope

```text
privacy-headers.js
private/home.html
private/how-it-works.html
public/css/how-it-works.css
public/css/ui/chart-workspace.css
public/css/ui/fallback-picker.css
public/css/ui/fallback.css
public/css/ui/mobile-workspace.css
public/css/ui/workspace.css
public/js/home-workspace.js
public/js/shared/mobile-panels.js
public/js/workspace/benchmark-settings.js
public/js/workspace/preferences.js
public/js/workspace/state.js
```

These 14 sources supplement the previous pending overlay. Rebuild home and index
on the reconciled source set, and install each HTML page, manifest and hashed
assets together. Preserve production-only files and verify the current release
hashes before preparing the overlay. How it works also has an updated stylesheet
query string for its unbundled page.

The expanded-state preference changes the inlined home startup bundle. Its
reviewed diff contains the additional boolean preference and minifier identifier
renaming only. `privacy-headers.js` pins the resulting script as
`sha256-gSJ8qx9rEjalgTKcaUDo27aVG1cVfr5AoIMG+jzlQgc=`. Install the matching header
module and restart the application with the new assets; verify the final built
script against this pin. CSP restrictions remain in force.

No dependency update, schema migration, production-data write or GitHub Actions
operations channel is required. The current cloud session has no production
credentials or VPN/TCP access. Publication to GitHub does not establish a live
deployment.

## Verification

- Inline interaction browser tests pass in Chromium at 1440 and 320 px and
  WebKit at 390 px, on source and compiled pages (6 cases each). They cover
  expanded/collapsed state across contexts and reloads, absence of saves during
  inspection, actual name/blank-area clicks, keyboard activation, the new banner,
  chart-only wheel changes, native right-click behavior, save and Undo.
- Compact version/fallback browser checks pass on 4 source and 2 compiled
  layouts, including narrow and short screens. Original cards, version
  deselection, fallback deselection and saved community inheritance are checked.
- Community version/discussion checks pass on 4 source layouts, including the
  custom fallback editor. Mobile gesture checks pass on 3 source and 2 compiled
  layouts, including WebKit touch drift, reversal, cancellation and Undo.
- How it works checks pass on 7 cases across desktop and mobile Chromium/WebKit:
  example interaction, details links, keyboard operation, overflow and motion
  pause/reduced-motion behavior. Desktop and mobile previews were inspected.
- Targeted copy, fallback and enforced-CSP checks: 59 pass, 1 opt-in skip. The
  browser verifies the compiled startup script runs under the pinned policy.
- Both builds pass: home has 149 source inputs and index has 65. Lint passes.
- Full `npm test`: 3,345 pass, 6 skip, 0 fail (3,351 total). Built manifests
  match every source input, and the startup CSP pin matches the generated HTML.

Browser artifacts and logs were written outside the repository under
`/workspace/benchpoll-checks/inline-settings-20261105` and `/workspace`.
