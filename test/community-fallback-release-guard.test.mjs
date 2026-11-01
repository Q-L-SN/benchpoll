import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const applySource = fileURLToPath(new URL('../ops/community-fallback-apply-20261030.mjs', import.meta.url));
const stageSource = fileURLToPath(new URL('../ops/flat-topics-stage-20261022.mjs', import.meta.url));

// Run the actual helpers with an import allowlist. No application imports, DB, network, or OS service I/O.
const harness = String.raw`
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readFile as readSource } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { posix } from 'node:path';
import { EventEmitter } from 'node:events';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
const scenario = JSON.parse(process.env.COMMUNITY_RELEASE_SCENARIO);
const source = await readSource(process.env.COMMUNITY_RELEASE_SOURCE, 'utf8');
const root = '/home/ubuntu/benchpoll', family = scenario.family || 'community-fallback-20261030';
const release = family + '-123', stage = root + '/scripts/' + family + '/' + release;
const candidate = stage + '/candidate', payload = stage + '/payload', backup = '/home/ubuntu/benchpoll-code-backups/' + release;
const lock = root + '/scripts/.community-fallback-release.lock';
const migration = 'scripts/migrate-community-fallback-20261030.mjs';
const dependency = 'scripts/migrate-topic-slugs-20261023.mjs';
const deletions = ['benchmark-version-preferences.js', 'public/js/workspace/version-group-dialog.js'];
const sha = value => createHash('sha256').update(value).digest('hex');
const old = Buffer.from('original source'), next = Buffer.from('replacement source'), foreign = Buffer.from('concurrent source');
const files = new Map(), directories = new Set(['/']), links = new Map(), modes = new Map(), reads = new Set();
const events = [], output = [];
const parents = name => { let parent = posix.dirname(name); while (!directories.has(parent)) { directories.add(parent); parent = posix.dirname(parent); } };
const put = (name, value, mode = 0o100644) => { parents(name); files.set(name, Buffer.from(value)); modes.set(name, mode); };
const missing = name => Object.assign(new Error('Missing fixture path: ' + name), { code: 'ENOENT' });
const exists = name => files.has(name) || directories.has(name) || links.has(name);
const bytes = name => { if (!files.has(name)) throw missing(name); return files.get(name); };
const entry = (path, before = old, after = next) => ({ path, before: before === null ? null : sha(before),
    after: after === null ? null : sha(after), ...(before === null ? {} : { mode: 0o100644 }) });
let entries = [entry('server.js'), ...deletions.map(path => entry(path, old, null)),
    entry(migration, null), entry('public/js/new.js', null)];
if (scenario.family) entries = [entry('public/js/topics-home.js')];
if (scenario.extraPath) entries.push(entry(scenario.extraPath, null));
if (scenario.legacyDeletion) entries.push(entry(deletions[0], old, null));
let guards = [dependency, 'scripts/build-home-assets.mjs', 'package.json', 'public/js/shared/topics.js',
    'ranking-read-cache.js', 'eslint.config.js', 'public/vendor/fontawesome/css/all.min.css'].map(path => ({ path, before: sha(old) }));
const manifest = { release, migration: scenario.family ? (scenario.family === 'audit-fixes-20261030'
    ? 'migrate-topic-proposal-reservations-20261029.mjs' : null) : migration.slice(8), candidate, backup, files: entries, sources: guards };
for (const file of entries) {
    if (file.before !== null) { put(root + '/' + file.path, old); put(stage + '/baseline/' + file.path, old); }
    if (file.after !== null) put(payload + '/' + file.path, next);
    if (!scenario.stageMode) {
        if (file.after !== null) put(candidate + '/' + file.path, next);
        if (file.before !== null) put(backup + '/' + file.path, old);
    }
}
for (const guard of guards) { put(root + '/' + guard.path, old); if (!scenario.stageMode) put(candidate + '/' + guard.path, old); }
put(root + '/scripts/migrate-topic-proposals-20261027.mjs', old);
for (const name of ['private/home.html', 'private/index.html']) put(root + '/' + name, old);
parents(backup); parents(lock); parents(stage + '/placeholder');
const databasePath = stage + '/database-123.sql.gz', databaseManifestPath = stage + '/database-backup.json';
const databaseBytes = Buffer.alloc(1200, 42);
const databaseBackup = { database: 'benchmarks', path: databasePath, bytes: databaseBytes.length, sha256: sha(databaseBytes), createdAt: new Date().toISOString() };
put(databasePath, databaseBytes, 0o100600);
const invalid = scenario.invalid;
switch (invalid) {
    case 'release': manifest.release = 'community-fallback-20261030-other'; break;
    case 'candidate-path': manifest.candidate = root; break;
    case 'backup-path': manifest.backup = root; break;
    case 'migration': manifest.migration = 'migrate-topic-slugs-20261023.mjs'; break;
    case 'duplicate-files': entries.push({ ...entries[0] }); break;
    case 'duplicate-sources': guards.push({ ...guards[0] }); break;
    case 'source-overlap': guards.push({ path: entries[0].path, before: entries[0].before }); break;
    case 'missing-migration': entries.splice(entries.findIndex(file => file.path === migration), 1); break;
    case 'missing-deletion': entries.splice(entries.findIndex(file => file.path === deletions[1]), 1); break;
    case 'replace-deletion': entries.find(file => file.path === deletions[1]).after = sha(next); break;
    case 'unknown-deletion': entries.push(entry('public/js/other.js', old, null)); break;
    case 'deletion-without-before': entries.find(file => file.path === deletions[0]).before = null; break;
    case 'bad-before': entries[0].before = false; break;
    case 'missing-before': delete entries[0].before; break;
    case 'bad-after': entries[0].after = 'bad'; break;
    case 'unsafe-mode': entries[0].mode = 0o104755; break;
    case 'missing-source': guards.splice(0, 1); break;
    case 'unsafe-source': guards.push({ path: 'scripts/../.env', before: sha(old) }); break;
    case 'bad-source-hash': guards[0].before = null; break;
    case 'unknown-manifest-field': manifest.restoreDatabase = true; break;
    case 'stale-backup': databaseBackup.createdAt = new Date(Date.now() - 7200001).toISOString(); break;
    case 'future-backup': databaseBackup.createdAt = new Date(Date.now() + 60000).toISOString(); break;
    case 'wrong-database': databaseBackup.database = 'other_database'; break;
    case 'outside-dump': databaseBackup.path = '/tmp/database-123.sql.gz'; break;
    case 'dump-traversal': databaseBackup.path = stage + '/database-../dump.sql.gz'; break;
    case 'short-dump': databaseBackup.bytes = 100; break;
    case 'dump-size': databaseBackup.bytes++; break;
    case 'dump-hash': databaseBackup.sha256 = sha('bad'); break;
    case 'dump-permissions': modes.set(databasePath, 0o100644); break;
    case 'payload-mismatch': put(payload + '/server.js', foreign); break;
    case 'candidate-mismatch': put(candidate + '/server.js', foreign); break;
    case 'source-mismatch': put(root + '/' + dependency, foreign); break;
    case 'candidate-source-mismatch': put(candidate + '/' + dependency, foreign); break;
    case 'production-mismatch': put(root + '/server.js', foreign); break;
    case 'production-permissions': modes.set(root + '/server.js', 0o100600); break;
    case 'code-backup-mismatch': put(backup + '/' + deletions[0], foreign); break;
    case 'deletion-payload': put(payload + '/' + deletions[0], old); break;
    case 'candidate-deletion': put(candidate + '/' + deletions[0], old); break;
    case 'payload-symlink': links.set(payload + '/server.js', '/outside'); break;
    case 'parent-symlink': links.set(root + '/public/js', '/outside'); break;
    case 'dump-symlink': links.set(databasePath, '/outside'); break;
    case 'deletion-dangling-link': links.set(payload + '/' + deletions[0], '/absent'); break;
    case 'deletion-directory': directories.add(payload + '/' + deletions[0]); break;
    case 'old-attempt': put(stage + '/database-apply-started.json', '{}', 0o100600); break;
    case 'busy-lock': directories.add(lock); break;
    case 'missing-live-deletion': files.delete(root + '/' + deletions[0]); break;
    case 'changed-live-deletion': put(root + '/' + deletions[0], foreign); break;
    case 'existing-candidate': directories.add(candidate); break;
    case 'existing-backup': directories.add(backup); break;
}
put(databaseManifestPath, JSON.stringify(databaseBackup), invalid === 'backup-manifest-permissions' ? 0o100644 : 0o100600);
const manifestBytes = JSON.stringify(manifest, null, 2);
if (!scenario.stageMode) {
    put(stage + '/manifest.json', manifestBytes);
    put(backup + '/manifest.json', invalid === 'backup-manifest-copy' ? '{}' : manifestBytes);
}
if (scenario.stageMode) {
    const requestFiles = entries.map(file => ({ path: file.path, baseline: file.before, after: file.after }));
    put(stage + '/request.json', JSON.stringify({ migration: manifest.migration, files: requestFiles }));
    if (scenario.stageMode === 'prepare') put(stage + '/capture.json', JSON.stringify({ files: entries }));
    else {
        for (const name of [...files.keys()]) if (name.startsWith(stage + '/baseline/')) files.delete(name);
        for (const name of [...directories]) if (name.startsWith(stage + '/baseline')) directories.delete(name);
    }
}
let active = true, stops = 0, schemaChecks = 0, failedInstall = false;
const mutate = when => {
    if (scenario.concurrentAt === when) put(root + '/' + (scenario.concurrentPath || 'server.js'), foreign);
    if (when === 'after-stop' && scenario.backupChangesAfterStop) put(databasePath, Buffer.alloc(1200, 12), 0o100600);
};
function info(name) {
    if (!exists(name)) throw missing(name);
    return { size: files.get(name)?.length || 0, mode: modes.get(name) || (directories.has(name) ? 0o40755 : 0o100644),
        nlink: invalid === 'hardlink' && name === payload + '/server.js' ? 2 : 1,
        isSymbolicLink: () => links.has(name), isDirectory: () => directories.has(name), isFile: () => files.has(name) };
}
const fs = {
    async readFile(name, encoding) { assert.ok(!name.endsWith('/.env'), 'Never read private environment files'); reads.add(name); const value = bytes(name); return encoding ? value.toString(encoding) : value; },
    async lstat(name) { return info(name); }, async stat(name) { return info(name); },
    async access(_name, mode) { assert.equal(mode, constants.W_OK); if (invalid === 'unwritable') throw Object.assign(new Error('Not writable'), { code: 'EACCES' }); },
    async mkdir(name, options = {}) {
        if (exists(name) && !options.recursive) throw Object.assign(new Error('Already exists: ' + name), { code: 'EEXIST' });
        if (options.recursive) parents(name);
        else if (!directories.has(posix.dirname(name))) throw missing(posix.dirname(name));
        directories.add(name);
    },
    async writeFile(name, value, options = {}) {
        if (options.flag === 'wx' && exists(name)) throw Object.assign(new Error('Already exists'), { code: 'EEXIST' });
        if (scenario.failRecord && name === stage + '/' + scenario.failRecord) throw new Error('Mock record write failed');
        put(name, value, options.mode ? 0o100000 | options.mode : 0o100644); events.push({ type: 'record', path: name });
    },
    async copyFile(from, to, flags) {
        if (flags === constants.COPYFILE_EXCL && exists(to)) throw Object.assign(new Error('Temporary path occupied'), { code: 'EEXIST' });
        if (scenario.failInstall && !failedInstall && from === payload + '/public/js/new.js' && to.endsWith('.tmp')) {
            failedInstall = true; throw new Error('Mock install failed');
        }
        put(to, bytes(from), modes.get(from));
        if (to.endsWith('.tmp') && from === payload + '/server.js') mutate('before-replace');
        if (scenario.stageMode && scenario.candidateCopyRace && to === candidate + '/ranking-read-cache.js') put(root + '/ranking-read-cache.js', foreign);
        if (scenario.stageMode && scenario.backupCopyRace && to === backup + '/server.js') put(root + '/server.js', foreign);
    },
    async chmod(name, mode) { bytes(name); modes.set(name, 0o100000 | mode); },
    async rename(from, to) {
        put(to, bytes(from), modes.get(from)); files.delete(from); modes.delete(from);
        events.push({ type: 'install', path: to });
        if (to === root + '/public/js/new.js') mutate('after-install');
    },
    async unlink(name) { bytes(name); files.delete(name); modes.delete(name); events.push({ type: 'delete', path: name }); },
    async rmdir(name) { assert.ok(directories.delete(name)); },
    async readdir(name) { return [...new Set([...files.keys(), ...directories].filter(path => path.startsWith(name + '/'))
        .map(path => path.slice(name.length + 1).split('/')[0]))]; },
    async cp(from, to) { for (const [name, value] of [...files]) if (name.startsWith(from + '/')) put(to + name.slice(from.length), value, modes.get(name)); },
    async symlink(target, name) { if (exists(name)) throw Object.assign(new Error('Already linked'), { code: 'EEXIST' }); links.set(name, target); },
    async readlink(name) { assert.ok(links.has(name)); return links.get(name); }
};
const child = { execFileSync(executable, args, options = {}) {
    assert.ok(['/usr/bin/node', 'systemctl', 'sudo', 'tar'].includes(executable), 'Unexpected external command');
    if (executable === 'tar') { assert.ok(scenario.stageMode); return Buffer.alloc(0); }
    if (executable === '/usr/bin/node') {
        if (args[0] === '--check') { bytes(args[1]); events.push({ type: 'syntax', path: args[1] }); return ''; }
        assert.equal(args[0], root + '/' + migration);
        assert.equal(options.cwd, root); assert.equal(options.env.DOTENV_CONFIG_PATH, '/dev/null');
        assert.deepEqual(Array.from(options.stdio), ['ignore', 'pipe', 'pipe']);
        assert.equal(options.env.NODE_OPTIONS, undefined);
        assert.equal(options.env.DOTENV_KEY, undefined); assert.equal(options.env.DOTENV_CONFIG_DOTENV_KEY, undefined);
        assert.equal(options.env.BENCHPOLL_DB_NAME, 'benchmarks'); assert.equal(options.env.BENCHPOLL_DB_USER, 'fixture_user');
        assert.equal(options.env.BENCHPOLL_DB_PASSWORD, 'SENSITIVE_ENV'); assert.equal(options.env.DB_PASSWORD, 'SENSITIVE_ENV');
        const apply = args.includes('--apply');
        const phase = apply ? 'migration' : ++schemaChecks === 1 ? 'schema-before' : 'schema-after';
        events.push({ type: 'phase', phase });
        if (apply) {
            assert.equal(active, false, 'App writes must be stopped');
            assert.ok(args.includes('--writes-stopped')); assert.ok(args.includes('--backup-manifest=' + databaseManifestPath));
            assert.ok(files.has(stage + '/database-apply-started.json'), 'Persist the DB recovery boundary before SQL');
            for (const file of entries) assert.equal(files.has(root + '/' + file.path) ? sha(bytes(root + '/' + file.path)) : null, file.after);
        }
        if (scenario.failPhase === phase) throw new Error('password=SENSITIVE_CHILD_DIAGNOSTIC');
        if (scenario.invalidMigrationJSON && apply) return 'password=SENSITIVE_CHILD_DIAGNOSTIC';
        return JSON.stringify({ migration: scenario.wrongMarker ? 'other' : 'community_fallback_20261030',
            ready: !scenario.notReady, resetApplied: true, explicitNoneReady: true, concreteVersionsOnly: true,
            ...(apply ? { applied: !scenario.alreadyMigrated, protectedDataUnchanged: !scenario.protectedDataChanged } : {}) });
    }
    assert.equal(args.at(-1) === 'benchpoll.service' || args.includes('show') && args[1] === 'benchpoll.service', true);
    assert.ok(!args.some(arg => /score-sync|timer/.test(arg)), 'Do not touch score-sync scheduling');
    const action = args.find(arg => ['show', 'stop', 'start'].includes(arg)); assert.ok(action);
    events.push({ type: 'unit', action });
    if (action === 'show') {
        return 'LoadState=' + (invalid === 'unloaded-service' ? 'not-found' : 'loaded') + '\nActiveState=' + (active ? 'active' : 'inactive')
            + '\nSubState=' + (active ? 'running' : 'dead') + '\nMainPID=' + (active ? '123' : '0')
            + '\nControlPID=' + (scenario.stopHasWriter && !active ? '42' : '0') + '\nJob=\n';
    }
    if (action === 'stop') {
        stops++;
        if (scenario.stopFails || scenario.maintenanceStopFails && stops > 1) throw new Error('Mock stop failure');
        if (!scenario.stopNoEffect) active = false;
        if (stops === 1) mutate('after-stop');
        if (stops > 1 && scenario.corruptRollbackBackup) put(backup + '/server.js', foreign);
    }
    if (action === 'start') {
        active = true;
        if (scenario.failPhase === 'start') throw new Error('Mock start failure');
    }
    return '';
} };
const imports = {
    './search-legal-paths-20261101.mjs': await import(new URL('./search-legal-paths-20261101.mjs', pathToFileURL(process.env.COMMUNITY_RELEASE_SOURCE))),
    'node:fs/promises': fs, 'node:path': posix, 'node:crypto': { createHash }, 'node:child_process': child,
    'node:fs': { constants, createReadStream(name) { return { async *[Symbol.asyncIterator]() {
        events.push({ type: 'backup-hash' }); yield bytes(name);
    } }; } },
    'node:timers/promises': { async setTimeout() {} },
    'node:https': { request(url, options, callback) {
        assert.equal(url, 'https://127.0.0.1:1337/'); assert.equal(options.headers.Host, 'benchpoll.com'); assert.equal(active, true);
        events.push({ type: 'health' }); mutate('health');
        const req = new EventEmitter(); req.destroy = error => req.emit('error', error);
        req.end = () => queueMicrotask(() => {
            const res = new EventEmitter(); res.setEncoding = () => {}; res.statusCode = scenario.failPhase === 'health' ? 503 : 200;
            callback(res); res.emit('data', 'BenchPoll topics-grid ' + (scenario.missingNavigation ? '' : 'topics-navigation')); res.emit('end');
        }); return req;
    } }
};
const argv = ['node', 'helper', invalid === 'stage-path' ? root + '/scripts/' + family + '/../' + release : stage];
if (scenario.stageMode) argv.push(scenario.stageMode);
else argv.push('--apply', '--manifest-sha256=' + (invalid === 'manifest-pin' ? sha('bad') : sha(manifestBytes)),
    '--backup-manifest=' + (invalid === 'backup-argument' ? '/tmp/database-backup.json' : databaseManifestPath),
    '--backup-manifest-sha256=' + (invalid === 'backup-pin' ? sha('bad') : sha(bytes(databaseManifestPath))));
if (invalid === 'missing-apply') argv.splice(argv.indexOf('--apply'), 1);
if (invalid === 'unknown-argument') argv.push('--force');
if (invalid === 'duplicate-argument') argv.push('--apply');
const context = createContext({ Buffer, URL, queueMicrotask,
    process: { argv, cwd: () => stage, env: { BENCHPOLL_DB_USER: 'fixture_user', BENCHPOLL_DB_PASSWORD: 'SENSITIVE_ENV',
        DB_PASSWORD: 'SENSITIVE_ENV', NODE_OPTIONS: '--bad-preload', DOTENV_KEY: 'ignored-vault', DOTENV_CONFIG_DOTENV_KEY: 'ignored-vault' } },
    console: { log(value) { output.push(String(value)); }, error(value) { output.push(String(value)); } } });
const buildHomeAssets = async (_candidate, options = {}) => {
    const page = options.pageName || 'home';
    const generated = ['public/build/' + page + '-fixture.js', 'private/' + page + '-built.html'];
    for (const name of [...generated, 'private/' + page + '-assets.json']) put(candidate + '/' + name, 'generated ' + name);
    return { files: generated, sources: ['public/js/shared/topics.js', 'public/vendor/fontawesome/css/all.min.css']
        .map(path => ({ path, sha256: sha(old) })) };
};
const module = new SourceTextModule(source, { context, identifier: 'isolated-community-release',
    importModuleDynamically: async specifier => {
        assert.ok(scenario.stageMode); assert.equal(specifier, stage + '/build-tools/build-home-assets.mjs');
        const builder = new SyntheticModule(['buildHomeAssets'], function () { this.setExport('buildHomeAssets', buildHomeAssets); }, { context });
        await builder.link(() => assert.fail('No dynamic dependency permitted')); await builder.evaluate(); return builder;
    } });
const link = specifier => {
    assert.ok(Object.hasOwn(imports, specifier), 'Unmocked import: ' + specifier);
    const exports = Object.entries(imports[specifier]);
    return new SyntheticModule(exports.map(([name]) => name), function () { for (const [name, value] of exports) this.setExport(name, value); }, { context });
};
await module.link(link);
let error = null;
try { await module.evaluate({ timeout: 4000 }); } catch (failure) { error = failure.message; }
if (!error && scenario.stageThenApply) {
    argv.splice(2, argv.length, stage, '--apply', '--manifest-sha256=' + sha(bytes(stage + '/manifest.json')),
        '--backup-manifest=' + databaseManifestPath, '--backup-manifest-sha256=' + sha(bytes(databaseManifestPath)));
    const apply = new SourceTextModule(await readSource(process.env.COMMUNITY_APPLY_SOURCE, 'utf8'), { context });
    await apply.link(link);
    try { await apply.evaluate({ timeout: 4000 }); } catch (failure) { error = failure.message; }
}
const json = name => files.has(name) ? JSON.parse(bytes(name).toString('utf8')) : null;
const state = (base, path) => files.has(base + '/' + path) ? sha(bytes(base + '/' + path)) : null;
console.log(JSON.stringify({ error, events, output, active, lockRetained: directories.has(lock),
    server: state(root, 'server.js'), old: sha(old), next: sha(next), foreign: sha(foreign),
    newAsset: state(root, 'public/js/new.js'), migration: state(root, migration),
    deleted: deletions.map(path => state(root, path)), candidateDeleted: deletions.map(path => state(candidate, path)),
    backups: deletions.map(path => state(backup, path)), baseline: deletions.map(path => state(stage + '/baseline', path)),
    failure: json(stage + '/release-failure.json'), released: json(stage + '/released.json'),
    applyStarted: json(stage + '/apply-started.json'), databaseStarted: json(stage + '/database-apply-started.json'),
    manifest: json(stage + '/manifest.json'), capture: json(stage + '/capture.json'), reads: [...reads] }));
`;

