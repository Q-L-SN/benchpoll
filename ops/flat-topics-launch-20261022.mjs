import { readFile, writeFile, mkdir, copyFile, rename, chmod, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

const root = '/home/ubuntu/benchpoll';
const stage = resolve(process.argv[2] || '.');
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/(?:flat-topics-20261022\/topics-20261022|topics-polish-20261023\/topics-polish-20261023|topics-policy-20261026\/topics-policy-20261026|topics-taxonomy-20261026\/topics-taxonomy-20261026|topics-identity-ui-20261026\/topics-identity-ui-20261026|audit-fixes-20261030\/audit-fixes-20261030)-\d+$/.test(stage)) throw new Error('Unsafe release stage');
const manifest = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'));
if (manifest.release !== stage.split('/').at(-1) || manifest.candidate !== join(stage, 'candidate')
    || manifest.backup !== join('/home/ubuntu/benchpoll-code-backups', manifest.release)) throw new Error('Invalid prepared release');
const nameURLs = manifest.release.startsWith('topics-policy-20261026-');
const taxonomy = manifest.release.startsWith('topics-taxonomy-20261026-');
const summaries = manifest.release.startsWith('topics-identity-ui-20261026-');
const auditFixes = manifest.release.startsWith('audit-fixes-20261030-');
const shortURLs = auditFixes || summaries || taxonomy || nameURLs || manifest.release.startsWith('topics-polish-20261023-');
const migrationName = manifest.migration ?? 'migrate-flat-topics-20261022.mjs';
if (migrationName !== (auditFixes ? 'migrate-topic-proposal-reservations-20261029.mjs' : summaries ? 'migrate-topic-summaries-20261026.mjs' : taxonomy ? 'migrate-topic-taxonomy-20261026.mjs' : nameURLs ? 'migrate-topic-name-urls-20261026.mjs' : shortURLs ? 'migrate-topic-slugs-20261023.mjs' : 'migrate-flat-topics-20261022.mjs')) throw new Error('Unexpected release migration');
const validPath = path => /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.js|scripts\/(?:build-home-assets|migrate-flat-topics-20261022|migrate-topic-slugs-20261023|migrate-topic-name-urls-20261026|migrate-topic-taxonomy-20261026|migrate-topic-summaries-20261026|migrate-topic-proposals-20261027|migrate-topic-proposal-reservations-20261029)\.mjs|ops\/topic-taxonomy-20261026\.json|(?:public|private)\/[a-zA-Z0-9_./-]+)$/.test(path)
    && !path.split('/').some(part => part === '..' || part === '.');
