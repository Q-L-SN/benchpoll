import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildHomeAssets } from './build-home-assets.mjs';

const output = resolve(process.env.UI_COMPONENT_RELEASE_OUTPUT ?? 'artifacts/ui-components-20261010');
const benchmarkDiscoveryPaths = ['private/home.html', 'public/js/home-workspace.js',
    'public/js/workspace/benchmark-link.js', 'public/js/workspace/model-scores.js',
    'public/js/workspace/family-view.js', 'public/js/workspace/fallback-picker.js',
    'public/js/workspace/version-group-dialog.js', 'public/js/shared/motion.js',
    'public/css/ui/benchmark-add-layouts.css', 'public/css/ui/contribution-layouts.css',
    'public/css/ui/benchmark-families.css', 'public/css/ui/fallback.css',
    'public/css/ui/evidence.css', 'public/css/ui/workspace.css', 'public/js/workspace/style-previews.js',
    'public/js/shared/feedback-templates.js', 'public/js/home.js', 'public/js/legal.js', 'public/js/contribute.js',
    'public/css/ui/shell.css', 'public/css/model-comparison.css'];
const removedPaths = process.argv.includes('--benchmark-discovery-links') ? ['public/js/workspace/style-previews.js'] : [];
const personalFallbackPreviewPaths = ['private/home.html', 'private/how-it-works.html', 'public/js/home-workspace.js',
    'public/js/workspace/fallback-picker.js', 'public/js/workspace/family-view.js',
    'public/css/ui/fallback.css', 'public/css/ui/fallback-picker.css'];
const fallbackAddPaths = ['public/js/workspace/fallback-picker.js', 'public/js/shared/toast.js',
    'public/js/home-workspace.js', 'public/css/ui/fallback-picker.css', 'public/css/ui/workspace.css'];
const plainHelpPaths = ['private/home.html', 'private/how-it-works.html', 'private/contribute.html',
    'public/css/how-it-works.css', 'public/js/how-it-works.js', 'public/js/home-workspace.js', 'public/js/workspace/comparison-controls.js',
    'public/js/workspace/fallback-picker.js', 'public/js/workspace/model-scores.js',
    'public/js/workspace/version-group-dialog.js', 'public/js/contribute.js', 'public/js/contribution/score-fields.js'];
const publicFallbackPaths = ['private/home.html', 'private/how-it-works.html', 'public/js/home-workspace.js',
    'public/js/workspace/fallback-picker.js', 'public/js/workspace/preferences.js', 'public/js/workspace/state.js',
    'public/css/ui/fallback-picker.css', 'public/css/ui/ranking-motion.css', 'public/css/ui/components.css', 'public/css/model-comparison.css'];
const allUIPaths = ['private/home.html', 'private/contribute.html', 'private/how-it-works.html', 'private/privacy.html',
    'private/terms.html', 'private/dialogPage.html', 'private/adminlogin.html', 'private/censor.html', 'private/loginCallback.html',
    'public/js/global.js', 'public/js/shared/ui-components.js', 'public/js/home-workspace.js', 'public/js/workspace/model-scores.js',
    'public/js/contribute.js', 'public/js/contribution/score-fields.js', 'public/js/how-it-works.js', 'public/js/legal.js',
    'public/css/site-palette.css', 'public/css/contribute.css', 'public/css/model-comparison.css',
    'public/css/ui/components.css', 'public/css/ui/control-policy.css', 'public/css/ui/navigation.css',
    'public/css/ui/evidence.css', 'public/css/ui/workspace.css', 'public/css/ui/benchmark-families.css',
    ...fallbackAddPaths.filter(path => !['public/js/home-workspace.js', 'public/css/ui/workspace.css'].includes(path))];