function run(scenario = {}) {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', harness], {
        encoding: 'utf8', timeout: 15000, windowsHide: true,
        env: { ...process.env, COMMUNITY_RELEASE_SCENARIO: JSON.stringify(scenario),
            COMMUNITY_RELEASE_SOURCE: scenario.stageMode ? stageSource : applySource, COMMUNITY_APPLY_SOURCE: applySource }
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, (result.stdout ?? '') + (result.stderr ?? ''));
    const observed = JSON.parse(result.stdout.trim());
    assert.ok(!observed.output.join('\n').includes('SENSITIVE'), 'Never surface credential-bearing diagnostics');
    return observed;
}
const stops = result => result.events.filter(event => event.type === 'unit' && event.action === 'stop');
const phases = result => result.events.filter(event => event.type === 'phase').map(event => event.phase);

test('community release verifies reviewed backups, stops writes, installs/deletes, migrates and verifies before success', () => {
    const result = run();
    assert.equal(result.error, null); assert.equal(result.released?.healthy, true);
    assert.equal(result.active, true); assert.equal(result.lockRetained, false);
    assert.equal(result.server, result.next); assert.deepEqual(result.deleted, [null, null]);
    assert.deepEqual(result.backups, [result.old, result.old]);
    assert.deepEqual(phases(result), ['migration', 'schema-before', 'schema-after']);
    const index = predicate => result.events.findIndex(predicate);
    const stop = index(event => event.type === 'unit' && event.action === 'stop');
    const install = index(event => event.type === 'install');
    const migrate = index(event => event.phase === 'migration');
    const start = index(event => event.type === 'unit' && event.action === 'start');
    const health = index(event => event.type === 'health');
    assert.ok(index(event => event.type === 'backup-hash') < stop);
    assert.ok(stop < install && install < migrate && migrate < start && start < health);
    assert.equal(result.released.scoreTimerTouched, false);
    assert.equal(result.databaseStarted.databaseMayHaveChanged, true);
    assert.equal(result.databaseStarted.automaticCodeRollbackAllowed, false);
});

