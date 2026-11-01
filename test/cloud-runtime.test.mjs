import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { previewOptions, startCloudPreview } from '../scripts/cloud/preview.mjs';

const exec = promisify(execFile);
const previewPath = fileURLToPath(new URL('../scripts/cloud/preview.mjs', import.meta.url));
const setupPath = new URL('../scripts/cloud/setup.sh', import.meta.url);
const post = (app, path, body = {}) => fetch(app.url + '/api/' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});

async function temporary(t) {
    const directory = await mkdtemp(join(tmpdir(), 'benchpoll cloud runtime-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

test('preview flags override environment values and reject invalid ports', () => {
    assert.deepEqual(previewOptions([], {}), { port: 4173, host: '0.0.0.0', built: false });
    assert.deepEqual(previewOptions([], { PORT: '8080', HOST: '127.0.0.1', TOPICS_HOME_BUILT: '1' }),
        { port: 8080, host: '127.0.0.1', built: true });
    assert.deepEqual(previewOptions(['--port', '0', '--host', '127.0.0.1', '--built'], { PORT: 'bad', HOST: 'bad' }),
        { port: 0, host: '127.0.0.1', built: true });
    assert.deepEqual(previewOptions(['--help'], { PORT: 'bad' }), { help: true });
    for (const port of ['', '-1', '1.5', '65536', 'Infinity', 'abc', '0x10', ' 80']) {
        assert.throws(() => previewOptions([], { PORT: port }), /Preview port/);
    }
    assert.equal(previewOptions(['--port=65535'], {}).port, 65535);
    assert.throws(() => previewOptions(['--unknown'], {}), /Unknown option/);
});

test('cloud preview serves the real homepage and synthetic APIs on all IPv4 interfaces', async t => {
    const app = await startCloudPreview({ port: 0 });
    t.after(() => app.close());
    assert.equal(app.server.address().address, '0.0.0.0');
    const home = await fetch(app.url);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /id="topics-grid"/);
    assert.match(home.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.equal((await fetch(app.url + '/js/topics-home.js')).status, 200);
    const topics = await (await post(app, 'get_topics')).json();
    assert.ok(topics.topics.length > 0);
    assert.equal((await (await post(app, 'get_user_profile')).json()).userID, '42');
    const ranking = await (await post(app, 'get_topic_preview', { categoryID: 54, scoreMode: 'available' })).json();
    assert.ok(ranking.models.length > 0);
    assert.equal((await fetch(app.url + '/api/get_topics')).status, 405);
    assert.equal((await post(app, 'not_a_fixture_route')).status, 404);
    assert.equal((await fetch(app.url + '/%2e%2e%2fpackage.json')).status, 403);
});

test('fixture writes remain in memory and reset on restart', async t => {
    const first = await startCloudPreview({ port: 0, host: '127.0.0.1' });
    try {
        const created = await post(first, 'create_topic', { expectedUserID: '42', name: 'Cloud smoke topic', isPrivate: false });
        assert.equal(created.status, 201);
        assert.equal(first.state.created.length, 1);
    } finally { await first.close(); }
    const second = await startCloudPreview({ port: 0, host: '127.0.0.1' });
    t.after(() => second.close());
    assert.equal(second.state.created.length, 0);
    assert.equal(second.state.topics.some(topic => topic.name === 'Cloud smoke topic'), false);
});

test('explicit host and occupied port are honored without a silent fallback', async t => {
    const app = await startCloudPreview({ port: 0, host: '127.0.0.1' });
    t.after(() => app.close());
    assert.equal(app.server.address().address, '127.0.0.1');
    await assert.rejects(startCloudPreview({ port: app.server.address().port, host: '127.0.0.1' }), { code: 'EADDRINUSE' });
    await assert.rejects(startCloudPreview({ host: '' }), /Preview host/);
    await assert.rejects(startCloudPreview({ port: -1 }), /Preview port/);
});

test('built preview selects the compiled entry and reports a missing build clearly', async t => {
    const root = await temporary(t);
    await mkdir(join(root, 'private'));
    await assert.rejects(startCloudPreview({ root, port: 0, built: true }), /Built homepage is missing/);
    await writeFile(join(root, 'private/index-built.html'), '<!doctype html><title>Built fixture</title>');
    const app = await startCloudPreview({ root, port: 0, built: true });
    try { assert.match(await (await fetch(app.url)).text(), /Built fixture/); }
    finally { await app.close(); }
});

test('CLI starts outside the checkout with no application environment or credentials', { timeout: 15000 }, async t => {
    const cwd = await temporary(t);
    const child = spawn(process.execPath, [previewPath], { cwd, windowsHide: true,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: '0', HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let output = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { output += chunk; });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
    const url = await new Promise((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error(`Preview startup timed out: ${output}`)), 8000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`Preview exited before ready: ${output}`)); });
        child.stdout.on('data', chunk => {
            output += chunk;
            const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (match) { clearTimeout(timer); resolveReady(match[0]); }
        });
    });
    assert.equal((await fetch(url)).status, 200);
    assert.ok((await (await post({ url }, 'get_topics')).json()).topics.length > 0);
    child.kill('SIGTERM');
    const [code] = await exited;
    if (process.platform !== 'win32') assert.equal(code, 0);
});

