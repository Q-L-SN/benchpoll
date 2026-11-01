import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const output = process.argv.find(value => value.startsWith('--output='))?.slice(9)
    ?? 'artifacts/review-20261008/remaining-account-deployment';
await mkdir(output, { recursive: true });

const names = [
    ['public/js/shared/account-identity.js', '/js/shared/account-identity.js'],
    ['public/js/contribution/score-fields.js', '/js/contribution/score-fields.js?v=score-field-controls-20261008'],
    ['public/js/contribute.js', '/js/contribute.js?v=launch-20261007'],
    ['public/js/discussion.js', '/js/discussion.js?v=model-name-translation-20261006'],
    ['public/js/navigation/sidebar.js', '/js/navigation/sidebar.js?v=comparison-experiment-20261007'],
    ['public/js/home.js', '/js/home.js?v=comparison-experiment-20261007']
];
const results = [];
for (const [path, url] of names) {
    const response = await fetch(`https://benchpoll.com${url}`, { signal: AbortSignal.timeout(30000) });
    const expected = createHash('sha256').update(await readFile(path)).digest('hex');
    const actual = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    const record = { path, url, status: response.status, expected, actual,
        cacheControl: response.headers.get('cache-control'), edgeCache: response.headers.get('cf-cache-status') };
    results.push(record);
    assert.equal(response.status, 200);
    assert.equal(actual, expected, path);
    assert.match(record.cacheControl, /no-cache.*must-revalidate/);
    console.log(`PASS ${path}`);
}
const post = async (path, body) => fetch(`https://benchpoll.com/api/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000)
});
const tree = await post('get_page/Intelligence', { treeOnly: true });
assert.equal(tree.status, 200);
const context = await tree.json();
const discussion = await post('get_discussion', { categoryID: context.currentCategoryID, contextValues: {} });
assert.equal(discussion.status, 200);
const data = await discussion.json();
assert.equal(data.authenticated, false);
assert.equal(data.userID, null);
assert.match(discussion.headers.get('cache-control'), /private.*no-store/);
results.push({ readOnlyAPI: '/api/get_discussion', status: discussion.status,
    authenticated: data.authenticated, userID: data.userID, cacheControl: discussion.headers.get('cache-control') });
await writeFile(`${output}/public-assets.json`, JSON.stringify(results, null, 2));
console.log('PASS guest discussion identity and private no-store response');

if (process.argv.includes('--transport')) {
    const source = `
import assert from 'node:assert/strict';
import { requireAccountWriteOwner } from '/home/ubuntu/benchpoll/public/js/shared/account-identity.js';
import { normalizeDiscussionPost, normalizeDiscussionDeletion } from '/home/ubuntu/benchpoll/discussion-service.js';
import { normalizePrivateCategoryRequest } from '/home/ubuntu/benchpoll/private-category-service.js';
const checks = [];
for (let run = 1; run <= 2; run++) {
    for (const [kind, input, validate, unknownField] of [
        ['post', { text: 'Transport validation only', mentions: [] }, normalizeDiscussionPost, 'approved'],
        ['delete', { postID: 7 }, normalizeDiscussionDeletion, 'authorID'],
        ['private-category', { name: 'Transport validation only' }, normalizePrivateCategoryRequest, 'owner_user_ID']
    ]) {
        const original = { ...input, expectedUserID: '7' };
        const req = { session: { userID: '7' }, body: original };
        let error;
        requireAccountWriteOwner(req, {}, value => { error = value; });
        assert.equal(error, undefined);
        assert.equal(original.expectedUserID, '7');
        assert.equal(Object.hasOwn(req.body, 'expectedUserID'), false);
        validate(req.body);
        assert.throws(() => validate({ ...req.body, [unknownField]: '7' }), value => value.status === 400);
        const foreign = { session: { userID: '8' }, body: original };
        requireAccountWriteOwner(foreign, {}, value => { error = value; });
        assert.equal(error.status, 409);
        assert.equal(error.body.error, 'account_changed');
        assert.equal(foreign.body, original);
        checks.push({ kind, run, normalAccepted: true, foreignRejected: true, strictBusinessFields: true });
    }
}
console.log(JSON.stringify({ checks, databaseAccess: false, sessionAccess: false }));
`;
    const result = execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', ['-i',
        'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
        'ubuntu@18.226.222.18', 'node --input-type=module'],
    { input: source, encoding: 'utf8', timeout: 90000 });
    const transport = JSON.parse(result);
    await writeFile(`${output}/deployed-transport.json`, JSON.stringify(transport, null, 2));
    console.log(`PASS ${transport.checks.length} deployed strict transport checks without database or session access`);
}
