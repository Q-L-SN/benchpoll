# Local and Cloud Fixture Runtime

This bootstrap installs the existing lockfile and previews BenchPoll's topics
homepage with synthetic, in-memory data. It is not a production deployment or a
database-backed copy of every route. Topic links use the existing target
placeholder; OAuth, email, moderation and database migrations are not started.
Restarting the preview discards fixture changes. No `.env`, database, schema
import, production credentials or encrypted handoff is required for this workflow.

## Runtime and Install

Use Node **22.22.1** to match the verified local runtime. Production was separately
verified as Node **22.23.2**. The pinned lockfile requires Node **22.19+ within 22.x, or 24+**: `undici@8.10.0` requires
`>=22.19.0`, while `eslint@10.9.0` requires `^20.19.0 || ^22.13.0 || >=24`.
In particular, Node 20, Node 22.18 and Node 23 do not satisfy both. The root
`package.json` does not declare an engine; setup checks before changing dependencies.

From the checkout, on Linux/macOS or Windows Git Bash:

```bash
bash scripts/cloud/setup.sh
```

The script locates its own checkout, runs
`npm ci --include=dev --include=optional --engine-strict --no-audit --no-fund`,
then `npm run build:home` and `npm run build:home -- --index`. It does not update
the lockfile, run tests/migrations or start any service. `npm ci` replaces that
checkout's `node_modules`. Build outputs are `public/build/{home,index}/`,
`private/{home,index}-built.html` and `private/{home,index}-assets.json`.

Native PowerShell uses the same three commands, after checking `node --version`:

```powershell
npm ci --include=dev --include=optional --engine-strict --no-audit --no-fund
npm run build:home
npm run build:home -- --index
```

Run installation/builds again when dependencies or source assets change. A source
preview does not need a build. Browser binaries are optional for the focused
cloud-runtime HTTP/unit tests and preview serving. The full `npm test` suite
also includes browser-backed tests and requires Chromium AND WebKit. Use the
installed, pinned Playwright CLI:

```bash
node node_modules/playwright/cli.js install --with-deps chromium webkit
```

On Windows/macOS, use `install chromium webkit` instead. Linux `--with-deps` may
require administrator access for system packages. For only the fixture browser
smoke test, Chromium alone is sufficient. Package and browser downloads require network
access; the fixture preview itself has no external-service requirement.

## Preview and New Codex Cloud