test('idempotent migration result still crosses the irreversible recovery boundary', () => {
    const result = run({ alreadyMigrated: true });
    assert.equal(result.error, null); assert.equal(result.released.databaseChanged, false);
    assert.equal(result.released.databaseMayHaveChanged, true);
});

test('the actual prepared manifest is accepted by the apply helper, including read-only vendor CSS', () => {
    const result = run({ stageMode: 'prepare', stageThenApply: true });
    assert.equal(result.error, null); assert.equal(result.released?.healthy, true);
    assert.deepEqual(result.deleted, [null, null]);
    assert.ok(result.manifest.sources.some(source => source.path === 'public/vendor/fontawesome/css/all.min.css'));
});

for (const extraPath of ['ranking-service.js', 'benchmark-family-service.js', 'private/contribute.html',
    'private/dialogPage.html', 'public/js/shared/tooltip.js', 'public/css/shared/tooltip.css', 'public/build/home-abc.js', 'private/home-assets.json']) {
    test('community release permits only reviewed scoped addition: ' + extraPath, () => {
        const result = run({ extraPath }); assert.equal(result.error, null); assert.equal(result.released?.healthy, true);
    });
}

for (const invalid of ['stage-path', 'missing-apply', 'unknown-argument', 'duplicate-argument', 'backup-argument',
    'release', 'candidate-path', 'backup-path', 'migration', 'duplicate-files', 'duplicate-sources', 'source-overlap',
    'missing-migration', 'missing-deletion', 'replace-deletion', 'unknown-deletion', 'deletion-without-before',
    'bad-before', 'missing-before', 'bad-after', 'unsafe-mode', 'missing-source', 'unsafe-source', 'bad-source-hash',
    'unknown-manifest-field', 'stale-backup', 'future-backup', 'wrong-database', 'outside-dump', 'dump-traversal',
    'short-dump', 'dump-size', 'dump-hash', 'dump-permissions', 'backup-manifest-permissions', 'manifest-pin', 'backup-pin',
    'backup-manifest-copy', 'payload-mismatch', 'candidate-mismatch', 'source-mismatch', 'candidate-source-mismatch',
    'production-mismatch', 'production-permissions', 'code-backup-mismatch', 'deletion-payload', 'candidate-deletion',
    'payload-symlink', 'parent-symlink', 'dump-symlink', 'deletion-dangling-link', 'deletion-directory',
    'old-attempt', 'busy-lock', 'hardlink', 'unwritable', 'unloaded-service', 'missing-live-deletion', 'changed-live-deletion']) {
    test('community apply refuses before stopping writes: ' + invalid, () => {
        const result = run({ invalid });
        assert.ok(result.error); assert.equal(stops(result).length, 0); assert.deepEqual(phases(result), []);
        assert.equal(result.active, true); assert.equal(result.released, null);
    });
}

