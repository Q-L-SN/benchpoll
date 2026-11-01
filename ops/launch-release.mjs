import { readFile, writeFile, mkdir, copyFile, rename, stat, chmod, unlink, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { isSearchLegalPath } from './search-legal-paths-20261101.mjs';

const stage = resolve(process.argv?.[2] ?? process.cwd());
const root = '/home/ubuntu/benchpoll';
const manifest = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'));
if (!/^(?:launch-20261008|available-20261012|ui-discussion-20261012|charts-20261012|showcase-20261012|topics-refinement-20261024|topics-interactions-20261025|topics-account-20261027|topics-cleanup-20261028|site-navigation-20261029|score-toolbar-20261030|weight-treemap-20261031|benchmark-policy-20261031|fallback-choice-20261031|search-legal-20261101)-[0-9]+$/.test(manifest.release)) throw new Error('Invalid release');
const uiOnly = manifest.release.startsWith('topics-refinement-20261024-');
const homeService = manifest.release.startsWith('topics-interactions-20261025-');
const accountFlow = manifest.release.startsWith('topics-account-20261027-');
const cleanup = manifest.release.startsWith('topics-cleanup-20261028-');
const siteNavigation = manifest.release.startsWith('site-navigation-20261029-');
const scoreToolbar = manifest.release.startsWith('score-toolbar-20261030-');
const weightTreemap = manifest.release.startsWith('weight-treemap-20261031-');
const benchmarkPolicy = manifest.release.startsWith('benchmark-policy-20261031-');
const fallbackChoice = manifest.release.startsWith('fallback-choice-20261031-');
const searchLegal = manifest.release.startsWith('search-legal-20261101-');
const boundedPause = uiOnly || homeService || accountFlow || cleanup || siteNavigation || scoreToolbar || weightTreemap || benchmarkPolicy || fallbackChoice || searchLegal;
if (searchLegal && (stage !== root + '/scripts/search-legal-20261101/' + manifest.release
    || manifest.candidate !== join(stage, 'candidate') || manifest.migration !== null
    || manifest.files.some(file => !isSearchLegalPath(file.path)))) throw new Error('Invalid search-legal release');
if (benchmarkPolicy && (stage !== root + '/scripts/benchmark-policy-20261031/' + manifest.release
    || manifest.candidate !== join(stage, 'candidate') || manifest.migration !== null)) throw new Error('Invalid benchmark-policy release');
if (weightTreemap && (stage !== root + '/scripts/weight-treemap-20261031/' + manifest.release
    || manifest.candidate !== join(stage, 'candidate') || manifest.migration !== null)) throw new Error('Invalid weight-treemap release');
if (uiOnly && (stage !== root + '/scripts/topics-refinement-20261024/' + manifest.release
    || manifest.candidate !== join(stage, 'candidate') || manifest.migration !== null)) throw new Error('Invalid UI-only release');
if (homeService && (stage !== root + '/scripts/topics-interactions-20261025/' + manifest.release
    || manifest.candidate !== join(stage, 'candidate') || manifest.migration !== null)) throw new Error('Invalid home-service release');
if (accountFlow && (stage !== root + '/scripts/topics-account-20261027/' + manifest.release
    || manifest.candidate !== join(stage, 'candidate') || manifest.migration !== null)) throw new Error('Invalid account release');
if (cleanup && (stage !== root + '/scripts/topics-cleanup-20261028/' + manifest.release
    || manifest.candidate !== join(stage, 'candidate') || manifest.migration !== null)) throw new Error('Invalid cleanup release');
if (siteNavigation && (stage !== root + '/scripts/site-navigation-20261029/' + manifest.release
    || manifest.candidate !== join(stage, 'candidate') || manifest.migration !== null)) throw new Error('Invalid site navigation release');
if (scoreToolbar && (stage !== root + '/scripts/score-toolbar-20261030/' + manifest.release
    || manifest.candidate !== join(stage, 'candidate') || manifest.migration !== null)) throw new Error('Invalid score-toolbar release');
if (accountFlow) {
    const schema = JSON.parse(await readFile(join(stage, 'schema-result.json'), 'utf8'));
    if (schema.release !== manifest.release || schema.applied !== true || schema.protectedDataUnchanged !== true
        || !schema.schema?.profileColumns?.includes('github_username')
        || !schema.schema?.profileColumns?.includes('show_github_profile')
        || !['topic_proposals', 'topic_proposal_votes'].every(table => schema.schema?.proposalTables?.includes(table))
        || !['revision', 'withdrawn_at'].every(column => schema.schema?.proposalColumns?.includes(column))) {
        throw new Error('Account schema preparation required');
    }
}
if (fallbackChoice) {
    const schema = JSON.parse(await readFile(join(stage, 'schema-result.json'), 'utf8'));
    if (stage !== root + '/scripts/fallback-choice-20261031/' + manifest.release
        || manifest.candidate !== join(stage, 'candidate') || manifest.migration !== 'migrate-fallback-choice-source-20261031.mjs'
        || schema.release !== manifest.release || schema.applied !== true || schema.protectedDataUnchanged !== true
        || schema.manifestHash !== createHash('sha256').update(await readFile(join(stage, 'manifest.json'))).digest('hex')) {
        throw new Error('Verified fallback-choice schema preparation required');
    }
}
const payload = boundedPause ? join(stage, 'payload') : stage;
const backup = join('/home/ubuntu/benchpoll-code-backups', manifest.release);
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const existingHash = async path => {
    try { return await hash(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const paths = new Set();
const uiPath = path => /^(?:public\/(?:css|js|build)\/[a-zA-Z0-9_./-]+|private\/(?:(?:home|index)(?:\.html|-built\.html|-assets\.json)|how-it-works\.html))$/.test(path)
    && !path.split('/').some(part => part.startsWith('.'));
const fallbackChoicePath = path => uiPath(path) || ['ranking-service.js', 'topic-home-service.js', 'scripts/migrate-fallback-choice-source-20261031.mjs'].includes(path);
const benchmarkPolicyPath = path => uiPath(path)
    || ['benchmark-details.js', 'benchmark-scores.js', 'ranking-service.js', 'server.js', 'aa-archive-policy.js'].includes(path);
const accountPath = path => uiPath(path) || /^(?:server|privacy-controls|privacy-headers|topic-service|topic-proposal-service|public-topic-review|ranking-service|benchmark-version-preferences|topic-home-service|moderation-email|user-profile-service|discussion-service)\.js$/.test(path)
    || /^private\/(?:sign-in|loginCallback|account-privacy|terms|privacy|topic-proposals|dialogPage)\.html$/.test(path)
    || /^scripts\/(?:migrate-(?:topic-proposals|public-github-profile)-20261027|migrate-topic-proposal-limits-20261028)\.mjs$/.test(path);
const cleanupPath = path => uiPath(path)
    || /^(?:server|privacy-controls|privacy-headers|moderation-admin|ranking-service|ranking-pagination|ranking-cache-schema|topic-home-service)\.js$/.test(path)
    || /^private\/(?:sign-in|account-privacy|terms|privacy|contribute)\.html$/.test(path)
    || path === 'scripts/import-arena-latest.mjs';
for (const file of manifest.files) {
    if (!(searchLegal && isSearchLegalPath(file.path)) && !(fallbackChoice && fallbackChoicePath(file.path)) && !(benchmarkPolicy && benchmarkPolicyPath(file.path)) && !/^(?:server\.js|db\.js|db-transaction\.js|db-deadlines\.js|moderation-admin\.js|moderation-email\.js|privacy-controls\.js|privacy-headers\.js|ranking-service\.js|ranking-cache-schema\.js|ranking-read-cache\.js|pairwise-score\.js|navigation-service\.js|comparison-profiles\.js|benchmark-scores\.js|benchmark-version-preferences\.js|arena-sync\.js|arena-sync-conflicts\.js|score-sync-service\.js|ranking-pagination\.js|score-field-service\.js|model-comparison\.js|model-run-configuration\.js|topic-home-service\.js|topic-service\.js|topic-proposal-service\.js|public-topic-review\.js|user-profile-service\.js|score-condition-normalization\.js|run-field-preset-migration\.js|discussion-service\.js|private-category-service\.js|write-idempotency\.js|scripts\/(?:migrate-write-requests|import-arena-latest|register-score-sync|run-score-sync|import-scale-official|import-top16-official|migrate-run-field-presets-20261013|migrate-privacy-controls|migrate-topic-proposals-20261027|migrate-public-github-profile-20261027|migrate-topic-proposal-limits-20261028|check-moderation-email)\.mjs|(?:public|private)\/[a-zA-Z0-9_./-]+)$/.test(file.path)
        || file.path.split('/').includes('..') || paths.has(file.path) || (uiOnly || weightTreemap) && !uiPath(file.path)
        || homeService && !uiPath(file.path) && file.path !== 'topic-home-service.js'
        || benchmarkPolicy && !benchmarkPolicyPath(file.path) || fallbackChoice && !fallbackChoicePath(file.path)
        || (accountFlow || siteNavigation) && !accountPath(file.path) || cleanup && !cleanupPath(file.path)
        || scoreToolbar && !uiPath(file.path) && !['pairwise-score.js', 'privacy-headers.js'].includes(file.path)) throw new Error('Unsafe release path');
    paths.add(file.path);
    if (await hash(resolve(payload, file.path)) !== file.after) throw new Error(`Stage mismatch: ${file.path}`);
    if (await existingHash(resolve(root, file.path)) !== file.before) throw new Error(`Production changed: ${file.path}`);
}
async function verifyBuildSources() {
    for (const source of manifest.sources ?? []) {
        const valid = /^(?:public|private)\/[a-zA-Z0-9_./-]+$/.test(source.path)
            || boundedPause && /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.js|scripts\/build-home-assets\.mjs)$/.test(source.path)
            || accountFlow && ['scripts/migrate-topic-slugs-20261023.mjs', 'scripts/migrate-topic-proposals-20261027.mjs'].includes(source.path);
        if (!valid || source.path.split('/').some(part => part === '..' || part === '.')
            || await existingHash(resolve(root, source.path)) !== source.before) throw new Error('Build source changed: ' + source.path);
    }
}
await verifyBuildSources();
if (accountFlow || cleanup || siteNavigation || scoreToolbar || weightTreemap || benchmarkPolicy || fallbackChoice || searchLegal) {
    for (const directory of new Set([...paths].map(path => dirname(join(root, path))))) {
        let parent = directory;
        for (;;) {
            try { await access(parent, 2); break; }
            catch (error) {
                if (error.code !== 'ENOENT' || parent === root) throw error;
                parent = dirname(parent);
            }
        }
    }
}
const restartRequired = !boundedPause && [...paths].some(path => !path.includes('/'));
for (const path of paths) {
    if (/\.m?js$/.test(path)) execFileSync('/usr/bin/node', ['--check', join(payload, path)]);
}
execFileSync('systemctl', ['is-active', '--quiet', 'benchpoll.service']);
await mkdir(backup, { recursive: true });
await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2));
for (const file of manifest.files) {
    if (file.before === null) continue;
    await mkdir(dirname(join(backup, file.path)), { recursive: true });
    await copyFile(join(root, file.path), join(backup, file.path));
    file.mode = (await stat(join(root, file.path))).mode;
}
async function install(source, destination, mode, expected) {
    const temporary = `${destination}.${manifest.release}.tmp`;
    await copyFile(source, temporary);
    if (mode) await chmod(temporary, mode);
    if (await existingHash(destination) !== expected) {
        await unlink(temporary);
        throw Object.assign(new Error(`Production changed before replacement: ${destination}`), {
            code: 'RELEASE_CONCURRENT_CHANGE'
        });
    }
    await rename(temporary, destination);
}
function health() {
    return new Promise((resolveHealth, reject) => {
        const req = request('https://127.0.0.1:1337' + (boundedPause ? '/' : '/Intelligence'), { rejectUnauthorized: false, timeout: 5000,
            headers: { Host: 'benchpoll.com' } }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', data => { body += data; });
            res.on('end', () => resolveHealth(res.statusCode === 200 && body.includes('BenchPoll')
                && (!boundedPause || body.includes('topics-grid')
                    && body.includes(cleanup || siteNavigation || scoreToolbar || weightTreemap || benchmarkPolicy || fallbackChoice || searchLegal ? 'topics-navigation' : 'th-directory-dock'))));
        });
        req.on('timeout', () => req.destroy(new Error('Health timeout')));
        req.on('error', reject); req.end();
    });
}
const changed = [];
let paused = false;
try {
    await verifyBuildSources();
    if (boundedPause) {
        execFileSync('sudo', ['-n', 'systemctl', 'stop', 'benchpoll.service']); paused = true;
        for (const file of manifest.files) if (await existingHash(join(root, file.path)) !== file.before) throw new Error('Production changed before pause: ' + file.path);
        await verifyBuildSources();
    }
    for (const file of manifest.files) {
        await mkdir(dirname(join(root, file.path)), { recursive: true });
        await install(join(payload, file.path), join(root, file.path), file.mode, file.before);
        changed.push(file);
    }
    if (boundedPause) { execFileSync('sudo', ['-n', 'systemctl', 'start', 'benchpoll.service']); paused = false; }
    if (restartRequired) execFileSync('sudo', ['systemctl', 'restart', 'benchpoll.service']);
    let healthy = false;
    for (let attempt = 0; attempt < 12 && !healthy; attempt++) {
        await delay(1000);
        healthy = await health().catch(() => false);
    }
    if (!healthy) throw new Error('Post-release health failed');
    await verifyBuildSources();
    for (const file of manifest.files) {
        if (await hash(join(root, file.path)) !== file.after) throw new Error(`Installed hash mismatch: ${file.path}`);
    }
    const result = { release: manifest.release, backup, files: manifest.files.length, healthy: true, databaseChanged: fallbackChoice,
        ...(boundedPause ? { uiOnly, homeService, accountFlow, cleanup, siteNavigation, scoreToolbar, weightTreemap, benchmarkPolicy, fallbackChoice, searchLegal, scoreTimerTouched: false, releasedAt: new Date().toISOString() } : {}) };
    if (boundedPause) await writeFile(join(stage, 'released.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
} catch (error) {
    const conflicts = [], failures = [];
    let restored = 0;
    if (boundedPause && !paused && changed.length) {
        try { execFileSync('sudo', ['-n', 'systemctl', 'stop', 'benchpoll.service']); paused = true; }
        catch (stopError) { failures.push('Rollback pause: ' + stopError.message); }
    }
    for (const file of changed.reverse()) {
        try {
            // Never restore or remove bytes another deployment has since replaced.
            if (await existingHash(join(root, file.path)) !== file.after) {
                conflicts.push(file.path);
                continue;
            }
            if (file.before === null) await unlink(join(root, file.path));
            else await install(join(backup, file.path), join(root, file.path), file.mode, file.after);
            restored++;
        } catch (rollbackError) {
            if (rollbackError.code === 'RELEASE_CONCURRENT_CHANGE') conflicts.push(file.path);
            else failures.push(`${file.path}: ${rollbackError.message}`);
        }
    }
    if (restartRequired && restored > 0) {
        try { execFileSync('sudo', ['systemctl', 'restart', 'benchpoll.service']); }
        catch (restartError) { failures.push(`Rollback restart: ${restartError.message}`); }
    }
    if (boundedPause && paused) {
        try { execFileSync('sudo', ['-n', 'systemctl', 'start', 'benchpoll.service']); paused = false; }
        catch (startError) { failures.push('Rollback start: ' + startError.message); }
    }
    const details = [conflicts.length ? `Concurrent changes preserved: ${conflicts.join(', ')}` : '',
        failures.length ? `Rollback failures: ${failures.join('; ')}` : ''].filter(Boolean).join('; ');
    const message = `Release failed: ${error.message}; restored ${restored} file(s)${details ? '; ' + details : ''}`;
    if (boundedPause) await writeFile(join(stage, 'release-failure.json'), JSON.stringify({ message, conflicts, failures,
        maintenance: paused, databaseChanged: false, scoreTimerTouched: false }, null, 2));
    throw new Error(message);
}
