import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../ops/flat-topics-launch-20261022.mjs', import.meta.url));

// Execute the real ESM launcher with an import allowlist; application I/O stays in memory.
const harness = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const scenario = JSON.parse(process.env.FLAT_TOPICS_RELEASE_FIXTURE);
const source = await readFile(process.env.FLAT_TOPICS_RELEASE_SOURCE, 'utf8');
const prefix = scenario.auditFixes ? 'audit-fixes-20261030' : scenario.summaries ? 'topics-identity-ui-20261026' : scenario.taxonomy ? 'topics-taxonomy-20261026' : scenario.nameURLs ? 'topics-policy-20261026' : scenario.shortURLs ? 'topics-polish-20261023' : 'flat-topics-20261022';
const root = '/home/ubuntu/benchpoll', release = scenario.auditFixes || scenario.summaries || scenario.taxonomy || scenario.nameURLs ? prefix + '-1' : scenario.shortURLs ? 'topics-polish-20261023-1' : 'topics-20261022-1';
const stage = root + '/scripts/' + prefix + '/' + release;
const app = 'benchpoll.service', timer = 'benchpoll-score-sync.timer', sync = 'benchpoll-score-sync.service';
const original = Buffer.from('original application'), replacement = Buffer.from('candidate application');
const dependency = Buffer.from('unchanged dependency');
const dependencyPath = scenario.dependencyPath || 'ranking-service.js';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { release, candidate: stage + '/candidate', backup: '/home/ubuntu/benchpoll-code-backups/' + release,
    files: [{ path: 'server.js', before: sha(original), after: sha(replacement), mode: 0o644 }],
    sources: [{ path: dependencyPath, before: sha(dependency) }] };