for (const extraPath of ['db.js', 'topic-service.js', 'scripts/migrate-topic-slugs-20261023.mjs', 'ops/launch-release.mjs',
    'private/.env', 'private/data.json', 'public/js/../secret.js', 'public/js/.hidden.js', 'public/js//empty.js',
    'public/js/./relative.js', 'public/css/photo.png', 'public/build/source.map', 'public/vendor/fontawesome/css/all.min.css', '../server.js', '/server.js']) {
    test('community apply rejects out-of-scope path ' + extraPath, () => {
        const result = run({ extraPath }); assert.ok(result.error); assert.equal(stops(result).length, 0);
    });
}

for (const scenario of [{ failInstall: true }, { backupChangesAfterStop: true }, { failRecord: 'database-apply-started.json' }]) {
    test('pre-DB failure restores owned changes including both deleted files: ' + JSON.stringify(scenario), () => {
        const result = run(scenario);
        assert.ok(result.error); assert.deepEqual(phases(result), []);
        assert.equal(result.server, result.old); assert.deepEqual(result.deleted, [result.old, result.old]);
        assert.equal(result.newAsset, null); assert.equal(result.migration, null);
        assert.equal(result.active, true); assert.equal(result.lockRetained, false);
        assert.equal(result.failure.databaseMayHaveChanged, false); assert.equal(result.failure.maintenance, false);
    });
}

