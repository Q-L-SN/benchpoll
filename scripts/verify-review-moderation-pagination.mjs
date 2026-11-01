import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const writeReplay = process.argv.includes('--write-replay');
const output = process.argv.includes('--db-deadlines') ? 'artifacts/review-20261008/db-deadlines-deployment'
    : process.argv.includes('--transaction-cleanup') ? 'artifacts/review-20261008/transaction-cleanup-deployment'
    : process.argv.includes('--account-precision') ? 'artifacts/review-20261008/account-precision-deployment'
    : process.argv.includes('--moderation-replay') ? 'artifacts/review-20261008/moderation-replay-deployment'
    : writeReplay ? 'artifacts/review-20261008/write-replay-deployment'
    : process.argv.includes('--moderation-transactions')
    ? 'artifacts/review-20261008/moderation-transactions-deployment'
    : process.argv.includes('--moderation-intent')
    ? 'artifacts/review-20261008/moderation-intent-deployment'
    : 'artifacts/review-20261008/moderation-pagination-deployment';
const root = '/home/ubuntu/benchpoll';
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(`${output}/manifest.json`, 'utf8'));
const home = await fetch('https://benchpoll.com/Intelligence', { signal: AbortSignal.timeout(30000) });
assert.equal(home.status, 200);
const homeHTML = await home.text();
const censorHTML = await readFile('private/censor.html', 'utf8');
const assets = [
    ['public/js/home-workspace.js', homeHTML.match(/<script[^>]*src="(\/js\/home-workspace\.js\?[^\"]+)"/)?.[1]],
    ['public/js/censor.js', censorHTML.match(/<script[^>]*src="(\/js\/censor\.js\?[^\"]+)"/)?.[1]],
    ['public/css/censor.css', censorHTML.match(/href="(\/css\/censor\.css\?[^\"]+)"/)?.[1]]
];
if (writeReplay) {
    const contribution = await fetch('https://benchpoll.com/contribute', { signal: AbortSignal.timeout(30000) });
    assert.equal(contribution.status, 200);
    const html = await contribution.text();
    assets.push(['public/js/contribute.js', html.match(/<script[^>]*src="(\/js\/contribute\.js\?[^\"]+)"/)?.[1]]);
    for (const path of ['public/js/contribution/score-fields.js', 'public/js/shared/http.js', 'public/js/shared/write-intent.js']) {
        assets.push([path, `${path.replace(/^public/, '')}?v=write-replay-20261008`]);
    }
}
const checks = [{ page: '/Intelligence', status: home.status, cacheControl: home.headers.get('cache-control') }];
assert.match(home.headers.get('cache-control'), /no-cache|no-store/);
for (const [path, url] of assets) {
    assert.ok(url, `Actual asset URL for ${path}`);
    const response = await fetch(`https://benchpoll.com${url}`, { signal: AbortSignal.timeout(30000) });
    const expected = createHash('sha256').update(await readFile(path)).digest('hex');
    const actual = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    assert.equal(response.status, 200);
    assert.equal(actual, expected, path);
    assert.match(response.headers.get('cache-control'), /no-cache.*must-revalidate/);
    checks.push({ path, url, status: response.status, expected, actual,
        cacheControl: response.headers.get('cache-control'), edgeCache: response.headers.get('cf-cache-status') });
    console.log(`PASS ${path}`);
}
const capabilities = await fetch('https://benchpoll.com/api/admin_capabilities', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000)
});
assert.equal(capabilities.status, 401, 'Guest requests cannot read reviewer capabilities');
checks.push({ readOnlyAuthProbe: '/api/admin_capabilities', status: capabilities.status });
await writeFile(`${output}/public-assets.json`, JSON.stringify({ release: manifest.release, checks }, null, 2));

const routes = ['review_moderation_log', 'apply_moderation_log', 'preview_moderation_sql', 'escalate_moderation_log',
    'send_admin_message', 'mark_admin_message_read', 'resolve_score_sync_conflict', 'get_reported_discussion',
    'list_moderation_logs', 'admin_data_explorer', 'admin_data_record', 'list_admin_messages',
    'list_moderation_audit_logs', 'list_score_sync_conflicts', 'get_moderation_audit_log'];
const source = `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { requireAccountWriteOwner } from '${root}/public/js/shared/account-identity.js';
const manifest = ${JSON.stringify(manifest)};
const routes = ${JSON.stringify(routes)};
for (const file of manifest.files) {
    const bytes = await readFile('${root}/' + file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.after, file.path);
}
const server = await readFile('${root}/server.js', 'utf8');
for (const route of routes) {
    const line = server.slice(server.indexOf("API.post('/" + route + "'")).split('\\n', 1)[0];
    assert.match(line, /require(?:Reviewer|SeniorReviewer)AuthForAPI, requireAccountWriteOwner, async/, route);
}
const checks = [];
for (let run = 1; run <= 2; run++) for (const route of routes) {
    const body = { expectedUserID: '7', value: route };
    const req = { session: { userID: '7' }, body };
    let error;
    requireAccountWriteOwner(req, {}, value => { error = value; });
    assert.equal(error, undefined);
    assert.deepEqual(req.body, { value: route });
    assert.equal(body.expectedUserID, '7');
    const foreign = { session: { userID: '8' }, body };
    requireAccountWriteOwner(foreign, {}, value => { error = value; });
    assert.equal(error.status, 409);
    assert.equal(error.body.error, 'account_changed');
    checks.push({ route, run, normalAccepted: true, foreignRejected: true, transportMetadataRemoved: true });
}
const services = execFileSync('systemctl', ['is-active', 'benchpoll.service', 'nginx'], { encoding: 'utf8' }).trim().split('\\n');
assert.deepEqual(services, ['active', 'active']);
console.log(JSON.stringify({ release: manifest.release, installedHashes: manifest.files.length,
    protectedRegistrations: routes.length, checks, services,
    productionHandlersExecuted: false, databaseAccess: false, sessionAccess: false }));
`;
const result = execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', ['-i',
    'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
    'ubuntu@18.226.222.18', 'node --input-type=module'], { input: source, encoding: 'utf8', timeout: 90000 });
const deployed = JSON.parse(result);
await writeFile(`${output}/deployed-guards.json`, JSON.stringify(deployed, null, 2));
console.log(`PASS ${deployed.installedHashes} installed hashes, ${deployed.protectedRegistrations} guard registrations and ${deployed.checks.length} pure guard checks`);
