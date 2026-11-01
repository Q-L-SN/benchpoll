import { readFile, writeFile, mkdir, cp, copyFile, readdir, symlink, readlink, stat, lstat, unlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isSearchLegalPath } from './search-legal-paths-20261101.mjs';

const root = '/home/ubuntu/benchpoll';
const stage = resolve(process.argv[2] || '.');
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/(?:flat-topics-20261022\/topics-20261022|topics-polish-20261023\/topics-polish-20261023|topics-refinement-20261024\/topics-refinement-20261024|topics-interactions-20261025\/topics-interactions-20261025|topics-policy-20261026\/topics-policy-20261026|topics-taxonomy-20261026\/topics-taxonomy-20261026|topics-identity-ui-20261026\/topics-identity-ui-20261026|topics-account-20261027\/topics-account-20261027|topics-cleanup-20261028\/topics-cleanup-20261028|site-navigation-20261029\/site-navigation-20261029|audit-fixes-20261030\/audit-fixes-20261030|score-toolbar-20261030\/score-toolbar-20261030|community-fallback-20261030\/community-fallback-20261030|weight-treemap-20261031\/weight-treemap-20261031|benchmark-policy-20261031\/benchmark-policy-20261031|topic-scenes-20261031\/topic-scenes-20261031|fallback-choice-20261031\/fallback-choice-20261031|search-legal-20261101\/search-legal-20261101)-\d+$/.test(stage)) throw new Error('Unsafe staging path');
const uiOnly = stage.includes('/topics-refinement-20261024/');
const homeService = stage.includes('/topics-interactions-20261025/');
const accountFlow = stage.includes('/topics-account-20261027/');
const cleanup = stage.includes('/topics-cleanup-20261028/');
const siteNavigation = stage.includes('/site-navigation-20261029/');
const auditFixes = stage.includes('/audit-fixes-20261030/');
const scoreToolbar = stage.includes('/score-toolbar-20261030/');
const communityFallback = stage.includes('/community-fallback-20261030/');
const weightTreemap = stage.includes('/weight-treemap-20261031/');
const searchLegal = stage.includes('/search-legal-20261101/');
const benchmarkPolicy = stage.includes('/benchmark-policy-20261031/');
const fallbackChoice = stage.includes('/fallback-choice-20261031/');
const fallbackChoicePath = path => uiPath(path) || ['ranking-service.js', 'topic-home-service.js', 'scripts/migrate-fallback-choice-source-20261031.mjs'].includes(path);
const topicScenes = stage.includes('/topic-scenes-20261031/');
const sceneMigration = 'scripts/migrate-topic-scenes-20261031.mjs';
const scenePath = path => /^(?:[a-z0-9-]+\.js|scripts\/(?:migrate-topic-scenes(?:-taxonomy)?-20261031|check-ranking-integrity|delete-benchmarks-before-id)\.mjs|ops\/rehearse-topic-scenes-20261031\.mjs|ops\/topic-scenes-taxonomy-20261031\.json|public\/(?:js|css)\/[a-zA-Z0-9_./-]+|private\/[a-zA-Z0-9_-]+\.html)$/.test(path)
    && path.split('/').every(part => part && !part.startsWith('.'));
if (communityFallback && process.argv[2] !== stage) throw new Error('Unsafe community fallback staging path');
const communityMigration = 'scripts/migrate-community-fallback-20261030.mjs';
const communityDeletions = ['benchmark-version-preferences.js', 'public/js/workspace/version-group-dialog.js'];
const communityPath = path => typeof path === 'string'
    && /^(?:public\/(?:js\/[a-zA-Z0-9_./-]+\.js|css\/[a-zA-Z0-9_./-]+\.css|build\/[a-zA-Z0-9_./-]+\.(?:js|css))|private\/[a-zA-Z0-9_-]+\.html|private\/(?:home|index)-assets\.json|(?:server|ranking-service|benchmark-family-service)\.js|scripts\/migrate-community-fallback-20261030\.mjs)$/.test(path)
    && path.split('/').every(part => part && !part.startsWith('.'));
const assertAbsent = async path => {
    try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error('Deletion must be absent: ' + path);
};
const uiPath = path => /^(?:public\/(?:css|js|build)\/[a-zA-Z0-9_./-]+|private\/(?:(?:home|index)(?:\.html|-built\.html|-assets\.json)|how-it-works\.html))$/.test(path)
    && !path.split('/').some(part => part.startsWith('.'));