for (const concurrentAt of ['after-stop', 'before-replace', 'after-install']) {
    test('pre-DB concurrency preserves foreign bytes and stays in maintenance: ' + concurrentAt, () => {
        const result = run({ concurrentAt });
        assert.ok(result.error); assert.deepEqual(phases(result), []); assert.equal(result.server, result.foreign);
        assert.equal(result.active, false); assert.equal(result.lockRetained, true);
        assert.equal(result.failure.databaseMayHaveChanged, false); assert.equal(result.failure.maintenanceRequired, true);
    });
}

test('pre-DB rollback never resurrects a concurrently replaced deletion', () => {
    const result = run({ concurrentAt: 'after-install', concurrentPath: 'benchmark-version-preferences.js' });
    assert.ok(result.error); assert.equal(result.deleted[0], result.foreign); assert.equal(result.active, false);
    assert.ok(result.failure.conflicts.includes('benchmark-version-preferences.js'));
});

test('a corrupted rollback backup is not installed or reported as recovered', () => {
    const result = run({ failInstall: true, corruptRollbackBackup: true });
    assert.ok(result.error); assert.equal(result.server, result.next); assert.equal(result.active, false);
    assert.equal(result.failure.maintenanceRequired, true); assert.ok(result.failure.failures.length);
});

