import { readFile, writeFile, mkdir, copyFile, rename, lstat, chmod, unlink, rmdir, access } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

// Operator-supplied digests pin reviewed artifacts; this helper never creates a DB backup or reads .env.
// Usage: node community-fallback-apply-20261030.mjs STAGE --apply --manifest-sha256=HEX
//   --backup-manifest=STAGE/database-backup.json --backup-manifest-sha256=HEX
// Supply DB credentials through the process environment. A failed DB attempt requires forward repair.
const root = '/home/ubuntu/benchpoll';
const family = 'community-fallback-20261030';
const stage = resolve(process.argv[2] || '.');
const release = stage.split('/').at(-1);
if (process.argv[2] !== stage || !/^community-fallback-20261030-\d+$/.test(release)
    || stage !== `${root}/scripts/${family}/${release}`) throw new Error('Unsafe community fallback stage');
const args = process.argv.slice(3);
const options = new Map();
for (const arg of args) {
    const index = arg.indexOf('=');
    const name = index < 0 ? arg : arg.slice(0, index), value = index < 0 ? true : arg.slice(index + 1);
    if (!['--apply', '--manifest-sha256', '--backup-manifest', '--backup-manifest-sha256'].includes(name)
        || options.has(name)) throw new Error('Unexpected or duplicate release argument');
    options.set(name, value);
}
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const manifestHash = options.get('--manifest-sha256'), backupManifestHash = options.get('--backup-manifest-sha256');
const backupManifestPath = join(stage, 'database-backup.json');
if (options.get('--apply') !== true || !digest(manifestHash) || !digest(backupManifestHash)
    || options.get('--backup-manifest') !== backupManifestPath) throw new Error('Explicit apply and reviewed manifest hashes are required');
const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('Invalid database name');
const candidate = join(stage, 'candidate'), payload = join(stage, 'payload');
const backup = `/home/ubuntu/benchpoll-code-backups/${release}`;
const migration = 'scripts/migrate-community-fallback-20261030.mjs';
const marker = 'community_fallback_20261030';
const dependency = 'scripts/migrate-topic-slugs-20261023.mjs';
const deletions = ['benchmark-version-preferences.js', 'public/js/workspace/version-group-dialog.js'];
const lockPath = join(root, 'scripts/.community-fallback-release.lock');
const cleanPath = path => typeof path === 'string' && path.split('/').every(part => part && !part.startsWith('.'));
const uiPath = path => cleanPath(path)
    && /^(?:public\/(?:js\/[a-zA-Z0-9_./-]+\.js|css\/[a-zA-Z0-9_./-]+\.css|build\/[a-zA-Z0-9_./-]+\.(?:js|css))|private\/[a-zA-Z0-9_-]+\.html|private\/(?:home|index)-assets\.json)$/.test(path);
const writablePath = path => uiPath(path) || ['server.js', 'ranking-service.js', 'benchmark-family-service.js', migration].includes(path);
const sourcePath = path => uiPath(path) || cleanPath(path) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.js$/.test(path)
    || ['package.json', 'scripts/build-home-assets.mjs', dependency, 'public/vendor/fontawesome/css/all.min.css'].includes(path);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => record(value) && Object.keys(value).every(key => allowed.includes(key));
const validMode = mode => Number.isInteger(mode) && mode >= 0 && mode <= 0o100777 && (mode & ~0o100777) === 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// Reject symlinks (including dangling ones) in every ancestor, not just traversal in the manifest.
async function inspectPath(path, kind = 'file', optional = false) {
    let current = '/';
    const parts = path.split('/').slice(1);
    for (let index = 0; index < parts.length; index++) {
        current = join(current, parts[index]);
        let info;
        try { info = await lstat(current); }
        catch (error) { if (optional && error.code === 'ENOENT') return null; throw new Error('Missing or unreadable release path: ' + current); }
        const directory = index < parts.length - 1 || kind === 'directory';
        if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) || !directory && info.nlink !== 1) {
            throw new Error('Non-regular release path: ' + current);
        }
        if (index === parts.length - 1) return info;
    }
    throw new Error('Invalid release filesystem path');
}
async function hash(path, optional = false) {
    if (!await inspectPath(path, 'file', optional)) return null;
    return sha(await readFile(path));
}
async function pinnedJSON(path, expected) {
    await inspectPath(path);
    const bytes = await readFile(path);
    if (sha(bytes) !== expected) throw new Error('Reviewed manifest changed: ' + path);
    return JSON.parse(bytes.toString('utf8'));
}
await inspectPath(stage, 'directory');
const manifest = await pinnedJSON(join(stage, 'manifest.json'), manifestHash);
if (!keys(manifest, ['release', 'migration', 'candidate', 'backup', 'files', 'sources'])
    || manifest.release !== release || manifest.migration !== migration.slice(8)
    || manifest.candidate !== candidate || manifest.backup !== backup
    || !Array.isArray(manifest.files) || !manifest.files.length || !Array.isArray(manifest.sources)) throw new Error('Invalid release manifest');