const benchmarkPolicyPath = path => uiPath(path)
    || ['benchmark-details.js', 'benchmark-scores.js', 'ranking-service.js', 'server.js', 'aa-archive-policy.js'].includes(path);
const accountPath = path => uiPath(path) || /^(?:server|privacy-controls|privacy-headers|topic-service|topic-proposal-service|public-topic-review|ranking-service|benchmark-version-preferences|topic-home-service|moderation-email|user-profile-service|discussion-service)\.js$/.test(path)
    || /^private\/(?:sign-in|loginCallback|account-privacy|terms|privacy|topic-proposals|dialogPage)\.html$/.test(path)
    || /^scripts\/(?:migrate-(?:topic-proposals|public-github-profile)-20261027|migrate-topic-proposal-limits-20261028)\.mjs$/.test(path);
const cleanupPath = path => uiPath(path)
    || /^(?:server|privacy-controls|privacy-headers|moderation-admin|ranking-service|ranking-pagination|ranking-cache-schema|topic-home-service)\.js$/.test(path)
    || /^private\/(?:sign-in|account-privacy|terms|privacy|contribute)\.html$/.test(path)
    || path === 'scripts/import-arena-latest.mjs';
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
async function runtimeHash(directory) {
    let current = '/';
    for (const part of resolve(directory).split('/').filter(Boolean)) {
        current = join(current, part);
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked runtime directory: ' + current);
    }
    const entries = [];
    async function visit(path, prefix = '') {
        for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
            const full = join(path, item.name), key = prefix + item.name;
            if (item.isSymbolicLink()) {
                const target = await readlink(full);
                if (!resolve(dirname(full), target).startsWith(resolve(directory) + '/')) throw new Error('External runtime symlink');
                entries.push([key, 'link', target]);
            } else if (item.isDirectory()) { entries.push([key, 'directory']); await visit(full, key + '/'); }
            else if (item.isFile()) entries.push([key, 'file', await hash(full)]);
            else throw new Error('Unsupported runtime entry');
        }
    }
    await visit(directory);
    return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