const hash = async path => { try { return createHash('sha256').update(await readFile(path)).digest('hex'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
async function guards() {
    if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw new Error('Duplicate release source');
    for (const file of manifest.files) {
        if (!validPath(file.path) || !/^[a-f0-9]{64}$/.test(file.after)
            || await hash(join(stage, 'payload', file.path)) !== file.after
            || await hash(join(root, file.path)) !== file.before) throw new Error('Release source changed: ' + file.path);
    }
    for (const file of manifest.sources) if (!validPath(file.path) || await hash(join(root, file.path)) !== file.before) {
        throw new Error('Concurrent dependency change: ' + file.path);
    }
}
function unitState(unit) {
    const output = execFileSync('systemctl', ['show', unit,
        '--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job'], { encoding: 'utf8' });
    const state = Object.fromEntries(output.trim().split('\n').map(line => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    if (state.LoadState !== 'loaded') throw new Error('Could not inspect service state: ' + unit);
    return state;
}
function call(path, body) {
    return new Promise((resolveCall, reject) => {
        const bytes = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = request('https://127.0.0.1:1337' + path, { rejectUnauthorized: false, timeout: 15000,
            method: bytes ? 'POST' : 'GET', headers: { Host: 'benchpoll.com',
                ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) } }, res => {
            let text = ''; res.setEncoding('utf8'); res.on('data', value => { text += value; });
            res.on('end', () => resolveCall({ status: res.statusCode, text }));
        });
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error('Release health timeout')));
        req.end(bytes);
    });
}
await guards();
execFileSync('systemctl', ['is-active', '--quiet', 'benchpoll.service']);
let databaseChanged = false, serviceStopped = false, scoreSyncTimerPaused = false, releaseSucceeded = false;
let result;
const changed = [];
try {
    const timer = unitState('benchpoll-score-sync.timer');
    if (!['active', 'inactive'].includes(timer.ActiveState) || timer.Job) throw new Error('Wait for the score timer state to settle');
    if (timer.ActiveState === 'active') {
        execFileSync('sudo', ['-n', 'systemctl', 'stop', 'benchpoll-score-sync.timer']);
        scoreSyncTimerPaused = true;
    }
    const sync = unitState('benchpoll-score-sync.service');
    if (!['inactive', 'failed'].includes(sync.ActiveState) || !['dead', 'failed'].includes(sync.SubState)
        || Number(sync.MainPID) !== 0 || Number(sync.ControlPID) !== 0 || sync.Job) {
        throw new Error('Wait for the active score import before releasing');
    }
    execFileSync('sudo', ['-n', 'systemctl', 'stop', 'benchpoll.service']); serviceStopped = true;
    await guards();
    execFileSync('/usr/bin/node', [join(stage, 'database.mjs'), stage, 'backup'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    // Failure after the first DDL may require database recovery; do not silently start old code.
    databaseChanged = true;
    const migration = execFileSync('/usr/bin/node', [join(manifest.candidate, 'scripts', migrationName),
        '--apply', '--backup-manifest=' + join(stage, 'database-backup.json')], {
        env: { ...process.env, DOTENV_CONFIG_PATH: join(root, '.env') }, timeout: 120000, encoding: 'utf8' });
    await writeFile(join(stage, 'migration-result.json'), migration, { mode: 0o600 });
    execFileSync('/usr/bin/node', [join(stage, 'database.mjs'), stage, 'verify-production'],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    await guards();
    for (const file of manifest.files) {
        const target = join(root, file.path), temporary = target + '.' + manifest.release + '.tmp';
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(stage, 'payload', file.path), temporary);
        if (file.mode) await chmod(temporary, file.mode);
        if (await hash(target) !== file.before) { await unlink(temporary); throw new Error('Concurrent replacement: ' + file.path); }
        await rename(temporary, target); changed.push(file.path);
    }
    execFileSync('sudo', ['-n', 'systemctl', 'start', 'benchpoll.service']); serviceStopped = false;
    let healthy = false;
    for (let attempt = 0; attempt < 15 && !healthy; attempt++) {
        await delay(1000);
        const response = await call('/').catch(() => null);
        healthy = response?.status === 200 && response.text.includes('topics-grid');
    }
    if (!healthy) throw new Error('New root page did not start');
    const catalogue = await call('/api/get_topics', {});
    const topics = JSON.parse(catalogue.text);
    if (catalogue.status !== 200 || topics.topics?.[0]?.ID !== 54) throw new Error('Topic catalogue health failed');
    const topic = await call(shortURLs ? topics.topics[0].url : '/topics/54/intelligence');
    if (topic.status !== 200 || !topic.text.includes('benchmark-card')) throw new Error('Topic workspace health failed');
    const ranking = await call('/api/get_topic_preview', { categoryID: 54 });
    const preview = JSON.parse(ranking.text);
    if (ranking.status !== 200 || !preview.weights?.length || !preview.models?.length) throw new Error('Featured ranking health failed');
    for (const file of manifest.files) if (await hash(join(root, file.path)) !== file.after) throw new Error('Installed bytes changed: ' + file.path);
    await writeFile(join(stage, 'released.json'), JSON.stringify({ release: manifest.release,
        releasedAt: new Date().toISOString(), files: changed.length, databaseChanged: true, healthy: true,
        topics: topics.topics.length, featuredModels: preview.pagination.total, codeBackup: manifest.backup,
        databaseBackup: join(stage, 'database-backup.json') }, null, 2), { mode: 0o600 });
    result = { release: manifest.release, healthy: true, files: changed.length, topics: topics.topics.length,
        codeBackup: manifest.backup, databaseBackupManifest: join(stage, 'database-backup.json') };
    releaseSucceeded = true;
} catch (error) {
    let recoveryError = null;
    if (databaseChanged && !serviceStopped) {
        try { execFileSync('sudo', ['-n', 'systemctl', 'stop', 'benchpoll.service']); serviceStopped = true; }
        catch (failure) { recoveryError = failure.message; }
    }
    if (!databaseChanged && serviceStopped) {
        try { execFileSync('sudo', ['-n', 'systemctl', 'start', 'benchpoll.service']); serviceStopped = false; }
        catch (failure) { recoveryError = failure.message; }
    }
    await writeFile(join(stage, 'release-failure.json'), JSON.stringify({ message: error.message,
        changed, databaseMayHaveChanged: databaseChanged, maintenance: serviceStopped,
        scoreSyncTimerPaused, recoveryError,
        recovery: 'Use the verified database-backup.json and code backup only after freezing other writers. Do not overwrite concurrent source changes.' }, null, 2), { mode: 0o600 });
    throw error;
} finally {
    if (scoreSyncTimerPaused && (releaseSucceeded || !databaseChanged)) {
        try {
            execFileSync('sudo', ['-n', 'systemctl', 'start', 'benchpoll-score-sync.timer']);
            scoreSyncTimerPaused = false;
        } catch (error) {
            await writeFile(join(stage, 'timer-restore-failure.json'), JSON.stringify({ message: error.message,
                releaseSucceeded, databaseMayHaveChanged: databaseChanged, scoreSyncTimerPaused: true }, null, 2), { mode: 0o600 });
            throw error;
        }
    }
}
console.log(JSON.stringify({ ...result, scoreSyncTimerRestored: !scoreSyncTimerPaused }));