test('CLI help is side-effect free and invalid configuration exits nonzero', async () => {
    const help = await exec(process.execPath, [previewPath, '--help'], { windowsHide: true });
    assert.match(help.stdout, /Usage:/);
    await assert.rejects(exec(process.execPath, [previewPath, '--port=nope'], { windowsHide: true }),
        error => error.code === 1 && /Preview port/.test(error.stderr));
});

test('setup engine gate accepts the pinned engine intersection before installing', async () => {
    const source = await readFile(setupPath, 'utf8');
    const gate = source.match(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/)[1];
    for (const version of ['20.19.0', '22.18.0', '23.11.0', '22.19.0', '22.22.1', '24.0.0', '26.0.0']) {
        let rejected = false;
        vm.runInNewContext(gate, { process: { versions: { node: version }, exit() { rejected = true; } }, console: { error() {} } });
        assert.equal(rejected, ['20.19.0', '22.18.0', '23.11.0'].includes(version), version);
    }
});

test('setup uses its own checkout, pinned install and both builds; install failure stops builds',
    { skip: process.platform === 'win32' ? 'Bash execution is verified on Linux; use native Node tests on Windows.' : false }, async t => {
        const root = await temporary(t);
        const bin = join(root, 'bin'), scripts = join(root, 'scripts/cloud'), log = join(root, 'commands.log');
        await mkdir(bin); await mkdir(scripts, { recursive: true });
        await copyFile(setupPath, join(scripts, 'setup.sh'));
        await writeFile(join(bin, 'npm'), '#!/usr/bin/env bash\nprintf "%s|%s\\n" "$PWD" "$*" >> "$BOOTSTRAP_COMMAND_LOG"\nif [[ "${BOOTSTRAP_FAIL_CI:-0}" == 1 && "$1" == ci ]]; then exit 19; fi\n', { mode: 0o755 });
        const options = { cwd: tmpdir(), env: { ...process.env, PATH: bin + delimiter + process.env.PATH, BOOTSTRAP_COMMAND_LOG: log } };
        await exec('bash', [join(scripts, 'setup.sh')], options);
        const install = 'ci --include=dev --include=optional --engine-strict --no-audit --no-fund';
        assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'),
            [install, 'run build:home', 'run build:home -- --index'].map(command => `${root}|${command}`));
        await writeFile(log, '');
        await assert.rejects(exec('bash', [join(scripts, 'setup.sh')], { ...options,
            env: { ...options.env, BOOTSTRAP_FAIL_CI: '1' } }), error => error.code === 19);
        assert.equal((await readFile(log, 'utf8')).trim(), `${root}|${install}`);
    });