const existingHash = async path => { try { return await hash(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const valid = path => /^(?:[a-z0-9-]+\.js|scripts\/(?:build-home-assets|import-arena-latest|migrate-flat-topics-20261022|migrate-topic-slugs-20261023|migrate-topic-name-urls-20261026|migrate-topic-taxonomy-20261026|migrate-topic-summaries-20261026|migrate-topic-proposals-20261027|migrate-public-github-profile-20261027|migrate-topic-proposal-limits-20261028|migrate-topic-proposal-reservations-20261029)\.mjs|ops\/topic-taxonomy-20261026\.json|(?:public|private)\/[a-zA-Z0-9_./-]+)$/.test(path)
    && !path.split('/').some(part => part === '..' || part === '.') && !path.endsWith('/');
const request = JSON.parse(await readFile(join(stage, 'request.json'), 'utf8'));
if (searchLegal && (request.migration !== null || !Array.isArray(request.files)
    || request.files.some(file => !isSearchLegalPath(file.path)))) throw new Error('Unsafe search-legal manifest');
if (fallbackChoice && (request.migration !== 'migrate-fallback-choice-source-20261031.mjs' || !Array.isArray(request.files)
    || !request.files.some(file => file.path === 'scripts/' + request.migration)
    || request.files.some(file => !fallbackChoicePath(file.path)))) throw new Error('Unsafe fallback-choice manifest');
if (topicScenes && (request.migration !== 'migrate-topic-scenes-20261031.mjs' || !Array.isArray(request.files)
    || request.taxonomyMigration !== 'migrate-topic-scenes-taxonomy-20261031.mjs'
    || !request.files.some(file => file.path === 'scripts/' + request.taxonomyMigration)
    || !request.files.some(file => file.path === 'ops/topic-scenes-taxonomy-20261031.json')
    || !request.files.some(file => file.path === sceneMigration) || request.files.some(file => !scenePath(file.path)))) {
    throw new Error('Unsafe topic-scenes manifest');
}
if (weightTreemap && (request.migration !== null || !Array.isArray(request.files)
    || request.files.some(file => !uiPath(file.path)))) throw new Error('Unsafe weight-treemap manifest');
if (benchmarkPolicy && (request.migration !== null || !Array.isArray(request.files)
    || request.files.some(file => !benchmarkPolicyPath(file.path)))) throw new Error('Unsafe benchmark-policy manifest');
if (!Array.isArray(request.files) || new Set(request.files.map(file => file.path)).size !== request.files.length
    || request.files.some(file => !(valid(file.path) || fallbackChoice && fallbackChoicePath(file.path) || communityFallback && file.path === communityMigration || topicScenes && scenePath(file.path))
        || !(communityFallback && communityDeletions.includes(file.path) && file.after === null || /^[a-f0-9]{64}$/.test(file.after))
        || (uiOnly || homeService) && !uiPath(file.path) && !(homeService && file.path === 'topic-home-service.js'))
    || accountFlow && request.files.some(file => !accountPath(file.path))
    || siteNavigation && request.files.some(file => !accountPath(file.path))
    || scoreToolbar && request.files.some(file => !uiPath(file.path) && !['pairwise-score.js', 'privacy-headers.js'].includes(file.path))
    || auditFixes && (request.migration !== 'migrate-topic-proposal-reservations-20261029.mjs'
        || request.files.some(file => !accountPath(file.path) && !['pairwise-score.js', 'topic-popularity.js',
            'scripts/migrate-topic-proposal-reservations-20261029.mjs'].includes(file.path)))
    || cleanup && request.files.some(file => !cleanupPath(file.path))
    || (uiOnly || homeService || accountFlow || cleanup || siteNavigation || scoreToolbar) && request.migration !== null) throw new Error('Unsafe release manifest');
if (communityFallback && (request.migration !== 'migrate-community-fallback-20261030.mjs'
    || !request.files.some(file => file.path === communityMigration)
    || communityDeletions.some(path => !request.files.some(file => file.path === path && file.after === null))
    || request.files.some(file => file.after === null ? !communityDeletions.includes(file.path) : !communityPath(file.path)))) {
    throw new Error('Unsafe community fallback manifest');
}
if (communityFallback) for (const path of communityDeletions) await assertAbsent(join(stage, 'payload', path));
const mode = process.argv[3] || 'capture';
if (mode === 'capture') {
    await mkdir(join(stage, 'baseline'), { recursive: !communityFallback });
    const files = [];
    for (const file of request.files) {
        const before = await existingHash(join(root, file.path));
        if (communityFallback && file.after === null && before === null) throw new Error('Missing live deletion: ' + file.path);
        files.push({ ...file, before });
        if (before !== null) {
            await mkdir(dirname(join(stage, 'baseline', file.path)), { recursive: true });
            await copyFile(join(root, file.path), join(stage, 'baseline', file.path));
            if (communityFallback && (await hash(join(stage, 'baseline', file.path)) !== before
                || await existingHash(join(root, file.path)) !== before)) throw new Error('Changed during capture: ' + file.path);
        }
    }
    await writeFile(join(stage, 'capture.json'), JSON.stringify({ files }, null, 2), communityFallback ? { flag: 'wx' } : {});
    execFileSync('tar', ['-czf', join(stage, 'production-snapshot.tar.gz'), '-C', stage, 'capture.json', 'baseline']);
    console.log(JSON.stringify({ captured: files.length, concurrentDifferences: files.filter(file => file.before !== file.baseline && file.before !== file.after).map(file => file.path) }));
} else if (mode === 'prepare') {
    const captured = JSON.parse(await readFile(join(stage, 'capture.json'), 'utf8'));
    if (communityFallback && (!Array.isArray(captured.files) || captured.files.length !== request.files.length
        || new Set(captured.files.map(file => file.path)).size !== captured.files.length)) throw new Error('Unsafe captured manifest');
    const files = request.files.map(file => {
        const old = captured.files.find(row => row.path === file.path);
        if (!old) throw new Error('Missing captured source: ' + file.path);
        if (communityFallback && (old.after !== file.after || !(old.before === null || /^[a-f0-9]{64}$/.test(old.before))
            || file.after === null && old.before === null)) throw new Error('Invalid captured source: ' + file.path);
        return { ...file, before: old.before };
    });
    for (const file of files) {
        if (file.after === null) await assertAbsent(join(stage, 'payload', file.path));
        if (file.after !== null && await hash(join(stage, 'payload', file.path)) !== file.after
            || await existingHash(join(root, file.path)) !== file.before) throw new Error('Source changed: ' + file.path);
    }
    const candidate = join(stage, 'candidate');
    await mkdir(candidate, { recursive: !communityFallback });
    for (const entry of await readdir(root)) if (entry.endsWith('.js') || entry === 'package.json') await copyFile(join(root, entry), join(candidate, entry));
    let runtime;
    if (topicScenes) {
        const before = await runtimeHash(join(root, 'node_modules'));
        await cp(join(root, 'node_modules'), join(candidate, 'node_modules'), { recursive: true, verbatimSymlinks: true });
        await copyFile(join(root, 'package-lock.json'), join(candidate, 'package-lock.json'));
        if (await runtimeHash(join(candidate, 'node_modules')) !== before
            || await runtimeHash(join(root, 'node_modules')) !== before) throw new Error('Runtime changed during snapshot');
        runtime = { sha256: before };
    }
    await cp(join(root, 'public'), join(candidate, 'public'), { recursive: true });
    await cp(join(root, 'private'), join(candidate, 'private'), { recursive: true });
    await mkdir(join(candidate, 'scripts'), { recursive: true });
    const buildScript = 'scripts/build-home-assets.mjs';
    await copyFile(join(root, buildScript), join(candidate, buildScript));
    const buildScriptHash = await hash(join(candidate, buildScript));
    const migrationDependency = topicScenes || communityFallback || accountFlow || auditFixes || ['migrate-topic-name-urls-20261026.mjs', 'migrate-topic-taxonomy-20261026.mjs', 'migrate-topic-summaries-20261026.mjs'].includes(request.migration) ? 'scripts/migrate-topic-slugs-20261023.mjs' : null;
    let migrationDependencyHash;
    if (migrationDependency) {
        await copyFile(join(root, migrationDependency), join(candidate, migrationDependency));
        migrationDependencyHash = await hash(join(candidate, migrationDependency));
    }
    const taxonomyDependency = topicScenes ? 'ops/topic-taxonomy-20261026.json' : null;
    let taxonomyDependencyHash;
    if (taxonomyDependency) {
        await mkdir(join(candidate, 'ops'), { recursive: true });
        await copyFile(join(root, taxonomyDependency), join(candidate, taxonomyDependency));
        taxonomyDependencyHash = await hash(join(candidate, taxonomyDependency));
    }
    const proposalDependency = accountFlow ? 'scripts/migrate-topic-proposals-20261027.mjs' : null;
    let proposalDependencyHash;
    if (proposalDependency && !files.some(file => file.path === proposalDependency)) {
        await copyFile(join(root, proposalDependency), join(candidate, proposalDependency));
        proposalDependencyHash = await hash(join(candidate, proposalDependency));
    }
    for (const name of ['node_modules', '.env', 'server.key', 'server.crt']) {
        if (topicScenes && name === 'node_modules') continue;
        const target = join(candidate, name);
        try { await symlink(join(root, name), target); }
        catch (error) { if (error.code !== 'EEXIST' || await readlink(target) !== join(root, name)) throw error; }
    }
    for (const file of files) {
        if (file.after === null) {
            if (await hash(join(candidate, file.path)) !== file.before) throw new Error('Changed candidate deletion: ' + file.path);
            await unlink(join(candidate, file.path));
            continue;
        }
        await mkdir(dirname(join(candidate, file.path)), { recursive: true });
        await copyFile(join(stage, 'payload', file.path), join(candidate, file.path));
    }
    const buildTools = join(stage, 'build-tools');
    await mkdir(buildTools, { recursive: true });
    const buildDependencies = '/home/ubuntu/benchpoll/scripts/available-score-upgrade-20261012/release/build-tools/node_modules';
    try { await symlink(buildDependencies, join(buildTools, 'node_modules')); }
    catch (error) { if (error.code !== 'EEXIST' || await readlink(join(buildTools, 'node_modules')) !== buildDependencies) throw error; }
    await copyFile(join(candidate, 'scripts/build-home-assets.mjs'), join(buildTools, 'build-home-assets.mjs'));
    const { buildHomeAssets } = await import(join(buildTools, 'build-home-assets.mjs'));
    const builds = [await buildHomeAssets(candidate), await buildHomeAssets(candidate, { pageName: 'index' })];
    const sources = new Map();
    if (topicScenes) for (const path of ['package.json', 'package-lock.json']) {
        const before = await hash(join(candidate, path));
        if (await hash(join(root, path)) !== before) throw new Error('Concurrent package change');
        sources.set(path, before);
    }
    if (communityFallback) for (const path of ['package.json', 'public/js/shared/topics.js']) {
        if (files.some(file => file.path === path)) continue;
        const before = await hash(join(candidate, path));
        if (await hash(join(root, path)) !== before) throw new Error('Concurrent migration source change: ' + path);
        sources.set(path, before);
    }
    if (proposalDependencyHash) {
        if (await hash(join(root, proposalDependency)) !== proposalDependencyHash) throw new Error('Concurrent proposal schema dependency change');
        sources.set(proposalDependency, proposalDependencyHash);
    }
    if (migrationDependency) {
        if (await hash(join(root, migrationDependency)) !== migrationDependencyHash) throw new Error('Concurrent migration dependency change');
        sources.set(migrationDependency, migrationDependencyHash);
    }
    if (taxonomyDependency) {
        if (await hash(join(root, taxonomyDependency)) !== taxonomyDependencyHash) throw new Error('Concurrent taxonomy dependency change');
        sources.set(taxonomyDependency, taxonomyDependencyHash);
    }
    if (!files.some(file => file.path === buildScript)) {
        if (await hash(join(root, buildScript)) !== buildScriptHash) throw new Error('Concurrent build tool change');
        sources.set(buildScript, buildScriptHash);
    }
    for (const build of builds) for (const source of build.sources) {
        if (communityFallback && communityDeletions.includes(source.path)) throw new Error('Build references deleted source: ' + source.path);
        if (files.some(file => file.path === source.path)) continue;
        if (await hash(join(root, source.path)) !== source.sha256) throw new Error('Concurrent build source: ' + source.path);
        sources.set(source.path, source.sha256);
    }
    for (const entry of await readdir(root)) if (entry.endsWith('.js') && !files.some(file => file.path === entry)) sources.set(entry, await hash(join(root, entry)));
    for (const path of [...new Set(builds.flatMap(build => build.files)), 'private/home-assets.json', 'private/index-assets.json']) {
        if (communityFallback && (!communityPath(path) || files.some(file => file.path === path))) throw new Error('Unsafe generated output: ' + path);
        const before = await existingHash(join(root, path)), after = await hash(join(candidate, path));
        if (before === after) continue;
        await mkdir(dirname(join(stage, 'payload', path)), { recursive: true });
        await copyFile(join(candidate, path), join(stage, 'payload', path));
        files.push({ path, before, after });
    }
    for (const file of files) if (file.after !== null && /\.m?js$/.test(file.path)) execFileSync('/usr/bin/node', ['--check', join(candidate, file.path)]);
    const backup = join('/home/ubuntu/benchpoll-code-backups', stage.split('/').at(-1));
    await mkdir(backup, { recursive: !communityFallback, mode: 0o700 });
    for (const file of files) if (file.before !== null) {
        await mkdir(dirname(join(backup, file.path)), { recursive: true });
        if (await hash(join(root, file.path)) !== file.before) throw new Error('Changed before code backup: ' + file.path);
        await copyFile(join(root, file.path), join(backup, file.path));
        file.mode = (await stat(join(root, file.path))).mode;
        if (communityFallback && await hash(join(backup, file.path)) !== file.before) throw new Error('Code backup mismatch: ' + file.path);
    }
    if (communityFallback) {
        for (const file of files) {
            if (await existingHash(join(root, file.path)) !== file.before) throw new Error('Changed after code backup: ' + file.path);
            if (file.after === null) {
                await assertAbsent(join(candidate, file.path));
                await assertAbsent(join(stage, 'payload', file.path));
            } else if (await hash(join(candidate, file.path)) !== file.after
                || await hash(join(stage, 'payload', file.path)) !== file.after) throw new Error('Prepared file changed: ' + file.path);
        }
        for (const [path, before] of sources) if (await hash(join(root, path)) !== before
            || await hash(join(candidate, path)) !== before) throw new Error('Prepared source changed: ' + path);
    }
    const manifest = { release: stage.split('/').at(-1), migration: request.migration,
        ...(topicScenes ? { taxonomyMigration: request.taxonomyMigration } : {}), ...(runtime ? { runtime } : {}),
        files, sources: [...sources].map(([path, before]) => ({ path, before })), candidate, backup };
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), communityFallback ? { flag: 'wx' } : {});
    await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), communityFallback ? { flag: 'wx' } : {});
    console.log(JSON.stringify({ prepared: true, candidate, files: files.length, sources: sources.size, backup }));
} else throw new Error('Unknown stage operation');