for (const scenario of [{ stopFails: true }, { stopNoEffect: true }, { stopHasWriter: true }]) {
    test('application stop must be confirmed before changing code: ' + JSON.stringify(scenario), () => {
        const result = run(scenario); assert.ok(result.error); assert.deepEqual(phases(result), []);
        assert.equal(result.server, result.old); assert.equal(result.events.some(event => event.type === 'install'), false);
        assert.equal(result.failure.maintenance, false); assert.equal(result.failure.maintenanceRequired, true);
    });
}

for (const scenario of [{ failPhase: 'migration' }, { failPhase: 'schema-before' }, { failPhase: 'schema-after' },
    { failPhase: 'start' }, { failPhase: 'health' }, { missingNavigation: true }, { wrongMarker: true },
    { notReady: true }, { protectedDataChanged: true }, { invalidMigrationJSON: true },
    { failRecord: 'migration-result.json' }, { failRecord: 'released.json' }]) {
    test('after SQL may have committed, keep new code and fail closed: ' + JSON.stringify(scenario), () => {
        const result = run(scenario);
        assert.ok(result.error); assert.equal(result.server, result.next); assert.deepEqual(result.deleted, [null, null]);
        assert.ok(phases(result).includes('migration'));
        if (['schema-before', 'schema-after'].includes(scenario.failPhase)) assert.ok(phases(result).includes(scenario.failPhase));
        if (scenario.failPhase === 'start') assert.equal(result.failure.phase, 'start-application');
        if (scenario.failPhase === 'health' || scenario.missingNavigation) assert.equal(result.failure.phase, 'health');
        assert.equal(result.newAsset, result.next); assert.equal(result.active, false); assert.equal(result.lockRetained, true);
        assert.equal(result.failure.databaseMayHaveChanged, true); assert.equal(result.failure.codeRollbackSkipped, true);
        assert.equal(result.failure.automaticCodeRollbackAllowed, false); assert.equal(result.failure.restored, 0);
        assert.equal(result.failure.maintenance, true); assert.equal(result.failure.scoreTimerTouched, false);
        assert.match(result.failure.recovery, /Fix forward/); assert.equal(result.released, null);
    });
}

