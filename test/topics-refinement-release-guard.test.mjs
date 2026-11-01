import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const launcher = fileURLToPath(new URL('../ops/launch-release.mjs', import.meta.url));
const harness = String.raw`
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { posix } from 'node:path';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
const scenario = JSON.parse(process.env.UI_RELEASE_SCENARIO);
const source = await readFile(process.env.UI_RELEASE_SOURCE, 'utf8');
const prefix = scenario.searchLegal ? 'search-legal-20261101' : scenario.benchmarkPolicy ? 'benchmark-policy-20261031' : scenario.weightTreemap ? 'weight-treemap-20261031' : scenario.scoreToolbar ? 'score-toolbar-20261030' : scenario.cleanup ? 'topics-cleanup-20261028' : scenario.accountFlow ? 'topics-account-20261027' : scenario.homeService ? 'topics-interactions-20261025' : 'topics-refinement-20261024';
const root = '/home/ubuntu/benchpoll', release = prefix + '-1';
const stage = root + '/scripts/' + prefix + '/' + release;
const relative = scenario.path ?? 'public/js/topics-home.js', target = root + '/' + relative;
const original = Buffer.from('original UI'), candidate = Buffer.from('candidate UI'), foreign = Buffer.from('other task UI');
const dependency = Buffer.from('unchanged server');
const sha = value => createHash('sha256').update(value).digest('hex');
const manifest = { release, migration: scenario.migration ?? null, candidate: stage + '/candidate',
    files: [{ path: relative, before: scenario.newFile ? null : sha(original), after: sha(candidate) }],
    sources: [{ path: 'ranking-read-cache.js', before: sha(dependency) }] };
if (scenario.badCandidate) manifest.candidate = root;
if (scenario.duplicate) manifest.files.push({ ...manifest.files[0] });
const files = new Map([[stage + '/manifest.json', Buffer.from(JSON.stringify(manifest))],
    [stage + '/payload/' + relative, candidate], [root + '/ranking-read-cache.js', scenario.dependencyChanged ? foreign : dependency]]);
if (scenario.accountFlow && !scenario.missingSchema) files.set(stage + '/schema-result.json', Buffer.from(JSON.stringify({
    release: scenario.wrongSchemaRelease ? 'another-release' : release,
    applied: true, protectedDataUnchanged: !scenario.schemaChangedData,
    schema: { profileColumns: ['github_username', 'show_github_profile'],
        proposalColumns: scenario.missingLimitColumns ? [] : ['revision', 'withdrawn_at'],
        proposalTables: scenario.incompleteSchema ? ['topic_proposals'] : ['topic_proposals', 'topic_proposal_votes'] }
})));
if (scenario.schemaDependency) {
    manifest.sources.push({ path: 'scripts/migrate-topic-slugs-20261023.mjs', before: sha(dependency) });
    files.set(root + '/scripts/migrate-topic-slugs-20261023.mjs', dependency);
    files.set(stage + '/manifest.json', Buffer.from(JSON.stringify(manifest)));
}
if (!scenario.newFile) files.set(target, original);
const missing = name => Object.assign(new Error('Missing fixture file: ' + name), { code: 'ENOENT' });
const bytes = name => { if (!files.has(name)) throw missing(name); return files.get(name); };
const events = [], output = [];
let active = true, observed;
const fs = {
    async readFile(name, encoding) { const value = bytes(name); return encoding ? value.toString(encoding) : value; },
    async access(_name, mode) {
        assert.equal(mode, 2);
        if (scenario.unwritable) throw Object.assign(new Error('Unwritable destination'), { code: 'EACCES' });
    },
    async mkdir() {}, async chmod() {}, async stat() { return { mode: 0o644 }; },
    async writeFile(name, value) { files.set(name, Buffer.from(value)); },
    async copyFile(from, to) {
        files.set(to, Buffer.from(bytes(from)));
        if (scenario.beforeInstall && to.startsWith('/home/ubuntu/benchpoll-code-backups/')) files.set(target, foreign);
    },
    async rename(from, to) { files.set(to, bytes(from)); files.delete(from); events.push(['rename', to]); },
    async unlink(name) { bytes(name); files.delete(name); events.push(['unlink', name]); }
};
const imports = {
    './search-legal-paths-20261101.mjs': await import(new URL('./search-legal-paths-20261101.mjs', pathToFileURL(process.env.UI_RELEASE_SOURCE))),
    'node:fs/promises': fs, 'node:path': posix, 'node:crypto': { createHash },
    'node:timers/promises': { async setTimeout() {} },
    'node:child_process': { execFileSync(executable, args) {
        if (executable === '/usr/bin/node') { assert.equal(args[0], '--check'); return Buffer.alloc(0); }
        assert.ok(executable === 'systemctl' || executable === 'sudo');
        assert.equal(args.at(-1), 'benchpoll.service', 'UI release must not touch score sync or any database service');
        const action = args.find(value => ['is-active', 'start', 'stop', 'restart'].includes(value));
        assert.ok(action); events.push([action]);
        if (action === 'is-active') assert.equal(active, true);
        if (action === 'stop') active = false;
        if (action === 'start') active = true;
        assert.notEqual(action, 'restart', 'Prepared UI uses a bounded pause around replacement');
        return Buffer.alloc(0);
    } },
    'node:https': { request(url, options, callback) {
        assert.equal(url, 'https://127.0.0.1:1337/'); assert.equal(options.headers.Host, 'benchpoll.com');
        const req = new EventEmitter(); req.destroy = error => req.emit('error', error);
        req.end = () => queueMicrotask(() => {
            assert.equal(active, true);
            if (scenario.duringHealth) files.set(target, foreign);
            const res = new EventEmitter(); res.setEncoding = () => {}; res.statusCode = scenario.healthFails ? 503 : 200;
            callback(res); res.emit('data', 'BenchPoll topics-grid ' + (scenario.cleanup || scenario.scoreToolbar || scenario.weightTreemap || scenario.benchmarkPolicy || scenario.searchLegal ? (scenario.missingNavigation ? '' : 'topics-navigation') : 'th-directory-dock')); res.emit('end');
        }); return req;
    } }
};
const context = createContext({ process: { argv: ['node', 'launcher', stage], cwd: () => stage },
    console: { log(value) { output.push(value); } } });
const module = new SourceTextModule(source, { context });
await module.link(specifier => {
    assert.ok(Object.hasOwn(imports, specifier));
    const entries = Object.entries(imports[specifier]);
    return new SyntheticModule(entries.map(([name]) => name), function () {
        for (const [name, value] of entries) this.setExport(name, value);
    }, { context });
});
await module.evaluate().catch(error => { observed = error; });
const rejected = !scenario.searchLegal && scenario.path && !scenario.guide && !(scenario.homeService && scenario.path === 'topic-home-service.js')
    && !(scenario.benchmarkPolicy && ['benchmark-details.js', 'benchmark-scores.js', 'ranking-service.js', 'server.js', 'aa-archive-policy.js'].includes(scenario.path))
    && !(scenario.scoreToolbar && ['pairwise-score.js', 'privacy-headers.js', 'public/css/topics-home.css'].includes(scenario.path))
    && !(scenario.cleanup && ['server.js', 'privacy-controls.js', 'privacy-headers.js', 'moderation-admin.js', 'ranking-service.js',
        'ranking-pagination.js', 'ranking-cache-schema.js', 'topic-home-service.js', 'private/sign-in.html', 'private/account-privacy.html',
        'private/privacy.html', 'private/terms.html', 'private/contribute.html', 'scripts/import-arena-latest.mjs'].includes(scenario.path))
    && !(scenario.accountFlow && ['server.js', 'privacy-controls.js', 'privacy-headers.js', 'topic-service.js', 'public-topic-review.js',
        'ranking-service.js', 'topic-home-service.js', 'moderation-email.js', 'user-profile-service.js', 'discussion-service.js',
        'topic-proposal-service.js', 'private/sign-in.html', 'private/loginCallback.html',
        'private/account-privacy.html', 'private/terms.html', 'private/privacy.html', 'private/topic-proposals.html',
        'scripts/migrate-topic-proposal-limits-20261028.mjs'].includes(scenario.path))
    || scenario.searchLegal && !imports['./search-legal-paths-20261101.mjs'].isSearchLegalPath(relative)
    || scenario.migration || scenario.badCandidate || scenario.duplicate || scenario.dependencyChanged
    || scenario.missingSchema || scenario.wrongSchemaRelease || scenario.schemaChangedData || scenario.incompleteSchema
    || scenario.missingLimitColumns || scenario.unwritable;
if (rejected) {
    assert.ok(observed, 'Unsafe release must be rejected');
    assert.equal(events.length, 0, 'Reject scope/hash failures before service or filesystem replacement');
} else if (scenario.beforeInstall || scenario.duringHealth) {
    assert.ok(observed); assert.equal(sha(bytes(target)), sha(foreign), 'Preserve concurrent work');
    assert.equal(active, true);
} else if (scenario.healthFails || scenario.missingNavigation) {
    assert.ok(observed); assert.equal(active, true);
    assert.equal(scenario.newFile ? files.has(target) : sha(bytes(target)), scenario.newFile ? false : sha(original));
} else {
    assert.equal(observed, undefined); assert.equal(sha(bytes(target)), sha(candidate)); assert.equal(active, true);
    const result = JSON.parse(output[0]); assert.equal(result.uiOnly, !scenario.homeService && !scenario.accountFlow && !scenario.cleanup && !scenario.scoreToolbar && !scenario.weightTreemap && !scenario.benchmarkPolicy && !scenario.searchLegal); assert.equal(result.databaseChanged, false);
    assert.equal(result.searchLegal, !!scenario.searchLegal);
    assert.equal(result.scoreToolbar, !!scenario.scoreToolbar);
    assert.equal(result.weightTreemap, !!scenario.weightTreemap);
    assert.equal(result.benchmarkPolicy, !!scenario.benchmarkPolicy);
    assert.equal(result.scoreTimerTouched, false); assert.equal(result.healthy, true);
    const stop = events.findIndex(event => event[0] === 'stop'), install = events.findIndex(event => event[0] === 'rename');
    const start = events.findIndex(event => event[0] === 'start'); assert.ok(stop < install && install < start);
    assert.ok(files.has(stage + '/released.json'));
}
console.log(JSON.stringify({ passed: true, scenario, active }));
`;

