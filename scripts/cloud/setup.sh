#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

node --input-type=module - <<'NODE'
const [major, minor] = process.versions.node.split('.').map(Number);
// Intersection of the pinned undici and ESLint engine requirements.
if (!(major === 22 && minor >= 19) && major < 24) {
    console.error(`Unsupported Node.js ${process.versions.node}. Use Node 22.19+ (22.x) or Node 24+.`);
    process.exit(1);
}
NODE

npm ci --include=dev --include=optional --engine-strict --no-audit --no-fund
npm run build:home
npm run build:home -- --index

printf '%s\n' 'Ready. Start the fixture preview with: node scripts/cloud/preview.mjs'