const paths = new Set();
for (const file of manifest.files) {
    if (!keys(file, ['path', 'before', 'after', 'baseline', 'mode']) || paths.has(file.path)
        || !(file.before === null || digest(file.before))
        || (file.after === null ? !deletions.includes(file.path) || !digest(file.before)
            : !writablePath(file.path) || deletions.includes(file.path) || !digest(file.after))
        || Object.hasOwn(file, 'baseline') && !(file.baseline === null || digest(file.baseline))
        || file.before !== null && !validMode(file.mode)
        || Object.hasOwn(file, 'mode') && !validMode(file.mode)) throw new Error('Unsafe release file');
    paths.add(file.path);
}
if (!paths.has(migration) || deletions.some(path => !paths.has(path))) throw new Error('Migration and exact deletion list are required');
const sources = new Set();
for (const source of manifest.sources) {
    if (!keys(source, ['path', 'before']) || !sourcePath(source.path) || !digest(source.before)
        || paths.has(source.path) || sources.has(source.path)) throw new Error('Unsafe release source');
    sources.add(source.path);
}
for (const path of [dependency, 'scripts/build-home-assets.mjs', 'package.json', 'public/js/shared/topics.js']) {
    if (!paths.has(path) && !sources.has(path)) throw new Error('Missing migration/build source guard: ' + path);
}

async function verifySources() {
    for (const source of manifest.sources) {
        if (await hash(join(root, source.path)) !== source.before
            || await hash(join(candidate, source.path)) !== source.before) throw new Error('Concurrent dependency change: ' + source.path);
    }
}
async function verifyLive(version) {
    for (const file of manifest.files) {
        const target = join(root, file.path);
        if (await hash(target, true) !== file[version]) throw new Error('Concurrent production change: ' + file.path);
        if (file[version] !== null && ((await inspectPath(target)).mode & 0o777) !== ((file.mode ?? 0o644) & 0o777)) {
            throw new Error('Production permissions changed: ' + file.path);
        }
    }
    await verifySources();
}
async function verifyArtifacts() {
    await pinnedJSON(join(stage, 'manifest.json'), manifestHash);
    await pinnedJSON(join(backup, 'manifest.json'), manifestHash);
    for (const file of manifest.files) {
        for (const base of [payload, candidate]) {
            if (await hash(join(base, file.path), true) !== file.after) throw new Error('Stage mismatch or deletion payload present: ' + file.path);
        }
        if (file.before !== null && await hash(join(backup, file.path)) !== file.before) throw new Error('Code backup mismatch: ' + file.path);
    }
}
async function verifyDatabaseBackup() {
    const saved = await pinnedJSON(backupManifestPath, backupManifestHash);
    const age = Date.now() - Date.parse(saved.createdAt);
    if (saved.database !== database || typeof saved.path !== 'string'
        || !/^database-\d+\.sql(?:\.gz)?$/.test(saved.path.slice(stage.length + 1))
        || !saved.path.startsWith(stage + '/') || !digest(saved.sha256)
        || !Number.isSafeInteger(saved.bytes) || saved.bytes < 1000 || !Number.isFinite(age) || age < 0 || age > 7200000) {
        throw new Error('A fresh reviewed database backup is required');
    }
    const info = await inspectPath(saved.path), manifestInfo = await inspectPath(backupManifestPath);
    if (info.size !== saved.bytes || info.mode & 0o077 || manifestInfo.mode & 0o077) throw new Error('Invalid database backup size or permissions');
    const checksum = createHash('sha256');
    for await (const bytes of createReadStream(saved.path)) checksum.update(bytes);
    if (checksum.digest('hex') !== saved.sha256) throw new Error('Database backup integrity check failed');
    await pinnedJSON(backupManifestPath, backupManifestHash);
}
async function writableParent(path) {
    let parent = dirname(path);
    for (;;) {
        if (await inspectPath(parent, 'directory', true)) { await access(parent, constants.W_OK); return; }
        parent = dirname(parent);
    }
}
// Child output is never inherited or included in errors: DB diagnostics can contain credentials.
const environment = { ...process.env, BENCHPOLL_DB_NAME: database, DOTENV_CONFIG_PATH: '/dev/null',
    DOTENV_CONFIG_QUIET: 'true', DOTENV_CONFIG_DEBUG: 'false' };