for (const scenario of [
    ...['server.js', 'home-assets.js', 'search-presentation.js', 'private/terms.html', 'public/js/shared/search-metadata.js'].map(path =>
        ({ name: 'search/legal installs reviewed ' + path, searchLegal: true, path })),
    { name: 'search/legal rejects unrelated backend', searchLegal: true, path: 'ranking-service.js' },
    { name: 'search/legal rejects migrations', searchLegal: true, migration: 'migrate-privacy-controls.mjs' },
    { name: 'search/legal rejects changed dependencies', searchLegal: true, dependencyChanged: true },
    { name: 'search/legal rolls back failed health', searchLegal: true, healthFails: true },
    { name: 'search/legal preserves concurrent edits', searchLegal: true, duringHealth: true },
    { name: 'existing UI installs without a database migration' },
    { name: 'new hashed UI asset installs safely', newFile: true },
    { name: 'failed health restores existing UI', healthFails: true },
    { name: 'failed health removes only its new asset', newFile: true, healthFails: true },
    { name: 'a write after backup is preserved', beforeInstall: true },
    { name: 'a write during health is preserved', duringHealth: true },
    { name: 'a foreign new asset is not removed', newFile: true, duringHealth: true, healthFails: true },
    { name: 'reject a backend payload', path: 'ranking-service.js' },
    { name: 'reject traversal', path: 'public/js/../../.env' },
    { name: 'reject hidden UI paths', path: 'public/js/.env' },
    { name: 'reject migration requests', migration: 'migrate-flat-topics-20261022.mjs' },
    { name: 'reject candidate path mismatch', badCandidate: true },
    { name: 'reject duplicate files', duplicate: true },
    { name: 'reject changed dependencies', dependencyChanged: true },
    { name: 'UI-only rejects the named home service too', path: 'topic-home-service.js' },
    { name: 'UI-only installs the static guide page', path: 'private/how-it-works.html', guide: true },
    { name: 'UI-only still rejects unrelated private pages', path: 'private/privacy.html' },
    { name: 'scoped home service installs with a bounded pause', homeService: true, path: 'topic-home-service.js' },
    { name: 'scoped home service rejects unrelated backend', homeService: true, path: 'ranking-service.js' },
    { name: 'scoped home service rejects migrations', homeService: true, migration: 'migrate-flat-topics-20261022.mjs' },
    { name: 'scoped home service rolls back without database changes', homeService: true, path: 'topic-home-service.js', healthFails: true },
    { name: 'account flow installs guarded authentication code', accountFlow: true, path: 'server.js' },
    { name: 'account flow installs moderation code', accountFlow: true, path: 'public-topic-review.js', newFile: true },
    { name: 'account flow installs required topic service', accountFlow: true, path: 'topic-service.js' },
    { name: 'account flow installs the sign-in document', accountFlow: true, path: 'private/sign-in.html', newFile: true },
    { name: 'account flow installs accurate privacy text', accountFlow: true, path: 'private/privacy.html' },
    { name: 'account flow rejects unrelated data services', accountFlow: true, path: 'db.js' },
    { name: 'account flow rejects unrelated private pages', accountFlow: true, path: 'private/censor.html' },
    { name: 'account flow rejects migrations', accountFlow: true, migration: 'migrate-privacy-controls.mjs' },
    { name: 'account flow rejects changed dependencies', accountFlow: true, dependencyChanged: true },
    { name: 'account flow restores authentication after failed health', accountFlow: true, path: 'server.js', healthFails: true },
    { name: 'account flow installs public-profile privacy code', accountFlow: true, path: 'user-profile-service.js' },
    { name: 'account flow installs threshold-vote code', accountFlow: true, path: 'topic-proposal-service.js', newFile: true },
    { name: 'account flow installs the proposal hall', accountFlow: true, path: 'private/topic-proposals.html', newFile: true },
    { name: 'account flow requires schema preparation', accountFlow: true, missingSchema: true },
    { name: 'account flow requires preparation for this release', accountFlow: true, wrongSchemaRelease: true },
    { name: 'account flow rejects modified protected records', accountFlow: true, schemaChangedData: true },
    { name: 'account flow rejects incomplete schema', accountFlow: true, incompleteSchema: true },
    { name: 'account flow guards its offline migration dependency', accountFlow: true, schemaDependency: true },
    { name: 'account flow rejects unwritable destinations before stopping the app', accountFlow: true, unwritable: true },
    { name: 'account flow requires proposal revision/deadline schema', accountFlow: true, missingLimitColumns: true },
    { name: 'account flow installs only the named offline limits migration', accountFlow: true, path: 'scripts/migrate-topic-proposal-limits-20261028.mjs', newFile: true },
    { name: 'cleanup installs ranking pagination with a bounded pause', cleanup: true, path: 'ranking-pagination.js' },
    { name: 'cleanup installs home model search with a bounded pause', cleanup: true, path: 'topic-home-service.js' },
    { name: 'cleanup installs benchmark tag administration changes', cleanup: true, path: 'moderation-admin.js' },
    { name: 'cleanup installs the contribution form', cleanup: true, path: 'private/contribute.html' },
    { name: 'cleanup rejects unrelated backend files', cleanup: true, path: 'db.js' },
    { name: 'cleanup rejects database migrations', cleanup: true, migration: 'migrate-privacy-controls.mjs' },
    { name: 'cleanup rejects invalid candidate', cleanup: true, badCandidate: true },
    { name: 'cleanup rolls back if the new navigation is missing', cleanup: true, missingNavigation: true },
    { name: 'cleanup rolls back on failed health', cleanup: true, path: 'server.js', healthFails: true },
    { name: 'score-toolbar installs pairwise code', scoreToolbar: true, path: 'pairwise-score.js' },
    { name: 'score-toolbar installs reviewed CSP', scoreToolbar: true, path: 'privacy-headers.js' },
    { name: 'score-toolbar installs CSS', scoreToolbar: true, path: 'public/css/topics-home.css' },
    { name: 'score-toolbar rejects unrelated backend', scoreToolbar: true, path: 'server.js' },
    { name: 'score-toolbar rejects migrations', scoreToolbar: true, migration: 'migrate-privacy-controls.mjs' },
    { name: 'score-toolbar rejects changed dependencies', scoreToolbar: true, dependencyChanged: true },
    { name: 'score-toolbar restores backend after failed health', scoreToolbar: true, path: 'pairwise-score.js', healthFails: true },
    { name: 'score-toolbar rejects missing navigation', scoreToolbar: true, missingNavigation: true },
    { name: 'treemap UI installs without changing data', weightTreemap: true },
    { name: 'treemap UI adds new modules', weightTreemap: true, newFile: true },
    { name: 'treemap UI rejects backend payloads', weightTreemap: true, path: 'server.js' },
    { name: 'treemap UI rejects migrations', weightTreemap: true, migration: 'migrate-flat-topics-20261022.mjs' },
    { name: 'treemap UI rejects changed dependencies', weightTreemap: true, dependencyChanged: true },
    { name: 'treemap UI preserves concurrent writes', weightTreemap: true, duringHealth: true },
    { name: 'treemap UI rolls back failed health', weightTreemap: true, healthFails: true },
    { name: 'treemap UI rejects missing navigation', weightTreemap: true, missingNavigation: true },
    ...['benchmark-details.js', 'benchmark-scores.js', 'ranking-service.js', 'server.js', 'aa-archive-policy.js'].map(path =>
        ({ name: 'benchmark policy installs reviewed ' + path, benchmarkPolicy: true, path })),
    { name: 'benchmark policy rejects unrelated backend', benchmarkPolicy: true, path: 'db.js' },
    { name: 'benchmark policy rejects migrations', benchmarkPolicy: true, migration: 'migrate-privacy-controls.mjs' },
    { name: 'benchmark policy rejects changed dependencies', benchmarkPolicy: true, dependencyChanged: true },
    { name: 'benchmark policy rejects missing navigation', benchmarkPolicy: true, missingNavigation: true },
    { name: 'benchmark policy preserves concurrent changes', benchmarkPolicy: true, duringHealth: true },
    { name: 'benchmark policy restores backend after failed health', benchmarkPolicy: true, path: 'benchmark-scores.js', healthFails: true }
]) test(`UI-only release: ${scenario.name}`, () => {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', harness], {
        encoding: 'utf8', timeout: 15000, windowsHide: true,
        env: { ...process.env, UI_RELEASE_SCENARIO: JSON.stringify(scenario), UI_RELEASE_SOURCE: launcher }
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, (result.stdout ?? '') + (result.stderr ?? ''));
});