const uiPaths = process.argv.includes('--benchmark-discovery-links') ? benchmarkDiscoveryPaths
    : process.argv.includes('--personal-fallback-preview') ? personalFallbackPreviewPaths
    : process.argv.includes('--public-fallback-view') ? publicFallbackPaths : process.argv.includes('--action-spacing')
    ? ['private/home.html', 'public/css/ui/navigation.css', 'public/css/ui/private-categories.css']
    : process.argv.includes('--plain-help') ? plainHelpPaths
    : process.argv.includes('--fallback-add') ? fallbackAddPaths : process.argv.includes('--adjustment-prompt')
    ? ['private/home.html', 'public/js/home-workspace.js', 'public/css/ui/workspace.css'] : allUIPaths;
const backendPaths = ['server.js', 'db.js', 'ranking-service.js', 'ranking-pagination.js', 'ranking-read-cache.js',
    'home-assets.js', 'model-comparison.js', 'score-aggregation.js', 'score-field-service.js', 'navigation-service.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const readMaybe = async path => {
    try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const ssh = source => execFileSync('C:/Windows/System32/OpenSSH/ssh.exe', [...options, 'ubuntu@18.226.222.18', 'node --input-type=module'],
    { input: source, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 32 * 1024 * 1024 });

async function installRelease() {
    const fs = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { execFileSync } = await import('node:child_process');
    const { join, dirname } = await import('node:path');
    const { setTimeout: delay } = await import('node:timers/promises');
    const manifest = JSON.parse(await fs.readFile('manifest.json', 'utf8'));
    const root = '/home/ubuntu/benchpoll';
    const digest = async path => {
        try { return createHash('sha256').update(await fs.readFile(path)).digest('hex'); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    if (!/^ui-components-20261010-\d+$/.test(manifest.release)
        || manifest.files.some(file => !allowedPaths.includes(file.path))
        || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw Error('Invalid UI scope');
    const protect = async () => {
        for (const file of manifest.protectedFiles) {
            if (await digest(join(root, file.path)) !== file.hash) throw Error('Concurrent source change: ' + file.path);
        }
    };
    await protect();
    for (const file of manifest.files) {
        if (await digest(file.path) !== file.after || await digest(join(root, file.path)) !== file.before) throw Error('Stage or production drift: ' + file.path);
        if (file.after && /\.js$/.test(file.path)) execFileSync('node', ['--check', file.path]);
    }
    const backup = join('/home/ubuntu/benchpoll-code-backups', manifest.release);
    await fs.mkdir(backup, { recursive: true });
    await fs.writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    for (const file of manifest.files) {
        file.mode = file.before ? (await fs.stat(join(root, file.path))).mode : 0o644;
        if (file.before) {
            await fs.mkdir(dirname(join(backup, file.path)), { recursive: true });
            await fs.copyFile(join(root, file.path), join(backup, file.path));
            if (await digest(join(backup, file.path)) !== file.before) throw Error('Backup drift: ' + file.path);
        }
    }
    const replace = async (source, file, expected) => {
        const target = join(root, file.path), temporary = `${target}.${manifest.release}.tmp`;
        await fs.mkdir(dirname(target), { recursive: true });
        await fs.copyFile(source, temporary); await fs.chmod(temporary, file.mode);
        if (await digest(target) !== expected) { await fs.unlink(temporary); throw Error('Concurrent replacement: ' + file.path); }
        await fs.rename(temporary, target);
    };
    const changed = [];
    try {
        for (const file of manifest.files) {
            if (file.after) await replace(file.path, file, file.before);
            else {
                if (await digest(join(root, file.path)) !== file.before) throw Error('Concurrent deletion: ' + file.path);
                await fs.unlink(join(root, file.path));
            }
            changed.push(file);
        }
        await protect();
        execFileSync('sudo', ['systemctl', 'restart', 'benchpoll.service']);
        let healthy = false;
        for (let attempt = 0; attempt < 20 && !healthy; attempt++) {
            await delay(1000);
            try {
                const body = execFileSync('curl', ['-kfsS', '--max-time', '10', 'https://127.0.0.1:1337/Intelligence'], { encoding: 'utf8' });
                healthy = body.includes('>My Pies</button>') && body.includes('/build/home/entry-2-')
                    && !body.includes('src="/js/home-workspace.js');
            } catch { /* Allow the service to finish starting. */ }
        }
        if (!healthy) throw Error('Compiled UI health check failed');
        const ranking = JSON.parse(execFileSync('curl', ['-kfsS', '--max-time', '30', '-H', 'Content-Type: application/json',
            '--data', '{"scoreMode":"range"}', 'https://127.0.0.1:1337/api/get_weighted_workspace'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
        if (!ranking.modelLeaderboards?.public?.length) throw Error('Live ranking health check failed');
        for (const file of manifest.files) if (await digest(join(root, file.path)) !== file.after) throw Error('Installed drift: ' + file.path);
        await protect();
        console.log(JSON.stringify({ release: manifest.release, backup, files: changed.length, healthy,
            unrelatedFilesPreserved: true, databaseWrites: 0 }));
    } catch (error) {
        const failures = [];
        for (const file of changed.reverse()) {
            try {
                if (file.before) await replace(join(backup, file.path), file, file.after);
                else if (await digest(join(root, file.path)) === file.after) await fs.unlink(join(root, file.path));
                else throw Error('New file changed concurrently: ' + file.path);
            } catch (failure) { failures.push(failure); }
        }
        try { execFileSync('sudo', ['systemctl', 'restart', 'benchpoll.service']); } catch (failure) { failures.push(failure); }
        throw new AggregateError([error, ...failures], 'UI release failed; guarded rollback attempted');
    }
}

if (process.argv.includes('--capture')) {
    const remote = JSON.parse(gunzipSync(Buffer.from(ssh(`import{readFile,readdir}from'node:fs/promises';import{createHash}from'node:crypto';import{gzipSync}from'node:zlib';
const root='/home/ubuntu/benchpoll/', files=new Map();async function add(path){if(files.has(path))return;let b=null;try{b=await readFile(root+path);}catch(e){if(e.code!=='ENOENT')throw e;}files.set(path,{path,hash:b?createHash('sha256').update(b).digest('hex'):null,base64:b?.toString('base64')});}
async function walk(dir){for(const f of await readdir(root+dir,{withFileTypes:true})){const path=dir+'/'+f.name;if(f.isDirectory())await walk(path);else if(/\\.(js|css)$/.test(f.name))await add(path);}}
for(const dir of ['public/js','public/css','public/vendor/fontawesome/css'])await walk(dir);
const built=JSON.parse(await readFile(root+'private/home-assets.json','utf8'));for(const path of [...${JSON.stringify([...allUIPaths, ...uiPaths, ...backendPaths])},'private/home-assets.json',...built.sources.map(f=>f.path)])await add(path);
console.log(gzipSync(Buffer.from(JSON.stringify([...files.values()]))).toString('base64'));`).trim(), 'base64')));
    const release = `ui-components-20261010-${Date.now()}`, folder = join(output, release);
    const stage = join(folder, 'stage'), sourceRoot = join(folder, 'installed-source');
    for (const file of remote.filter(file => file.base64 && !backendPaths.includes(file.path))) {
        await mkdir(dirname(join(sourceRoot, file.path)), { recursive: true });
        await writeFile(join(sourceRoot, file.path), Buffer.from(file.base64, 'base64'));
    }
    const baseline = process.env.UI_COMPONENT_SOURCE_BASELINE;
    for (const path of uiPaths) {
        await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
        const local = await readMaybe(path);
        assert.ok(local || removedPaths.includes(path), 'Unexpected missing local source: ' + path);
        if (!baseline) {
            if (local) await writeFile(join(sourceRoot, path), local);
            else await unlink(join(sourceRoot, path));
            continue;
        }
        const previous = await readMaybe(join(resolve(baseline), path));
        const installed = remote.find(file => file.path === path);
        if (!previous) {
            assert.ok(!installed?.hash && local, 'New source already exists in production: ' + path);
            await writeFile(join(sourceRoot, path), local);
            continue;
        }
        assert.ok(installed?.base64, 'Missing production baseline: ' + path);
        const current = Buffer.from(installed.base64, 'base64');
        if (!local) {
            assert.equal(hash(current), hash(previous), 'Concurrent edit of removed source: ' + path);
            await unlink(join(sourceRoot, path));
            continue;
        }
        if (hash(current) === hash(previous)) {
            await writeFile(join(sourceRoot, path), local);
            continue;
        }
        // Apply only this task's edits, keeping independent production edits.
        const inputs = ['installed', 'baseline', 'local'].map(name => join(folder, 'merge-input', name, path));
        for (const [index, bytes] of [current, previous, local].entries()) {
            await mkdir(dirname(inputs[index]), { recursive: true });
            await writeFile(inputs[index], bytes.toString('utf8').replace(/\r\n/g, '\n'));
        }
        const merged = spawnSync('git', ['merge-file', '-p', ...inputs], {
            encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024
        });
        assert.equal(merged.error, undefined);
        assert.equal(merged.status, 0, 'Concurrent edit overlaps this task: ' + path + '\n' + (merged.stderr ?? ''));
        await writeFile(join(sourceRoot, path), merged.stdout);
    }
    const built = await buildHomeAssets(sourceRoot);
    const paths = [...uiPaths, 'private/home-assets.json', ...built.files];
    const missing = paths.filter(path => !remote.some(file => file.path === path));
    if (missing.length) remote.push(...JSON.parse(ssh(`import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';const rows=[];for(const path of ${JSON.stringify(missing)}){let b=null;try{b=await readFile('/home/ubuntu/benchpoll/'+path);}catch(e){if(e.code!=='ENOENT')throw e;}rows.push({path,hash:b?createHash('sha256').update(b).digest('hex'):null});}console.log(JSON.stringify(rows));`)));
    const files = [];
    for (const path of paths) {
        const candidate = await readMaybe(join(sourceRoot, path)), current = remote.find(file => file.path === path);
        assert.ok(candidate || removedPaths.includes(path));
        const target = join(stage, path); await mkdir(dirname(target), { recursive: true });
        if (candidate) await writeFile(target, candidate);
        if (current.base64 && candidate) {
            const before = join(folder, 'before', path); await mkdir(dirname(before), { recursive: true }); await writeFile(before, Buffer.from(current.base64, 'base64'));
            const diff = spawnSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--', before, target], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
            assert.ok([0, 1].includes(diff.status)); await writeFile(target + '.diff', diff.stdout);
        }
        const local = uiPaths.includes(path) ? await readMaybe(path) : undefined;
        files.push({ path, before: current.hash, after: candidate ? hash(candidate) : null,
            ...(local !== undefined ? { localHash: local ? hash(local) : null } : {}) });
    }
    const protectedFiles = remote.filter(file => !paths.includes(file.path)).map(({ path, hash }) => ({ path, hash }));
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ release, files, protectedFiles }, null, 2));
    await writeFile(join(output, 'release-index.json'), JSON.stringify({ release, folder, stage, sourceRoot }, null, 2));
    console.log(JSON.stringify({ release, sourceRoot, changed: files.filter(file => file.before !== file.after).map(file => file.path) }));
} else if (process.argv.includes('--prepare')) {
    const browser = await json(join(output, 'browser-built/results.json'));
    assert.equal(browser.length, 5); assert.ok(browser.every(result => result.passed));
    if (process.argv.includes('--benchmark-discovery-links')) {
        const discovery = await json(join(output, 'discovery-built/results.json'));
        assert.equal(discovery.length, 5); assert.ok(discovery.every(result => result.passed && result.compiled));
        const preview = await json(join(output, 'preview-built/results.json'));
        assert.equal(preview.length, 5); assert.ok(preview.every(result => result.passed && result.compiled));
        const picker = await json(join(output, 'picker-built/results.json'));
        assert.equal(picker.length, 8); assert.ok(picker.every(result => result.passed));
    }
    if (process.argv.includes('--personal-fallback-preview')) {
        const preview = await json(join(output, 'preview-built/results.json'));
        assert.equal(preview.length, 5); assert.ok(preview.every(result => result.passed && result.compiled));
        const picker = await json(join(output, 'picker-built/results.json'));
        assert.equal(picker.length, 8); assert.ok(picker.every(result => result.passed));
        const publicView = await json(join(output, 'public-view-built/results.json'));
        assert.equal(publicView.length, 5); assert.ok(publicView.every(result => result.passed && result.compiled));
    }
    if (process.argv.includes('--action-spacing')) {
        const actions = await json(join(output, 'actions-built/results.json'));
        assert.equal(actions.length, 5); assert.ok(actions.every(result => result.passed && result.compiled));
    }
    if (process.argv.includes('--public-fallback-view')) {
        const publicView = await json(join(output, 'public-view-built/results.json'));
        assert.equal(publicView.length, 5); assert.ok(publicView.every(result => result.passed && result.compiled));
        const picker = await json(join(output, 'picker-built/results.json'));
        assert.equal(picker.length, 8); assert.ok(picker.every(result => result.passed));
        const segmented = await json(join(output, 'segmented-built/results.json'));
        assert.equal(segmented.length, 5); assert.ok(segmented.every(result => result.passed && result.compiled));
    }
    if (process.argv.includes('--plain-help')) {
        const help = await json(join(output, 'help-built/results.json'));
        assert.equal(help.length, 5); assert.ok(help.every(result => result.passed && result.compiled));
    }
    if (process.argv.includes('--fallback-add')) {
        const picker = await json(join(output, 'picker-built/results.json'));
        assert.equal(picker.length, 8); assert.ok(picker.every(result => result.passed));
    }
    assert.match(await readFile(join(output, 'unit-tests.log'), 'utf8'), /(?:#|\u2139) fail 0(?:\r?\n|$)/);
    const index = await json(join(output, 'release-index.json')), manifest = await json(join(index.stage, 'manifest.json'));
    for (const file of manifest.files) {
        const staged = await readMaybe(join(index.stage, file.path));
        assert.equal(staged ? hash(staged) : null, file.after, 'Stage drift: ' + file.path);
        if (Object.hasOwn(file, 'localHash')) {
            const local = await readMaybe(file.path);
            assert.equal(local ? hash(local) : null, file.localHash, 'Local drift: ' + file.path);
        }
    }
    const allowed = manifest.files.map(file => file.path);
    manifest.protectedFiles.push(...manifest.files.filter(file => file.before === file.after)
        .map(file => ({ path: file.path, hash: file.before })));
    manifest.files = manifest.files.filter(file => file.before !== file.after);
    await writeFile(join(index.stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(index.stage, 'install.mjs'), `const allowedPaths=${JSON.stringify(allowed)};\nawait (${installRelease.toString()})();\n`);
    console.log(JSON.stringify({ prepared: true, files: manifest.files.length }));
} else if (process.argv.includes('--apply')) {
    const index = await json(join(output, 'release-index.json')), manifest = await json(join(index.stage, 'manifest.json'));
    for (const file of manifest.files) {
        const staged = await readMaybe(join(index.stage, file.path));
        assert.equal(staged ? hash(staged) : null, file.after, 'Stage drift: ' + file.path);
        if (Object.hasOwn(file, 'localHash')) {
            const local = await readMaybe(file.path);
            assert.equal(local ? hash(local) : null, file.localHash, 'Local drift: ' + file.path);
        }
    }
    const archive = join(index.folder, index.release + '.tar');
    execFileSync('tar.exe', ['-cf', archive, '-C', index.stage, ...manifest.files.filter(file => file.after).map(file => file.path), 'manifest.json', 'install.mjs']);
    execFileSync('C:/Windows/System32/OpenSSH/scp.exe', [...options, archive, `ubuntu@18.226.222.18:/tmp/${index.release}.tar`], { stdio: 'inherit' });
    const receipt = JSON.parse(ssh(`import{mkdir}from'node:fs/promises';import{execFileSync}from'node:child_process';const stage='/tmp/${index.release}';await mkdir(stage);execFileSync('tar',['-xf',stage+'.tar','-C',stage]);process.chdir(stage);execFileSync('node',['install.mjs'],{stdio:'inherit'});`));
    assert.equal(receipt.healthy, true); await writeFile(join(index.folder, 'receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
} else throw Error('Use --capture, --prepare or --apply');
