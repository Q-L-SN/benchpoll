# Homepage controls and full-weight labels

Pending deployment after the verified
[`github-merge-20261104` release](releases/20261104-github-merge-rollout.md).

The homepage header and settings island now start their shared transition
another 64 px earlier in the document. The hero-boundary offset increases from
96 to 160 px; both controls still hide at the top and retain their existing
fade, reversal, focus and reduced-motion behavior.

The full-weight view displays benchmark names without separate version names.
Its tooltips, including members grouped under Other, and accessible labels
follow the same rule. Benchmark names stay intact. Weight shares, tile areas,
version selection and ranking calculations are unchanged. Mixed-view tooltips
retain their existing detail.

## Runtime scope

Only `public/js/topics-home.js` changes at runtime. Apply that source change to
the reconciled production sources and rebuild the index entry point with
`npm run build:home -- --index`. Install its generated assets through a narrow,
hash-checked release based on the current merged deployment. This update has
no schema or data migration. The cloud verification below is not a deployment.

## Verification

- Focused ESLint and the index build passed.
- Homepage unit tests: 43 passed.
- Header browser suite: 18 passed in Chromium and WebKit.
- Built homepage chart suite: 4 passed in Chromium and WebKit.
- Additional built checks passed in both engines at 320, 390 and 1440 px:
  transition boundaries moved exactly 64 px, top-of-page hiding still works,
  full-weight labels/tooltips omit version names, switching views preserves
  weights, and no horizontal document overflow or page errors occurred.
- Mobile and desktop screenshots were inspected. Local verification artifacts
  are outside Git at `/workspace/benchpoll-checks/home-polish-20261105`.