The current Cloud UI separates **Install script** (dependencies/assets) from
**Start skill** (service startup/readiness). See the
[official Cloud environments guide](https://learn.chatgpt.com/docs/environments/cloud-environments).
These instructions target that UI, not legacy setup/maintenance settings.

In the environment that contains the restored BenchPoll checkout, select Node
22.22.1 and use `bash scripts/cloud/setup.sh` as the Install script. Keep dependency
installation separate from service startup. Suggested Start skill instructions:

```text
Work from the BenchPoll checkout. Start node scripts/cloud/preview.mjs --port 4173
as a long-running service. Wait for its listening message, check GET / returns 200
and POST /api/get_topics with JSON {} returns a topics array, then open the browser
preview for port 4173. Keep the process running during preview. Use another free
port if 4173 is occupied. Do not run npm start, server.js, migrations, live checks,
production services, or import credentials for this fixture workflow.
```

The default listener is `0.0.0.0:4173`, suitable for a cloud port preview. `--port`
overrides `PORT`; `--host` overrides `HOST`. `--port 0` selects an ephemeral port,
printed after startup. Invalid ports and occupied ports fail with a nonzero exit
instead of silently choosing a different port. Ctrl+C / SIGTERM closes the server.

For a local-only preview, on any platform:

```bash
node scripts/cloud/preview.mjs --host 127.0.0.1 --port 4173
```

Open `http://127.0.0.1:4173/`. Add `--built` to preview the compiled homepage
(`TOPICS_HOME_BUILT=1` also selects it). The default is source mode for editing.
The CLI resolves files from its own checkout, not the shell's working directory,
and does not use `TOPICS_HOME_ROOT`. Binding `0.0.0.0` exposes this synthetic demo
to reachable peers; use loopback locally and do not deploy it publicly.

## Focused Checks

```bash
node --test test/cloud-runtime.test.mjs
node node_modules/eslint/bin/eslint.js scripts/cloud/preview.mjs test/cloud-runtime.test.mjs test/cloud-runtime.browser.mjs
node test/cloud-runtime.browser.mjs
node test/cloud-runtime.browser.mjs --built
```

The browser smoke test uses only Chromium and local fixture requests, checks source
and compiled entry selection, loaded topic cards, JavaScript/HTTP failures and
desktop/mobile overflow. Screenshots default to `artifacts/cloud-runtime/`; set
`CLOUD_PREVIEW_OUTPUT` to an absolute writable directory to redirect them. The Bash
behavior test is skipped on native Windows and runs on Linux/macOS.

`npm test` runs only `test/**/*.test.mjs`; it does not run `*.browser.mjs` or
`scripts/frontend/*`, although several `.test.mjs` files launch real browsers.
Four historical ARC import audit cases require private archived production
snapshots; they report an explicit skip when those files are absent. The ordinary
importer tests still run against synthetic fixtures. No production snapshots are
required or published to make the default suite run. Existing `npm run test:frontend` uses local fixtures, but is
a broader historical UI suite, not this bootstrap's smoke gate. Do not glob-run
all frontend scripts: many `*-live*` and historical review scripts target production.

## Windows Path Audit

Audited `test/`, including `test/helpers/`, and `scripts/frontend/`. No mass rewrite
was made. A Windows-looking path is not automatically a Linux execution failure:
Linux treats `D:/...` as a relative directory containing a literal `D:` component.

| Location | Linux impact |
| --- | --- |
| `test/helpers/frontend-source.mjs:5` and the other helpers | No hard-coded Windows drive paths found. The shared reader uses `fileURLToPath`, `pathToFileURL` and repository-relative URLs. |
| `test/resend-setup.test.mjs:669,685,690` | Not an OS blocker: the Windows filename and PowerShell invocation are exercised through an injected fake filesystem/executor, not real credentials or a PowerShell process. |
| `scripts/frontend/topics-home-ui.mjs:17,19` | Output/temp defaults only; both directories are created. Set `TOPICS_HOME_OUTPUT` and `TOPICS_HOME_TEMP` to absolute Linux directories. The script supports `--engine=chromium` to avoid requiring WebKit. |
| Most other `D:/Codex-artifacts/...` entries in frontend/browser tests | Screenshot/report destinations created with `mkdir`, not required input files. They can pollute the checkout with `D:` directories; use per-script output overrides where provided. Not a blanket blocker to `npm test`. |
| `scripts/frontend/search-feedback-guidance-20261024.mjs:15` | Conditional blocker: forces a Windows-shaped `TEMP`/`TMP` without creating that directory. On Linux, an existing absolute `TMPDIR` takes precedence; otherwise temporary browser directory creation may fail. Set `TMPDIR` to an existing absolute writable directory. |
| `scripts/frontend/review-startup-discovery-20261008.mjs:13` and `review-startup-public-ab-20261008.mjs:7` | Actual fresh-checkout blocker: unconditionally read an external `D:/BenchPoll-artifacts/.../private/home.html` baseline that is not in the project. |
| `scripts/frontend/review-profile-read-20261008.mjs:13,16` | Actual blocker for its default before/control mode: reads external baseline files. `--after --run=<id>` selects current checkout sources instead. |
| `scripts/frontend/navigation.mjs:13,166` | Only blocked when `NAVIGATION_REVIEW_BASELINE=1`, which routes requests to external baseline files. Leave unset for ordinary fixture testing. |
| `scripts/frontend/review-paging-progress-20261008.mjs:14,49,403` | Missing baseline reads are initially tolerated, but the before-control assertion requires the archived `home-workspace.js`; this historical comparison cannot be reproduced from a fresh checkout alone. |
| `scripts/frontend/review-startup-transport-20261008.mjs:110,112` | Actual platform/access blocker: invokes an absolute Windows `ssh.exe` and a workstation-specific private-key path against production. Excluded from this workflow; do not run it in Cloud. |
| `scripts/frontend/topics-home-vendor.mjs:13` | Not a blocker: explicitly selects `npm.cmd` on Windows and `npm` elsewhere. This vendor regeneration script needs network access, but is not part of setup. |

These are path/dependency findings, not a claim that every historical UI assertion
matches the current application. Browser executables and their Linux system
libraries must also be installed before any Playwright checks can run.

## Verification Record

Verified on 2026-11-01 with Node 22.22.1:

- Ubuntu/WSL x64: clean, isolated source copy without `.env`, credentials or Git
  metadata. `bash scripts/cloud/setup.sh` installed 172 pinned packages and built
  both home and index successfully. The original checkout's dependencies were
  not reinstalled.
- Ubuntu/WSL: all 9 bootstrap tests, all 51 existing `topics-home.test.mjs` and
  `ranking-pagination.test.mjs` tests, and the 2 fake-filesystem/PowerShell audit
  cases in `resend-setup.test.mjs` passed. This includes all-interface listening,
  port conflicts, startup outside the checkout, SIGTERM cleanup and Bash's
  fail-fast install behavior.
- Windows: 8 bootstrap tests passed with the Bash test skipped; the same 51
  existing tests and 2 mocked audit cases passed. Chromium smoke checks passed
  at 1440px and 390px for both source and built previews, with no external requests,
  HTTP failures or uncaught browser errors.
- Focused ESLint checks passed on both platforms. The existing D3 bundling test
  emits two import-is-undefined warnings but passes its runtime assertions.
- Final publication gate: a fresh LF Git-source archive was installed and built
  in isolated Ubuntu/WSL, with Chromium, WebKit and their system dependencies.
  All 3,249 tests ran to completion: 3,243 passed, zero failed, and 6 skipped
  (4 private historical audit cases and 2 existing opt-in cases). The only
  patches to that archive were the committed privacy-test cleanup and optional
  historical design-study expectation. No production snapshots were supplied.
- Git text files use LF across platforms to preserve shell behavior, source
  assertions and recorded asset hashes. When exporting an archive from an old
  Windows checkout, disable `core.autocrlf` for the export.
- Actual hosted Cloud port forwarding and production-backed services were not
  exercised. Local Linux verification does not prove cloud SSH connectivity.

## Handoff Boundary

This document covers only the credential-free developer runtime. Repository
publication, encrypted restoration and optional schema export are handled by the
separate handoff workflow. These scripts do not stage, commit, push, switch branches,
configure remotes, decrypt secrets or claim that the complete project is already
published. The receiving environment must contain the current application sources,
fixtures, public assets and matching `package-lock.json`, not just these new scripts.

## 2026-11-12 prelaunch redesign verification

The current prelaunch implementation and migration boundary are recorded in
[PRELAUNCH-REDESIGN-20261112.md](cloud/PRELAUNCH-REDESIGN-20261112.md).
This work used Node 24.22.1 and the lockfile, built both home/index bundles,
ran Chromium and WebKit previews, and tested new schemas/services against an
isolated MySQL 8.4 container. The selected Cloud environment had no production
credentials or VPN configuration. No production deployment or migration was run.
