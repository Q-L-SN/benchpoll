import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, rename, lstat, chmod, chown, unlink, rmdir, readdir, readlink, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

const root = '/home/ubuntu/benchpoll', stage = resolve(process.argv[2] || '.');
const release = stage.split('/').at(-1), digest = value => /^[a-f0-9]{64}$/.test(value || '');
assert.match(release, /^topic-scenes-20261031-\d+$/);
assert.equal(stage, `${root}/scripts/topic-scenes-20261031/${release}`);
assert.equal(process.argv[3], '--apply');
const expectedHash = process.argv[4]?.replace(/^--manifest-sha256=/, '');
assert.ok(digest(expectedHash) && process.argv.length === 5 && process.getuid() === 0);
const candidate = join(stage, 'candidate'), payload = join(stage, 'payload');
const backup = `/home/ubuntu/benchpoll-code-backups/${release}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function regular(path, optional = false) {
    let current = '/';
    for (const part of path.split('/').filter(Boolean)) {
        current = join(current, part);
        let info;
        try { info = await lstat(current); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
        assert.ok(!info.isSymbolicLink(), 'Symlink in release path: ' + current);
        if (current === path) { assert.ok(info.isFile()); return info; }
        assert.ok(info.isDirectory());
    }
}
async function hash(path, optional = false) { return await regular(path, optional) ? sha(await readFile(path)) : null; }
const manifestBytes = await readFile(join(stage, 'manifest.json'));
assert.equal(sha(manifestBytes), expectedHash);
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.release, release); assert.equal(manifest.candidate, candidate); assert.equal(manifest.backup, backup);
assert.equal(manifest.migration, 'migrate-topic-scenes-20261031.mjs');
assert.equal(manifest.taxonomyMigration, 'migrate-topic-scenes-taxonomy-20261031.mjs');
const writable = path => typeof path === 'string' && path.split('/').every(part => part && !part.startsWith('.'))
    && /^(?:[a-z0-9-]+\.js|scripts\/(?:migrate-topic-scenes(?:-taxonomy)?-20261031|check-ranking-integrity|delete-benchmarks-before-id)\.mjs|ops\/rehearse-topic-scenes-20261031\.mjs|ops\/topic-scenes-taxonomy-20261031\.json|public\/(?:js|css|build)\/[a-zA-Z0-9_./-]+|private\/[a-zA-Z0-9_-]+\.(?:html|json))$/.test(path);
assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
assert.equal(new Set(manifest.files.map(file => file.path)).size, manifest.files.length);
for (const file of manifest.files) {
    assert.ok(writable(file.path) && digest(file.after) && (file.before === null || digest(file.before)));
}
assert.ok(manifest.files.some(file => file.path === 'scripts/migrate-topic-scenes-20261031.mjs'));
assert.ok(manifest.files.some(file => file.path === 'ops/rehearse-topic-scenes-20261031.mjs'));
for (const path of ['scripts/' + manifest.taxonomyMigration, 'ops/topic-scenes-taxonomy-20261031.json']) {
    assert.ok(manifest.files.some(file => file.path === path));
}
assert.ok(digest(manifest.runtime?.sha256));
for (const path of ['package.json', 'package-lock.json']) assert.ok(manifest.sources.some(source => source.path === path));
const command = (executable, args, timeout = 120000) => execFileSync(executable, args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 2 ** 22,
    env: { ...process.env, NODE_OPTIONS: '', DOTENV_CONFIG_PATH: '/dev/null', DOTENV_CONFIG_QUIET: 'true',
        BENCHPOLL_DB_SOCKET: '/var/run/mysqld/mysqld.sock', BENCHPOLL_DB_USER: 'root', BENCHPOLL_DB_NAME: 'benchmarks' }
});
const service = (action, name) => command('systemctl', [action, name]);
const active = name => command('systemctl', ['show', name, '--property=ActiveState', '--value']).trim() === 'active';
const quiescent = name => {
    const state = Object.fromEntries(command('systemctl', ['show', name, '--property=ActiveState,MainPID,ControlPID,Job']).trim()
        .split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));
    return ['inactive', 'failed'].includes(state.ActiveState) && (!state.MainPID || state.MainPID === '0')
        && (!state.ControlPID || state.ControlPID === '0') && (!state.Job || state.Job === '0');
};
async function runtimeHash(directory) {
    let current = '/';
    for (const part of resolve(directory).split('/').filter(Boolean)) {
        current = join(current, part);
        const info = await lstat(current);
        assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Linked runtime directory: ' + current);
    }
    const entries = [];
    async function visit(path, prefix = '') {
        for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            const full = join(path, item.name), key = prefix + item.name;
            if (item.isSymbolicLink()) {
                const target = await readlink(full);
                assert.ok(resolve(dirname(full), target).startsWith(resolve(directory) + '/'));
                entries.push([key, 'link', target]);
            } else if (item.isDirectory()) { entries.push([key, 'directory']); await visit(full, key + '/'); }
            else if (item.isFile()) entries.push([key, 'file', sha(await readFile(full))]);
            else throw new Error('Unsupported runtime entry');
        }
    }
    await visit(directory); return sha(JSON.stringify(entries));
}
const save = (name, value) => writeFile(join(stage, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
async function verify(version) {
    assert.equal(await hash(join(stage, 'manifest.json')), expectedHash);
    assert.equal(await hash(join(backup, 'manifest.json')), expectedHash);
    assert.equal(await runtimeHash(join(root, 'node_modules')), manifest.runtime.sha256, 'Live runtime changed');
    assert.equal(await runtimeHash(join(candidate, 'node_modules')), manifest.runtime.sha256, 'Candidate runtime changed');
    for (const file of manifest.files) {
        assert.equal(await hash(join(root, file.path), true), file[version], 'Production changed: ' + file.path);
        assert.equal(await hash(join(payload, file.path)), file.after, 'Payload changed: ' + file.path);
        assert.equal(await hash(join(candidate, file.path)), file.after, 'Candidate changed: ' + file.path);
        if (file.before !== null) assert.equal(await hash(join(backup, file.path)), file.before, 'Backup changed: ' + file.path);
    }
    for (const source of manifest.sources) {
        assert.ok(typeof source.path === 'string' && !source.path.split('/').some(part => !part || part.startsWith('.')));
        assert.equal(await hash(join(root, source.path)), source.before, 'Dependency changed: ' + source.path);
        assert.equal(await hash(join(candidate, source.path)), source.before, 'Candidate dependency changed: ' + source.path);
    }
}
async function replace(file, restoring = false) {
    const destination = join(root, file.path), desired = restoring ? file.before : file.after;
    assert.equal(await hash(destination, true), restoring ? file.after : file.before);
    if (desired === null) return unlink(destination);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${release}.tmp`;
    const info = await regular(destination, true);
    await copyFile(join(restoring ? backup : payload, file.path), temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, (file.mode ?? 0o644) & 0o777);
    await chown(temporary, info?.uid ?? 1000, info?.gid ?? 1000);
    assert.equal(await hash(temporary), desired);
    assert.equal(await hash(destination, true), restoring ? file.after : file.before);
    await rename(temporary, destination);
}
async function api(path, body = null) {
    return new Promise((resolveAPI, reject) => {
        const bytes = body === null ? null : JSON.stringify(body);
        const req = request('https://127.0.0.1:1337' + path, { rejectUnauthorized: false, timeout: 60000,
            method: bytes === null ? 'GET' : 'POST', headers: { Host: 'benchpoll.com',
                ...(bytes === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }) } }, res => {
            let value = '';
            res.setEncoding('utf8'); res.on('data', chunk => { value += chunk; if (value.length > 2 ** 24) req.destroy(new Error('Health response too large')); });
            res.on('error', reject); res.on('end', () => {
                try {
                    if (res.statusCode !== 200) throw new Error(`Health ${path}: ${res.statusCode}`);
                    resolveAPI(bytes === null ? value : JSON.parse(value));
                } catch (error) { reject(error); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('Health timeout'))); req.on('error', reject); req.end(bytes);
    });
}
const lock = join(root, 'scripts/.topic-scenes-release.lock');
await verify('before');
for (const file of manifest.files) if (/\.m?js$/.test(file.path)) command('/usr/bin/node', ['--check', join(payload, file.path)]);
assert.ok(active('benchpoll.service'));
assert.equal(await hash(join(stage, 'started.json'), true), null, 'Release already attempted');
const rehearsed = JSON.parse(command('/usr/bin/node', [join(candidate, 'ops/rehearse-topic-scenes-20261031.mjs')], 600000));
assert.ok(rehearsed.sourceUnchanged && rehearsed.concurrentCyclesRejected && rehearsed.dynamicRecalculation
    && rehearsed.preservedReferencesAfterDefaultChange && rehearsed.migration.protectedDataUnchanged
    && rehearsed.taxonomy.protectedDataUnchanged && rehearsed.taxonomy.activeScenes === 209);
await save('rehearsal-result.json', { manifestHash: expectedHash, ...rehearsed });
await verify('before');
assert.ok(Number.isFinite(rehearsed.sourceBytes) && rehearsed.sourceBytes > 0);
for (const directory of ['/var/backups/benchpoll', stage]) {
    const space = await statfs(directory);
    assert.ok(space.bavail * space.bsize >= rehearsed.sourceBytes * 2 + 2 ** 31, 'Insufficient backup/recovery space');
}
await mkdir(lock, { mode: 0o700 });
const timerWasActive = active('benchpoll-score-sync.timer');
let paused = false, databaseMayHaveChanged = false, phase = 'preflight';
const changed = [];
try {
    await save('started.json', { release, manifestHash: expectedHash, startedAt: new Date().toISOString(), timerWasActive });
    phase = 'stop-writes';
    if (timerWasActive) service('stop', 'benchpoll-score-sync.timer');
    service('stop', 'benchpoll-score-sync.service');
    service('stop', 'benchpoll.service'); paused = true;
    assert.ok(quiescent('benchpoll.service') && quiescent('benchpoll-score-sync.service') && quiescent('benchpoll-score-sync.timer'));
    phase = 'backup';
    const backupOutput = command('/usr/local/sbin/benchpoll-db-backup', [], 600000);
    const source = backupOutput.match(/Database backup completed: (\/var\/backups\/benchpoll\/benchmarks-\d{8}T\d+Z\.sql\.gz)/)?.[1];
    assert.ok(source); command('gzip', ['-t', source]);
    const bytes = await readFile(source), checksum = sha(bytes);
    assert.equal((await readFile(source + '.sha256', 'utf8')).split(/\s/)[0], checksum);
    const backupPath = join(stage, `database-${Date.now()}.sql.gz`);
    await copyFile(source, backupPath, constants.COPYFILE_EXCL); await chmod(backupPath, 0o600);
    assert.equal(await hash(backupPath), checksum);
    await save('database-backup.json', { database: 'benchmarks', path: backupPath, sha256: checksum,
        bytes: bytes.length, createdAt: new Date().toISOString() });
    await verify('before');
    phase = 'install-code';
    for (const file of manifest.files) { await replace(file); changed.push(file); }
    await verify('after');
    phase = 'migrate';
    await save('database-started.json', { automaticRollbackAllowed: false,
        recovery: 'Keep application stopped and repair forward, or restore the full pre-release database and code together.' });
    databaseMayHaveChanged = true;
    const script = join(root, 'scripts/migrate-topic-scenes-20261031.mjs');
    const migration = JSON.parse(command('/usr/bin/node', [script, '--apply', '--backup-manifest=' + join(stage, 'database-backup.json')], 600000));
    assert.ok(migration.verified && migration.protectedDataUnchanged);
    await save('migration-result.json', migration);
    assert.ok(JSON.parse(command('/usr/bin/node', [script, '--check'])).verified);
    phase = 'taxonomy';
    const taxonomyScript = join(root, 'scripts', manifest.taxonomyMigration);
    const taxonomy = JSON.parse(command('/usr/bin/node', [taxonomyScript, '--apply',
        '--backup-manifest=' + join(stage, 'database-backup.json')], 600000));
    assert.ok(taxonomy.verified && taxonomy.protectedDataUnchanged && taxonomy.officialTopics === 32 && taxonomy.activeScenes === 209);
    await save('taxonomy-result.json', taxonomy);
    assert.ok(JSON.parse(command('/usr/bin/node', [taxonomyScript, '--check'])).verified);
    assert.ok(JSON.parse(command('/usr/bin/node', [script, '--check'])).verified);
    await verify('after');
    phase = 'start'; service('start', 'benchpoll.service'); paused = false;
    let home;
    for (let attempt = 0; attempt < 15; attempt++) {
        home = await api('/').catch(() => null); if (home) break; await delay(1000);
    }
    assert.ok(home?.includes('topics-grid') && home.includes('BenchPoll'));
    phase = 'health';
    const topics = await api('/api/get_topics', {});
    assert.ok(topics.topics.length >= 32);
    for (const topic of topics.topics.filter(topic => topic.scenes.length)) {
        assert.ok(topic.scenes[0].isDefault && topic.scenes.filter(scene => scene.isDefault).length === 1);
    }
    const references = await api('/api/get_topic_reference_targets', {});
    assert.ok(references.targets.length > topics.topics.length && references.targets.every(target => !target.isPrivate));
    const images = topics.topics.find(topic => topic.ID === 172);
    const workspace = await api('/api/get_weighted_workspace', { categoryID: 172, contextValues: {}, scoreMode: 'range' });
    assert.equal(workspace.context.sceneID, images.scenes[0].ID);
    assert.equal(workspace.context.dimensions.length, 0);
    await verify('after'); assert.ok(active('benchpoll.service'));
    if (timerWasActive) service('start', 'benchpoll-score-sync.timer');
    assert.equal(active('benchpoll-score-sync.timer'), timerWasActive, 'Score timer state was not restored');
    const result = { release, healthy: true, databaseChanged: true, files: manifest.files.length,
        topics: topics.topics.length, activeOfficialScenes: taxonomy.activeScenes, publicReferenceTargets: references.targets.length,
        timerRestored: active('benchpoll-score-sync.timer') === timerWasActive, releasedAt: new Date().toISOString() };
    await save('released.json', result); await rmdir(lock); console.log(JSON.stringify(result));
} catch (error) {
    const recoveryErrors = [];
    for (const unit of ['benchpoll-score-sync.timer', 'benchpoll-score-sync.service', 'benchpoll.service']) {
        try { service('stop', unit); assert.ok(quiescent(unit), unit + ' is still running'); }
        catch (stopError) { recoveryErrors.push(`${unit}: ${stopError.message}`); }
    }
    const stopped = {};
    for (const unit of ['benchpoll-score-sync.timer', 'benchpoll-score-sync.service', 'benchpoll.service']) {
        try { stopped[unit] = quiescent(unit); }
        catch (stateError) { stopped[unit] = false; recoveryErrors.push(`${unit}: ${stateError.message}`); }
    }
    paused = stopped['benchpoll.service'];
    if (!databaseMayHaveChanged && Object.values(stopped).every(Boolean)) {
        for (const file of changed.reverse()) {
            try { await replace(file, true); } catch (restoreError) { recoveryErrors.push(`${file.path}: ${restoreError.message}`); }
        }
        if (!recoveryErrors.length) {
            try {
                service('start', 'benchpoll.service'); assert.ok(active('benchpoll.service')); paused = false;
                if (timerWasActive) service('start', 'benchpoll-score-sync.timer');
                assert.equal(active('benchpoll-score-sync.timer'), timerWasActive);
                await rmdir(lock);
            } catch (restartError) { recoveryErrors.push(restartError.message); }
        }
    }
    await save('release-failure.json', { phase, databaseMayHaveChanged, maintenance: paused, stopped,
        recoveryErrors, error: error.message });
    throw new Error(`Scene release failed at ${phase}; database may have changed: ${databaseMayHaveChanged}; application stopped: ${paused}. See protected release-failure.json.`);
}