if (scenario.auditFixes || scenario.summaries || scenario.taxonomy || scenario.shortURLs) manifest.migration = scenario.migration ?? (scenario.auditFixes ? 'migrate-topic-proposal-reservations-20261029.mjs' : scenario.summaries ? 'migrate-topic-summaries-20261026.mjs' : scenario.taxonomy ? 'migrate-topic-taxonomy-20261026.mjs' : scenario.nameURLs ? 'migrate-topic-name-urls-20261026.mjs' : 'migrate-topic-slugs-20261023.mjs');
const files = new Map([
    [stage + '/manifest.json', Buffer.from(JSON.stringify(manifest))],
    [stage + '/payload/server.js', replacement], [root + '/server.js', original],
    [root + '/' + dependencyPath, scenario.dependencyChanged ? Buffer.from('concurrent dependency change') : dependency]
]);
const events = [], output = [];
let timerActive = scenario.timerActive !== false, appRunning = true, appStops = 0;
const missing = path => Object.assign(new Error('Missing fixture file: ' + path), { code: 'ENOENT' });
const bytesAt = path => { const bytes = files.get(path); if (!bytes) throw missing(path); return bytes; };
const fs = {
    async readFile(path, encoding) { const bytes = bytesAt(path); return encoding ? bytes.toString(encoding) : bytes; },
    async writeFile(path, content) {
        files.set(path, Buffer.from(content)); events.push({ type: 'record', path });
    },
    async mkdir() {}, async chmod() {},
    async copyFile(from, to) { files.set(to, Buffer.from(bytesAt(from))); },
    async rename(from, to) {
        files.set(to, bytesAt(from)); files.delete(from); events.push({ type: 'install', path: to });
    },
    async unlink(path) { bytesAt(path); files.delete(path); }
};
function shownState(args, state) {
    const properties = [];
    for (let index = 0; index < args.length; index++) {
        if (args[index].startsWith('--property=')) properties.push(...args[index].slice(11).split(','));
        else if (['--property', '-p'].includes(args[index])) properties.push(...args[++index].split(','));
    }
    const entries = Object.entries(state).filter(([key]) => !properties.length || properties.includes(key));
    return entries.map(([key, value]) => args.includes('--value') ? value : key + '=' + value).join('\n') + '\n';
}
function command(executable, suppliedArgs) {
    const args = suppliedArgs.map(String);
    if (executable === '/usr/bin/node') {
        let phase;
        if (args[0] === stage + '/database.mjs') {
            assert.equal(args[1], stage);
            assert.ok(['backup', 'verify-production'].includes(args[2]));
            phase = args[2];
        } else {
            assert.equal(args[0], manifest.candidate + '/scripts/' + (scenario.auditFixes ? 'migrate-topic-proposal-reservations-20261029.mjs' : scenario.summaries ? 'migrate-topic-summaries-20261026.mjs' : scenario.taxonomy ? 'migrate-topic-taxonomy-20261026.mjs' : scenario.nameURLs ? 'migrate-topic-name-urls-20261026.mjs' : scenario.shortURLs ? 'migrate-topic-slugs-20261023.mjs' : 'migrate-flat-topics-20261022.mjs'));
            assert.ok(args.includes('--apply'));
            assert.ok(args.includes('--backup-manifest=' + stage + '/database-backup.json'));
            phase = 'migration';
        }
        events.push({ type: 'phase', phase });
        if (scenario.failPhase === phase) throw new Error('mock ' + phase + ' failed');
        return { status: 0, stdout: JSON.stringify({ verified: true }), stderr: '' };
    }
    assert.ok(executable === 'sudo' || executable === 'systemctl', 'Unexpected executable: ' + executable);
    const action = args.find(value => ['show', 'is-active', 'start', 'stop'].includes(value));
    const unit = args.find(value => value.endsWith('.service') || value.endsWith('.timer'));
    assert.ok([app, timer, sync].includes(unit), 'Unexpected unit: ' + unit);
    assert.ok(action, 'Unexpected systemctl arguments: ' + args);
    events.push({ type: 'unit', action, unit });
    if (action === 'show') {
        if (unit === sync && scenario.inspectFailure) throw new Error('mock sync inspection failed');
        const state = { LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ControlPID: '0', Job: '' };
        if (unit === timer) Object.assign(state, { ActiveState: timerActive ? 'active' : 'inactive',
            SubState: timerActive ? 'waiting' : 'dead' }, scenario.timerState);
        else if (unit === sync) Object.assign(state, scenario.syncState);
        else Object.assign(state, { ActiveState: appRunning ? 'active' : 'inactive', SubState: appRunning ? 'running' : 'dead' });
        return { status: 0, stdout: shownState(args, state), stderr: '' };
    }
    if (action === 'is-active') {
        const active = unit === timer ? timerActive : unit === app ? appRunning
            : ['active', 'reloading'].includes(scenario.syncState?.ActiveState);
        return { status: active ? 0 : 3, stdout: active ? 'active\n' : 'inactive\n', stderr: '' };
    }
    assert.notEqual(unit, sync, 'The launcher must not start or terminate an existing score import');
    if (unit === timer) {
        if (action === 'start' && scenario.timerRestoreFails) throw new Error('mock timer restore failed');
        timerActive = action === 'start';
    } else {
        if (action === 'stop' && ++appStops === 2 && scenario.maintenanceStopFails) throw new Error('mock maintenance stop failed');
        appRunning = action === 'start';
    }
    return { status: 0, stdout: '', stderr: '' };
}
function execFileSync(executable, args, options = {}) {
    const result = command(executable, args);
    if (result.status !== 0) throw Object.assign(new Error('mock command exited ' + result.status), result);
    return options.encoding ? result.stdout : Buffer.from(result.stdout);
}
function spawnSync(executable, args) {
    try { return command(executable, args); }
    catch (error) { return { status: 1, stdout: '', stderr: error.message, error }; }
}
const imports = {
    'node:fs/promises': fs, 'node:path': posix, 'node:crypto': { createHash },
    'node:child_process': { execFileSync, spawnSync },
    'node:timers/promises': { async setTimeout() {} },
    'node:https': { request(url, _options, callback) {
        const path = new URL(url).pathname;
        assert.equal(new URL(url).origin, 'https://127.0.0.1:1337');
        const replies = {
            '/': '<main id="topics-grid"></main>',
            '/topics/54/intelligence': '<section id="benchmark-card"></section>',
            '/intelligence': '<section id="benchmark-card"></section>',
            '/api/get_topics': JSON.stringify({ topics: [{ ID: 54, url: '/intelligence' }] }),
            '/api/get_topic_preview': JSON.stringify({ weights: [{ conditionID: 1 }], models: [{ ID: 1 }], pagination: { total: 1 } })
        };
        assert.ok(Object.hasOwn(replies, path), 'Unexpected health request: ' + path);
        events.push({ type: 'health', path });
        const request = new EventEmitter();
        request.destroy = error => request.emit('error', error);
        request.end = () => queueMicrotask(() => {
            const response = new EventEmitter(); response.setEncoding = () => {};
            response.statusCode = scenario.healthFails ? 503 : 200;
            callback(response); response.emit('data', replies[path]); response.emit('end');
        });
        return request;
    } }
};
const context = createContext({ Buffer, URL, queueMicrotask,
    process: { argv: ['/mock/node', '/mock/launcher.mjs', stage], env: {}, cwd: () => stage },
    console: { log(value) { output.push(String(value)); }, error(value) { output.push(String(value)); } } });