test('post-migration concurrent bytes remain untouched, including a resurrected deletion', () => {
    for (const concurrentPath of ['server.js', 'benchmark-version-preferences.js']) {
        const result = run({ concurrentAt: 'health', concurrentPath });
        assert.ok(result.error); assert.equal(result.active, false); assert.equal(result.failure.restored, 0);
        assert.equal(concurrentPath === 'server.js' ? result.server : result.deleted[0], result.foreign);
        assert.equal(result.failure.databaseMayHaveChanged, true);
    }
});

test('maintenance stop failure after SQL is explicit, never a claim that writes are frozen', () => {
    const result = run({ failPhase: 'health', maintenanceStopFails: true });
    assert.ok(result.error); assert.equal(result.active, true); assert.equal(result.server, result.next);
    assert.equal(result.failure.maintenance, false); assert.equal(result.failure.maintenanceRequired, true);
    assert.equal(result.failure.databaseMayHaveChanged, true); assert.ok(result.failure.failures.length);
});

test('stage captures deletion hashes and original bytes without a deletion payload', () => {
    const result = run({ stageMode: 'capture' }); assert.equal(result.error, null);
    assert.deepEqual(result.baseline, [result.old, result.old]);
    const deleted = result.capture.files.filter(file => file.after === null);
    assert.equal(deleted.length, 2); assert.ok(deleted.every(file => file.before === result.old));
});

