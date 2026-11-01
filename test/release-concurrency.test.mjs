import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const harness = String.raw`
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
const scenario = JSON.parse(process.env.RELEASE_FIXTURE);
const source = await readFile(process.env.RELEASE_SOURCE, 'utf8');
const root = '/home/ubuntu/benchpoll', release = 'launch-20261008-1';
const target = scenario.newFile ? 'public/js/new-file.js' : 'server.js';
const path = root + '/' + target, stage = '/stage/' + target;
const old = Buffer.from('original bytes'), candidate = Buffer.from('candidate bytes'), foreign = Buffer.from('another task bytes');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { release, files: [{ path: target, before: scenario.newFile ? null : sha(old), after: sha(candidate) }] };
const files = new Map([['/stage/manifest.json', Buffer.from(JSON.stringify(manifest))], [stage, candidate]]);
if (!scenario.newFile) files.set(path, old);
let restarts = 0, observed, backupCopies = 0;
const output = [], events = [];
const key = name => name.startsWith('/') ? name : '/stage/' + name;
const missing = name => Object.assign(new Error('Missing fixture file: ' + name), { code: 'ENOENT' });
const fs = {
    async readFile(name, encoding) { const bytes = files.get(key(name)); if (!bytes) throw missing(name); return encoding ? bytes.toString(encoding) : bytes; },
    async access() { assert.fail('Destination preflight belongs only to the account release scope'); },
    async mkdir() {}, async writeFile(name, content) { files.set(key(name), Buffer.from(content)); },
    async copyFile(from, to) {
        const bytes = files.get(key(from)); if (!bytes) throw missing(from); files.set(key(to), bytes);
        if (key(to).startsWith('/home/ubuntu/benchpoll-code-backups/')) {
            backupCopies++;
            if (scenario.beforeInstall) files.set(path, foreign);
        }
    },
    async rename(from, to) { const bytes = files.get(key(from)); if (!bytes) throw missing(from); files.set(key(to), bytes); files.delete(key(from)); events.push(['rename',key(to)]); },
    async stat() { return { mode: 33188 }; }, async chmod() {},
    async unlink(name) { if (!files.has(key(name))) throw missing(name); files.delete(key(name)); events.push(['unlink',key(name)]); }
};
const imports = {
    './search-legal-paths-20261101.mjs': await import(new URL('./search-legal-paths-20261101.mjs', pathToFileURL(process.env.RELEASE_SOURCE))),
    'node:fs/promises': fs, 'node:path': posix, 'node:crypto': { createHash },
    'node:child_process': { execFileSync(executable, args) {
        assert.ok(executable === 'systemctl' || executable === 'sudo' || executable === '/usr/bin/node');
        if (args.includes('restart')) restarts++;
    } },
    'node:timers/promises': { async setTimeout() {} },
    'node:https': { request(_url, _options, callback) {
        const request = new EventEmitter();
        request.destroy = error => request.emit('error', error);
        request.end = () => queueMicrotask(() => {
            if (scenario.duringHealth === 'write') files.set(path, foreign);
            if (scenario.duringHealth === 'delete') files.delete(path);
            const response = new EventEmitter(); response.setEncoding = () => {};
            response.statusCode = scenario.healthFails ? 503 : 200;
            callback(response); response.emit('data', 'BenchPoll'); response.emit('end');
        });
        return request;
    } }
};
const context = createContext({ process: { cwd: () => '/stage' }, console: { log(value) { output.push(value); } } });
const module = new SourceTextModule(source, { context });
await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier));
    const entries = Object.entries(imports[specifier]);
    return new SyntheticModule(entries.map(([name]) => name), function () { for (const [name, value] of entries) this.setExport(name, value); }, { context });
});
await module.evaluate().catch(error => { observed = error; });
if (scenario.beforeInstall || scenario.duringHealth) {
    assert.ok(observed, 'Concurrent change must stop this release');
    if (scenario.duringHealth === 'delete') assert.equal(files.has(path), false, 'Another task deletion must not be reverted');
    else assert.equal(sha(files.get(path)), sha(foreign), 'Another task bytes must not be replaced by rollback');
    assert.equal(restarts, scenario.beforeInstall || scenario.newFile ? 0 : 1, 'Do not restart for an untouched/replaced foreign deployment');
} else if (scenario.healthFails) {
    assert.ok(observed); assert.equal(scenario.newFile ? files.has(path) : sha(files.get(path)), scenario.newFile ? false : sha(old));
    assert.equal(restarts, scenario.newFile ? 0 : 2);
} else {
    assert.equal(observed, undefined); assert.equal(sha(files.get(path)), sha(candidate));
    assert.equal(JSON.parse(output[0]).healthy, true); assert.equal(restarts, scenario.newFile ? 0 : 1);
}
if (!scenario.newFile) assert.equal(backupCopies, 1);
console.log(JSON.stringify({ scenario, passed: true, restarts, applicationIO: 'isolated' }));
`;

const source = process.env.BENCHPOLL_RELEASE_BASELINE || fileURLToPath(new URL('../ops/launch-release.mjs', import.meta.url));
const scenarios = [
    { name: 'normal server install' },
    { name: 'normal new-file install', newFile: true },
    { name: 'owned server is restored on failed health', healthFails: true },
    { name: 'owned new file is removed on failed health', newFile: true, healthFails: true },
    { name: 'a change after backup is preserved before installation', beforeInstall: true },
    { name: 'a foreign server is preserved after failed health', duringHealth: 'write', healthFails: true },
    { name: 'a foreign new file is preserved after failed health', newFile: true, duringHealth: 'write', healthFails: true },
    { name: 'another task deletion is preserved', duringHealth: 'delete', healthFails: true },
    { name: 'a foreign server after successful health is preserved', duringHealth: 'write' }
];
for (const scenario of scenarios) test(`release concurrency: ${scenario.name}, twice`, () => {
    for (let repetition = 0; repetition < 2; repetition++) {
        const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', harness], {
            encoding: 'utf8', timeout: 15000, windowsHide: true,
            env: { ...process.env, RELEASE_FIXTURE: JSON.stringify(scenario), RELEASE_SOURCE: source }
        });
        assert.equal(result.error, undefined); assert.equal(result.status, 0, (result.stdout ?? '') + (result.stderr ?? ''));
    }
});