const module = new SourceTextModule(source, { context, identifier: 'isolated-flat-topics-launcher' });
await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier), 'Unmocked launcher import: ' + specifier);
    const entries = Object.entries(imports[specifier]);
    return new SyntheticModule(entries.map(([name]) => name), function () {
        for (const [name, value] of entries) this.setExport(name, value);
    }, { context });
});
let error = null;
try { await module.evaluate({ timeout: 2000 }); } catch (failure) { error = failure.message; }
const record = name => files.has(stage + '/' + name) ? JSON.parse(files.get(stage + '/' + name).toString()) : null;
console.log(JSON.stringify({ error, events, output, timerActive, appRunning,
    installed: sha(files.get(root + '/server.js')) === sha(replacement),
    failure: record('release-failure.json'), released: record('released.json'),
    timerFailure: record('timer-restore-failure.json') }));
`;

function runLauncher(scenario = {}) {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', harness], {
        encoding: 'utf8', timeout: 10000, windowsHide: true,
        env: { ...process.env, FLAT_TOPICS_RELEASE_SOURCE: launcher, FLAT_TOPICS_RELEASE_FIXTURE: JSON.stringify(scenario) }
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, (result.stdout ?? '') + (result.stderr ?? ''));
    return JSON.parse(result.stdout.trim());
}

const unitEvents = (result, action, unit) => result.events.filter(event => event.type === 'unit'
    && event.action === action && event.unit === unit);
const phases = result => result.events.filter(event => event.type === 'phase').map(event => event.phase);
const app = 'benchpoll.service', timer = 'benchpoll-score-sync.timer', sync = 'benchpoll-score-sync.service';

test('audit fixes release backs up, migrates and verifies before installing code', () => {
    const result = runLauncher({ auditFixes: true });
    assert.equal(result.error, null); assert.equal(result.released?.healthy, true);
    assert.deepEqual(phases(result), ['backup', 'migration', 'verify-production']);
    assert.equal(result.appRunning, true); assert.equal(result.timerActive, true);
    assert.ok(result.events.findIndex(event => event.phase === 'verify-production')
        < result.events.findIndex(event => event.type === 'install'));
});

for (const migration of ['migrate-topic-slugs-20261023.mjs', '../arbitrary.mjs', '']) {
    test('audit fixes release rejects unrelated migration ' + JSON.stringify(migration), () => {
        const result = runLauncher({ auditFixes: true, migration });
        assert.match(result.error, /Unexpected release migration/); assert.deepEqual(result.events, []);
    });
}

for (const failPhase of ['backup', 'migration', 'verify-production']) {
    test('audit fixes release preserves its write freeze after ' + failPhase + ' fails', () => {
        const result = runLauncher({ auditFixes: true, failPhase });
        assert.match(result.error, /mock/); assert.equal(result.installed, false);
        assert.equal(result.appRunning, failPhase === 'backup');
        assert.equal(result.timerActive, failPhase === 'backup');
    });
}

test('summary and penalty release uses its exact migration and canonical workspace health check', () => {
    const result = runLauncher({ summaries: true });
    assert.equal(result.error, null); assert.equal(result.released?.healthy, true);
    assert.deepEqual(phases(result), ['backup', 'migration', 'verify-production']);
    assert.ok(result.events.some(event => event.type === 'health' && event.path === '/intelligence'));
    assert.equal(result.appRunning, true); assert.equal(result.timerActive, true);
});

for (const migration of ['migrate-flat-topics-20261022.mjs', 'migrate-topic-taxonomy-20261026.mjs', '../arbitrary.mjs', '']) {
    test('summary release rejects unrelated migration ' + JSON.stringify(migration), () => {
        const result = runLauncher({ summaries: true, migration });
        assert.match(result.error, /Unexpected release migration/); assert.deepEqual(result.events, []);
    });
}

for (const failPhase of ['backup', 'migration', 'verify-production']) {
    test('summary release preserves write-freeze recovery for ' + failPhase, () => {
        const result = runLauncher({ summaries: true, failPhase });
        assert.match(result.error, /mock/); assert.equal(result.installed, false);
        assert.equal(result.appRunning, failPhase === 'backup'); assert.equal(result.timerActive, failPhase === 'backup');
    });
}

test('official taxonomy release uses only its exact migration under the normal backup and service guards', () => {
    const result = runLauncher({ taxonomy: true });
    assert.equal(result.error, null); assert.equal(result.released?.healthy, true);
    assert.deepEqual(phases(result), ['backup', 'migration', 'verify-production']);
    assert.equal(result.appRunning, true); assert.equal(result.timerActive, true);
});

for (const migration of ['migrate-topic-name-urls-20261026.mjs', '../arbitrary.mjs', '']) {
    test('official taxonomy release refuses unrelated migration ' + JSON.stringify(migration), () => {
        const result = runLauncher({ taxonomy: true, migration });
        assert.match(result.error, /Unexpected release migration/); assert.equal(result.events.length, 0);
    });
}

for (const failPhase of ['backup', 'migration', 'verify-production']) {
    test('official taxonomy release preserves failure handling for ' + failPhase, () => {
        const result = runLauncher({ taxonomy: true, failPhase });
        assert.match(result.error, /mock/); assert.equal(result.installed, false);
        assert.equal(result.appRunning, failPhase === 'backup');
        assert.equal(result.timerActive, failPhase === 'backup');
    });
}

test('name-URL policy release uses only its exact migration and restores both services after health checks', () => {
    const result = runLauncher({ nameURLs: true, shortURLs: true });
    assert.equal(result.error, null);
    assert.equal(result.released?.healthy, true);
    assert.equal(result.appRunning, true); assert.equal(result.timerActive, true);
    assert.deepEqual(phases(result), ['backup', 'migration', 'verify-production']);
});

test('name-URL policy release rejects an unrelated migration before touching services', () => {
    const result = runLauncher({ nameURLs: true, shortURLs: true, migration: 'migrate-topic-slugs-20261023.mjs' });
    assert.match(result.error, /Unexpected release migration/);
    assert.equal(result.events.length, 0);
});

test('short-topic release applies only the new slug migration and checks the canonical address', () => {
    const result = runLauncher({ shortURLs: true });
    assert.equal(result.error, null);
    assert.equal(result.released?.healthy, true);
    assert.ok(result.events.some(event => event.type === 'health' && event.path === '/intelligence'));
    assert.ok(!result.events.some(event => event.type === 'health' && event.path === '/topics/54/intelligence'));
});

for (const migration of ['migrate-flat-topics-20261022.mjs', '../arbitrary.mjs', '']) {
    test(`short-topic release rejects unexpected migration ${JSON.stringify(migration)} before touching services`, () => {
        const result = runLauncher({ shortURLs: true, migration });
        assert.match(result.error, /Unexpected release migration/);
        assert.deepEqual(result.events, []);
        assert.equal(result.appRunning, true);
    });
}

test('flat topics guards accept dotted root config names without replacing the config', () => {
    const result = runLauncher({ dependencyPath: 'eslint.config.js' });
    assert.equal(result.error, null);
    assert.equal(result.released?.healthy, true);
    assert.ok(!result.events.some(event => event.type === 'install' && event.path.endsWith('/eslint.config.js')));
});

for (const scenario of [{ dependencyPath: 'eslint.config.js', dependencyChanged: true },
    { dependencyPath: '../eslint.config.js' }, { dependencyPath: 'public/../eslint.config.js' }]) {
    test(`flat topics guards still refuse ${scenario.dependencyChanged ? 'changed bytes in' : 'unsafe path'} ${scenario.dependencyPath}`, () => {
        const result = runLauncher(scenario);
        assert.match(result.error, /Concurrent dependency change/);
        assert.deepEqual(phases(result), []);
        assert.equal(result.appRunning, true);
        assert.equal(unitEvents(result, 'stop', app).length, 0);
        assert.equal(unitEvents(result, 'stop', timer).length, 0);
    });
}

function assertRefusedBeforeAppStop(result) {
    assert.ok(result.error, 'An unsafe sync state must abort the release');
    assert.equal(unitEvents(result, 'stop', app).length, 0);
    assert.deepEqual(phases(result), []);
    assert.equal(result.installed, false);
    assert.equal(result.released, null);
    assert.equal(result.appRunning, true);
    assert.equal(result.timerActive, true);
    assert.equal(result.failure?.databaseMayHaveChanged, false);
}

const busySyncStates = [
    ['oneshot activating with its worker PID', { ActiveState: 'activating', SubState: 'start', MainPID: '1234' }],
    ['activating before a PID is assigned', { ActiveState: 'activating', SubState: 'start' }],
    ['an inactive unit retaining a MainPID', { MainPID: '1234' }],
    ['an inactive unit retaining a ControlPID', { ControlPID: '5678' }],
    ['an inactive unit with a queued job', { Job: '42' }],
    ['an inactive unit with a D-Bus job path', { Job: '42 /org/freedesktop/systemd1/job/42' }],
    ['an active import', { ActiveState: 'active', SubState: 'running', MainPID: '1234' }],
    ['a deactivating import', { ActiveState: 'deactivating', SubState: 'stop', MainPID: '1234' }],
    ['an unexpected sync substate', { SubState: 'start' }]
];
for (const [name, syncState] of busySyncStates) test(`flat topics release refuses ${name}`, () => {
    const result = runLauncher({ syncState });
    assertRefusedBeforeAppStop(result);
    assert.match(result.error, /score import/);
    assert.equal(unitEvents(result, 'show', sync).length, 1);
    assert.equal(unitEvents(result, 'is-active', sync).length, 0);
    const stopTimer = result.events.findIndex(event => event.unit === timer && event.action === 'stop');
    const inspectSync = result.events.findIndex(event => event.unit === sync && event.action === 'show');
    assert.ok(stopTimer >= 0 && stopTimer < inspectSync, 'Pause scheduling before inspecting the existing import');
    assert.equal(unitEvents(result, 'start', timer).length, 1, 'Restore the original timer after a pre-DB refusal');
});

test('flat topics release fails closed on an unloaded sync unit or a failed state query', () => {
    for (const scenario of [{ syncState: { LoadState: 'not-found' } }, { inspectFailure: true }]) {
        const result = runLauncher(scenario);
        assertRefusedBeforeAppStop(result);
        assert.match(result.error, /inspect|inspection/);
    }
});

test('flat topics release refuses a timer with a pending job without stopping the app', () => {
    const result = runLauncher({ timerState: { Job: '42' } });
    assertRefusedBeforeAppStop(result);
    assert.match(result.error, /timer state/);
    assert.equal(unitEvents(result, 'stop', timer).length, 0);
    assert.equal(unitEvents(result, 'start', timer).length, 0);
});

test('flat topics release restores an originally active timer only after successful health checks', () => {
    const result = runLauncher();
    assert.equal(result.error, null);
    assert.equal(result.failure, null);
    assert.equal(result.released?.healthy, true);
    assert.equal(result.installed, true);
    assert.equal(result.appRunning, true);
    assert.equal(result.timerActive, true);
    assert.deepEqual(phases(result), ['backup', 'migration', 'verify-production']);
    assert.equal(unitEvents(result, 'stop', app).length, 1);
    assert.equal(unitEvents(result, 'start', app).length, 1);
    assert.equal(unitEvents(result, 'stop', timer).length, 1);
    assert.equal(unitEvents(result, 'start', timer).length, 1);
    const restored = result.events.findIndex(event => event.unit === timer && event.action === 'start');
    const finalHealth = result.events.findLastIndex(event => event.type === 'health');
    assert.ok(restored > finalHealth && finalHealth >= 0);
    assert.equal(JSON.parse(result.output.at(-1)).scoreSyncTimerRestored, true);
});

test('flat topics release preserves an originally inactive timer', () => {
    const result = runLauncher({ timerActive: false });
    assert.equal(result.error, null);
    assert.equal(result.released?.healthy, true);
    assert.equal(result.timerActive, false);
    assert.equal(unitEvents(result, 'stop', timer).length, 0);
    assert.equal(unitEvents(result, 'start', timer).length, 0);
});

test('flat topics release accepts a failed import only when it is fully quiescent', () => {
    const result = runLauncher({ syncState: { ActiveState: 'failed', SubState: 'failed' } });
    assert.equal(result.error, null);
    assert.equal(result.released?.healthy, true);
});

test('flat topics release restores the app and original timer after a backup failure before DB changes', () => {
    const result = runLauncher({ failPhase: 'backup' });
    assert.equal(result.error, 'mock backup failed');
    assert.deepEqual(phases(result), ['backup']);
    assert.equal(result.failure?.databaseMayHaveChanged, false);
    assert.equal(result.failure?.maintenance, false);
    assert.equal(result.installed, false);
    assert.equal(result.released, null);
    assert.equal(result.appRunning, true);
    assert.equal(result.timerActive, true);
    assert.equal(unitEvents(result, 'start', app).length, 1);
    assert.equal(unitEvents(result, 'start', timer).length, 1);
    const restartApp = result.events.findIndex(event => event.unit === app && event.action === 'start');
    const restoreTimer = result.events.findIndex(event => event.unit === timer && event.action === 'start');
    assert.ok(restoreTimer > restartApp && restartApp >= 0);
});

for (const failPhase of ['migration', 'verify-production']) test(`flat topics ${failPhase} failure leaves all scheduled writers paused`, () => {
    const result = runLauncher({ failPhase });
    assert.equal(result.error, 'mock ' + failPhase + ' failed');
    assert.equal(result.failure?.databaseMayHaveChanged, true);
    assert.equal(result.failure?.maintenance, true);
    assert.equal(result.failure?.scoreSyncTimerPaused, true);
    assert.equal(result.released, null);
    assert.equal(result.installed, false);
    assert.equal(result.appRunning, false);
    assert.equal(result.timerActive, false);
    assert.equal(unitEvents(result, 'start', app).length, 0);
    assert.equal(unitEvents(result, 'start', timer).length, 0);
});

for (const maintenanceStopFails of [false, true]) test(`flat topics health failure keeps scheduled imports paused when maintenance stop ${maintenanceStopFails ? 'fails' : 'succeeds'}`, () => {
    const result = runLauncher({ healthFails: true, maintenanceStopFails });
    assert.match(result.error, /root page did not start/);
    assert.equal(result.failure?.message, result.error, 'Retain the original health failure');
    assert.equal(result.failure?.databaseMayHaveChanged, true);
    assert.equal(result.failure?.scoreSyncTimerPaused, true);
    assert.equal(result.failure?.maintenance, !maintenanceStopFails);
    if (maintenanceStopFails) assert.match(result.failure?.recoveryError, /mock maintenance stop failed/);
    else assert.equal(result.failure?.recoveryError, null);
    assert.equal(result.installed, true);
    assert.equal(result.released, null);
    assert.equal(result.appRunning, maintenanceStopFails);
    assert.equal(result.timerActive, false, 'A failed maintenance stop must never authorize scheduled writes');
    assert.equal(unitEvents(result, 'stop', app).length, 2);
    assert.equal(unitEvents(result, 'start', timer).length, 0);
});

test('flat topics release records a timer restoration failure instead of reporting restored scheduling', () => {
    const result = runLauncher({ timerRestoreFails: true });
    assert.equal(result.error, 'mock timer restore failed');
    assert.equal(result.timerFailure?.releaseSucceeded, true);
    assert.equal(result.timerFailure?.databaseMayHaveChanged, true);
    assert.equal(result.timerFailure?.scoreSyncTimerPaused, true);
    assert.equal(result.timerActive, false);
    assert.equal(result.appRunning, true);
    assert.equal(result.output.length, 0);
});