test('stage removes obsolete candidate files, backs them up, skips syntax/source checks, and guards migration dependencies', () => {
    const result = run({ stageMode: 'prepare' }); assert.equal(result.error, null);
    assert.deepEqual(result.candidateDeleted, [null, null]); assert.deepEqual(result.backups, [result.old, result.old]);
    assert.ok(result.manifest.files.some(file => file.path === 'scripts/migrate-community-fallback-20261030.mjs'));
    for (const path of ['scripts/migrate-topic-slugs-20261023.mjs', 'package.json', 'public/js/shared/topics.js']) {
        assert.ok(result.manifest.sources.some(source => source.path === path));
    }
    const deleted = result.manifest.files.filter(file => file.after === null);
    assert.equal(deleted.length, 2); assert.ok(deleted.every(file => file.before === result.old && file.mode === 0o100644));
    assert.ok(deleted.every(file => !result.manifest.sources.some(source => source.path === file.path)
        && !result.events.some(event => event.type === 'syntax' && event.path.endsWith('/' + file.path))));
});

for (const invalid of ['migration', 'missing-migration', 'missing-deletion', 'replace-deletion', 'unknown-deletion',
    'bad-after', 'deletion-without-before', 'deletion-payload', 'deletion-dangling-link', 'deletion-directory',
    'changed-live-deletion', 'missing-live-deletion', 'existing-candidate', 'existing-backup']) {
    test('community stage refuses unsafe preparation: ' + invalid, () => {
        const result = run({ stageMode: 'prepare', invalid }); assert.ok(result.error); assert.equal(result.manifest, null);
    });
}

for (const scenario of [{ candidateCopyRace: true }, { backupCopyRace: true }]) {
    test('community stage catches source changes during copying: ' + JSON.stringify(scenario), () => {
        const result = run({ stageMode: 'prepare', ...scenario }); assert.ok(result.error); assert.equal(result.manifest, null);
    });
}

for (const family of ['score-toolbar-20261030', 'topics-refinement-20261024', 'topics-interactions-20261025',
    'topics-account-20261027', 'site-navigation-20261029', 'audit-fixes-20261030']) {
    test('existing stage family remains compatible: ' + family, () => {
        const result = run({ stageMode: 'prepare', family }); assert.equal(result.error, null); assert.ok(result.manifest);
    });
    test('community deletion permission does not leak into ' + family, () => {
        const result = run({ stageMode: 'prepare', family, legacyDeletion: true }); assert.ok(result.error); assert.equal(result.manifest, null);
    });
}