delete environment.NODE_OPTIONS;
delete environment.NODE_PATH;
delete environment.DOTENV_CONFIG_OVERRIDE;
delete environment.DOTENV_KEY;
delete environment.DOTENV_CONFIG_DOTENV_KEY;
function command(executable, commandArgs, label, timeout = 120000) {
    try {
        return execFileSync(executable, commandArgs, { cwd: root, env: environment, encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 1024 * 1024, windowsHide: true });
    } catch { throw new Error(label + ' failed (child output withheld)'); }
}
function applicationState(expected) {
    const output = command('systemctl', ['show', 'benchpoll.service', '--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job'], 'Application state inspection');
    const rows = output.trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; });
    const state = Object.fromEntries(rows);
    const quiet = state.ControlPID === '0' && ['', '0'].includes(state.Job);
    const stopped = state.ActiveState === 'inactive' && state.SubState === 'dead' && state.MainPID === '0';
    const running = state.ActiveState === 'active' && state.SubState === 'running' && /^[1-9]\d*$/.test(state.MainPID);
    if (rows.length !== 6 || Object.keys(state).length !== 6 || state.LoadState !== 'loaded' || !quiet
        || !(expected === 'stopped' ? stopped : running)) throw new Error('Application is not confirmed ' + expected);
}
function stopApplication() {
    command('sudo', ['-n', 'systemctl', 'stop', 'benchpoll.service'], 'Application stop');
    applicationState('stopped');
}
function startApplication() {
    command('sudo', ['-n', 'systemctl', 'start', 'benchpoll.service'], 'Application start');
    applicationState('running');
}
function migrationCommand(apply) {
    const output = command('/usr/bin/node', [join(root, migration), ...(apply
        ? ['--apply', '--writes-stopped', '--backup-manifest=' + backupManifestPath] : ['--check'])],
    apply ? 'Community fallback migration' : 'Community fallback schema check', 600000);
    let result;
    try { result = JSON.parse(output); } catch { throw new Error('Invalid migration result (child output withheld)'); }
    if (result.migration !== marker || result.ready !== true || result.resetApplied !== true
        || result.explicitNoneReady !== true || result.concreteVersionsOnly !== true
        || apply && (typeof result.applied !== 'boolean' || result.protectedDataUnchanged !== true)) throw new Error('Community fallback schema marker or preservation check failed');
    return { migration: marker, ready: true, resetApplied: true, explicitNoneReady: true, concreteVersionsOnly: true,
        ...(apply ? { applied: result.applied, protectedDataUnchanged: true } : {}) };
}
async function replaceFile(source, destination, expected, wanted, mode) {
    await mkdir(dirname(destination), { recursive: true });
    await inspectPath(dirname(destination), 'directory');
    const temporary = `${destination}.${release}.tmp`;
    let owned = false;
    try {
        await copyFile(source, temporary, constants.COPYFILE_EXCL); owned = true;
        await chmod(temporary, (mode ?? 0o644) & 0o777);
        if (await hash(temporary) !== wanted) throw new Error('Replacement bytes changed');
        if (await hash(destination, true) !== expected) throw new Error('Concurrent replacement conflict: ' + destination);
        await rename(temporary, destination); owned = false;
    } finally { if (owned) await unlink(temporary); }
}
async function removeFile(destination, expected) {
    if (await hash(destination) !== expected) throw new Error('Concurrent deletion conflict: ' + destination);
    await unlink(destination);
}
function health() {
    return new Promise((resolveHealth, reject) => {
        const req = request('https://127.0.0.1:1337/', { rejectUnauthorized: false, timeout: 5000,
            headers: { Host: 'benchpoll.com' } }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', data => { body += data; if (body.length > 2 * 1024 * 1024) req.destroy(new Error('Health response too large')); });
            res.on('error', reject);
            res.on('end', () => resolveHealth(res.statusCode === 200 && body.includes('BenchPoll')
                && body.includes('topics-grid') && body.includes('topics-navigation')));
        });
        req.on('timeout', () => req.destroy(new Error('Health timeout')));
        req.on('error', reject); req.end();
    });
}
async function waitForHealth() {
    for (let attempt = 0; attempt < 12; attempt++) {
        if (await health().catch(() => false)) return;
        await delay(1000);
    }
    throw new Error('Post-release homepage health failed');
}
const save = (name, value) => writeFile(join(stage, name), JSON.stringify({ release, ...value }, null, 2), { flag: 'wx', mode: 0o600 });
for (const name of ['apply-started.json', 'database-apply-started.json', 'released.json', 'release-failure.json']) {
    if (await inspectPath(join(stage, name), 'file', true)) throw new Error('Release already attempted; review recovery before using a new release');
}
await verifyArtifacts();
await verifyLive('before');
await verifyDatabaseBackup();
for (const file of manifest.files) {
    await writableParent(join(root, file.path));
    if (file.after !== null && /\.m?js$/.test(file.path)) command('/usr/bin/node', ['--check', join(payload, file.path)], 'Candidate syntax check');
}
applicationState('running');
await inspectPath(dirname(lockPath), 'directory');
await mkdir(lockPath, { mode: 0o700 });
let releaseLock = false, stopRequested = false, databaseMayHaveChanged = false, codeInstalled = false, phase = 'preflight';
const changed = [];
try {
    await save('apply-started.json', { manifestHash, backupManifestHash, databaseMayHaveChanged: false, scoreTimerTouched: false });
    await verifyArtifacts(); await verifyLive('before'); await verifyDatabaseBackup();
    applicationState('running');
    phase = 'stop-application'; stopRequested = true;
    stopApplication();
    phase = 'install-code';
    await verifyArtifacts(); await verifyLive('before');
    for (const file of manifest.files) {
        const destination = join(root, file.path);
        if (file.after === null) await removeFile(destination, file.before);
        else await replaceFile(join(payload, file.path), destination, file.before, file.after, file.mode);
        changed.push(file);
    }
    codeInstalled = true;
    await verifyArtifacts(); await verifyLive('after'); await verifyDatabaseBackup();
    applicationState('stopped');
    phase = 'database-apply';
    // Set the durable recovery boundary BEFORE invoking SQL, even if the child later fails or times out.
    await save('database-apply-started.json', { manifestHash, backupManifestHash, databaseMayHaveChanged: true,
        automaticCodeRollbackAllowed: false, recovery: 'Keep new code, keep application stopped, fix forward. Never restore old code over explicit-none rows.' });
    databaseMayHaveChanged = true;
    const migrationResult = migrationCommand(true);
    await save('migration-result.json', migrationResult);
    phase = 'verify-schema';
    migrationCommand(false);
    await verifyArtifacts(); await verifyLive('after');
    applicationState('stopped');
    phase = 'start-application';
    startApplication();
    phase = 'health';
    await waitForHealth();
    migrationCommand(false);
    await verifyArtifacts(); await verifyLive('after');
    applicationState('running');
    const result = { healthy: true, databaseMayHaveChanged: true, databaseChanged: migrationResult.applied,
        codeInstalled: true, automaticCodeRollbackAllowed: false, scoreTimerTouched: false,
        backup, databaseBackupManifest: backupManifestPath, manifestHash, backupManifestHash, schema: migrationResult,
        deleted: deletions, releasedAt: new Date().toISOString() };
    await save('released.json', result);
    releaseLock = true;
    console.log(JSON.stringify({ release, ...result }));
} catch (error) {
    let maintenance = false, restored = 0;
    const conflicts = [], failures = [];
    if (stopRequested) {
        try { stopApplication(); maintenance = true; } catch { failures.push('Cannot confirm application stopped; operator intervention required'); }
    }
    if (!databaseMayHaveChanged && maintenance) {
        for (const file of [...changed].reverse()) {
            try {
                const destination = join(root, file.path);
                if (await hash(destination, true) !== file.after) { conflicts.push(file.path); continue; }
                if (file.before === null) await removeFile(destination, file.after);
                else await replaceFile(join(backup, file.path), destination, file.after, file.before, file.mode);
                restored++;
            } catch { failures.push('Code rollback failed: ' + file.path); }
        }
        try { await verifyLive('before'); } catch { failures.push('Original code/source state is not restored'); }
        if (!conflicts.length && !failures.length) {
            try { startApplication(); await waitForHealth(); maintenance = false; }
            catch {
                failures.push('Original application restart/health failed');
                maintenance = false;
                try { stopApplication(); maintenance = true; } catch { failures.push('Cannot confirm recovery maintenance'); }
            }
        }
    }
    releaseLock = !databaseMayHaveChanged && !conflicts.length && !failures.length;
    const failure = { phase, message: error.message, databaseMayHaveChanged, codeInstalled,
        automaticCodeRollbackAllowed: !databaseMayHaveChanged, codeRollbackSkipped: databaseMayHaveChanged,
        restored, conflicts, failures, maintenance, maintenanceRequired: databaseMayHaveChanged || conflicts.length > 0 || failures.length > 0,
        scoreTimerTouched: false, lockRetained: !releaseLock, manifestHash, backupManifestHash,
        recovery: databaseMayHaveChanged
            ? 'Keep new code and application maintenance. Fix forward; old code is incompatible with explicit-none rows. Do not automatically restore code or database. Review the retained release lock before recovery.'
            : 'Only verified owned code was rolled back. Resolve conflicts or maintenance failures before retrying with a new release.' };
    try { await save('release-failure.json', failure); }
    catch { console.error('Release failure record could not be saved; review apply-started and database-apply-started records.'); }
    console.error(JSON.stringify({ release, ...failure }));
    throw new Error('Community fallback release failed at ' + phase + (databaseMayHaveChanged ? '; DB may have committed: keep new code and fix forward' : '; inspect recovery record'));
} finally {
    if (releaseLock) await rmdir(lockPath);
}
