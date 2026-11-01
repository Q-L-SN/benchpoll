import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { requireAccountWriteOwner } from '/home/ubuntu/benchpoll/public/js/shared/account-identity.js';

const path = process.argv.find(value => value.startsWith('--manifest='))?.slice(11);
assert.match(path ?? '', /^\/tmp\/launch-20261008-[0-9]+\/manifest\.json$/);
const manifest = JSON.parse(await readFile(path, 'utf8'));
const hashes = [];
for (const file of [...manifest.files, ...manifest.protectedFiles]) {
    assert.match(file.path, /^(?:[a-zA-Z0-9-]+\.js|(?:public|private)\/[a-zA-Z0-9_./-]+)$/);
    assert.ok(!file.path.split('/').includes('..'));
    const actual = createHash('sha256').update(await readFile(`/home/ubuntu/benchpoll/${file.path}`)).digest('hex');
    assert.equal(actual, file.after ?? file.hash, file.path);
    hashes.push({ path: file.path, hash: actual, changed: Object.hasOwn(file, 'after') });
}
const source = await readFile('/home/ubuntu/benchpoll/server.js', 'utf8');
const registrations = [...source.matchAll(/API\.post\('(\/[^']+)',[^\n]*\brequireAccountWriteOwner\b/g)].map(match => match[1]);
assert.deepEqual(registrations, manifest.protectedRegistrations);
const checks = [];
for (let repetition = 1; repetition <= 2; repetition++) for (const ID of ['7', '9007199254740993', '18446744073709551615']) {
    const body = { expectedUserID: ID, value: 'Fixture only' };
    const req = { session: { userID: ID }, body };
    let error;
    requireAccountWriteOwner(req, {}, value => { error = value; });
    assert.equal(error, undefined);
    assert.deepEqual(req.body, { value: 'Fixture only' });
    assert.equal(body.expectedUserID, ID);
    const foreign = { session: { userID: '8' }, body };
    requireAccountWriteOwner(foreign, {}, value => { error = value; });
    assert.equal(error.status, 409); assert.equal(error.body.error, 'account_changed');
    assert.equal(foreign.body, body);
    checks.push({ repetition, identity: ID, matchedAccepted: true, foreignRejected: true });
}
const services = execFileSync('systemctl', ['is-active', 'benchpoll.service', 'nginx'], { encoding: 'utf8' }).trim().split('\n');
assert.deepEqual(services, ['active', 'active']);
console.log(JSON.stringify({ release: manifest.release, installedHashes: manifest.files.length,
    protectedHashes: manifest.protectedFiles.length, protectedRegistrations: registrations.length, hashes, checks, services,
    databaseAccess: false, sourceRegistrationsChanged: false, actualOAuth: false, actualEmailDelivery: false }));
