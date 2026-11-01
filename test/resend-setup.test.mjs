import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';
import * as worker from '../moderation-email.js';
import { validatePrivateResendSetup, resendEnvironment, serializePrivateEnvironment, parsePrivateEnvironment,
    createEmailPreflight, runEmailPreflight, emailSetupPaths as paths, publicSetupResult, redactedSetupError,
    originPage, withDeadline, readSetupInput } from '../ops/verify-resend-email.mjs';
import { parseConfigureArguments, createResendConfigurator, readLocalPrivateSetup } from '../ops/configure-resend-email.mjs';

const fixture = { RESEND_API_KEY: 're_test_only_000000000000000000', BENCHPOLL_EMAIL_TEST_TO: 'owner@example.invalid' };
const confirmation = { ownerConfirmedTest: true, contactInboxesConfirmed: true, legacyTestReceiptConfirmed: true };
const testUUID = '11111111-1111-4111-8111-111111111111';
const initialTime = Date.parse('2026-10-19T06:00:00.000Z');
const historical = { total: 221, pending: 221, sending: 0, failed: 0, sent: 0, minimumAttempts: 0,
    maximumAttempts: 0, totalAttempts: 0, highestID: '230', stateHash: 'unchanged-history' };
const error = code => Object.assign(new Error(code), { code });

function fakeFiles(events = []) {
    const files = new Map();
    let serial = 0;
    function put(path, bytes = '', attributes = {}) {
        const node = { bytes: Buffer.from(bytes), type: 'file', uid: 1000, mode: 0o600, ino: ++serial, dev: 1, ...attributes };
        files.set(path, node);
        return node;
    }
    function get(path) { if (!files.has(path)) throw error('ENOENT'); return files.get(path); }
    function stat(node) {
        return { ...node, size: node.bytes.length, nlink: node.nlink ?? [...files.values()].filter(value => value === node).length,
            isFile: () => node.type === 'file', isDirectory: () => node.type === 'directory', isSymbolicLink: () => node.type === 'symlink' };
    }
    const fs = {
        files, put, get, hook: null,
        async realpath(path) { return get(path).realpath ?? path; },
        async lstat(path) { return stat(get(path)); },
        async mkdir(path) { if (!files.has(path)) put(path, '', { type: 'directory', mode: 0o700 }); },
        async open(path, flags, mode) {
            if (flags === 'wx') {
                if (files.has(path)) throw error('EEXIST');
                put(path, '', { mode });
            }
            const node = get(path);
            if (node.type !== 'file') throw error('ELOOP');
            return {
                async stat() { return stat(node); },
                async readFile() { return Buffer.from(node.bytes); },
                async writeFile(bytes) {
                    if (fs.hook) await fs.hook('write', path, bytes);
                    node.bytes = Buffer.from(bytes);
                    events.push({ kind: 'write', path, bytes: String(bytes) });
                },
                async sync() { events.push({ kind: 'sync', path }); }, async close() {}
            };
        },
        async readFile(path, encoding) { const bytes = get(path).bytes; return encoding ? bytes.toString(encoding) : Buffer.from(bytes); },
        async rename(from, to) {
            if (fs.hook) await fs.hook('rename', to, get(from).bytes);
            files.set(to, get(from)); files.delete(from);
            events.push({ kind: 'rename', path: to, bytes: get(to).bytes.toString() });
        },
        async unlink(path) { get(path); files.delete(path); events.push({ kind: 'unlink', path }); }
    };
    put(paths.privateDirectory, '', { type: 'directory', mode: 0o700 });
    put(paths.unitDirectory, '', { type: 'directory', uid: 0, mode: 0o755 });
    return fs;
}

function harness(options = {}) {
    const events = [], fs = fakeFiles(events);
    const state = { now: initialTime, running: true, runtime: { ...options.runtime }, commands: [], starts: [],
        smtpCreated: 0, verified: 0, sent: [], closed: 0, historical: structuredClone(historical) };
    const environment = resendEnvironment(fixture, '231');
    const original = Object.entries(environment).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n';
    if (options.staged !== false) fs.put(paths.environmentFile, original);
    function legacyEvidence() {
        fs.put(paths.intentFile, JSON.stringify({ idempotencyKey: `benchpoll/setup/${testUUID}`, attemptedAt: '2026-10-18T12:58:13.000Z' }));
        fs.put(paths.receiptFile, JSON.stringify({ action: 'send-test', smtpConnectionVerified: true, acceptedByProvider: true,
            inboxConfirmed: false, acceptedAt: '2026-10-18T12:58:14.000Z', newMessages: 1, mailWorkerStarted: false }));
    }
    if (options.legacy !== false && options.staged !== false) legacyEvidence();
    const dependencies = {
        fileSystem: fs, uid: () => 1000, now: () => state.now, uuid: () => testUUID,
        sleep: async () => {}, loadWorker: async () => worker,
        runtimeEnvironment: async () => ({ ...state.runtime }),
        queueSnapshot: async (_runtime, minimumID) => {
            events.push({ kind: 'queue', minimumID });
            return structuredClone(minimumID ? state.historical : { ...historical, highestID: options.highestID ?? '230' });
        },
        originPage: async path => {
            events.push({ kind: 'origin', path });
            if (options.origin) return options.origin(path, state, fs);
            return { status: 200, body: path === '/api/privacy_information' ? JSON.stringify({
                versions: { terms: '2026-10-18', privacy: '2026-10-18', research: '2026-10-17' },
                operator: { displayName: 'BenchPoll operator', identityPending: true, email: 'privacy@benchpoll.com' }
            }) : 'BenchPoll Resend privacy@benchpoll.com support@benchpoll.com <time datetime="2026-10-18">' };
        },
        execute(command, args, commandOptions) {
            assert.ok(commandOptions.timeout > 0);
            assert.deepEqual(commandOptions.stdio, ['ignore', 'pipe', 'pipe']);
            state.commands.push({ command, args });
            events.push({ kind: 'command', command, args });
            if (options.command) options.command(command, args, state, fs);
            if (command === 'systemctl') return state.running ? '123\n' : '0\n';
            assert.equal(command, 'sudo'); assert.equal(args[0], '-n');
            const [tool, ...parameters] = args.slice(1);
            if (tool === 'systemctl') {
                if (parameters[0] === 'stop') state.running = false;
                if (parameters[0] === 'start') {
                    state.running = true;
                    state.runtime = fs.files.has(paths.unitFile) ? parsePrivateEnvironment(fs.get(paths.environmentFile).bytes) : { ...options.runtime };
                    state.starts.push(state.runtime.BENCHPOLL_EMAIL_DELIVERY_ENABLED ?? 'unconfigured');
                }
            } else if (tool === 'install') {
                if (parameters.includes('-d')) fs.put(parameters.at(-1), '', { type: 'directory', uid: 0, mode: 0o755 });
                else fs.put(parameters.at(-1), fs.get(parameters.at(-2)).bytes, { uid: 0, mode: 0o644 });
            } else if (tool === 'ln') {
                if (fs.files.has(parameters[1])) throw error('EEXIST');
                fs.files.set(parameters[1], fs.get(parameters[0]));
            } else if (tool === 'unlink') { fs.get(parameters[0]); fs.files.delete(parameters[0]); }
            else assert.fail('Unexpected privileged command');
            return '';
        },
        createTransport(configuration) {
            state.smtpCreated++;
            state.transportConfiguration = configuration;
            return {
                async verify() { state.verified++; return options.verify ? options.verify(state) : true; },
                async sendMail(message) {
                    assert.ok(fs.files.has(paths.intentFile));
                    assert.ok(events.some(event => event.kind === 'sync' && event.path === paths.intentFile));
                    state.sent.push(message);
                    return options.send ? options.send(message, state) : { accepted: [fixture.BENCHPOLL_EMAIL_TEST_TO], rejected: [] };
                },
                close() { state.closed++; }
            };
        },
        ...options.dependencies
    };
    return { fs, state, events, original, dependencies, legacyEvidence, run: createEmailPreflight(dependencies) };
}

async function readyHarness(options = {}) {
    const h = harness(options);
    await h.run('--verify');
    return h;
}

function publishedPage(path) {
    return { status: 200, body: path === '/api/privacy_information' ? JSON.stringify({
        versions: { terms: '2026-10-18', privacy: '2026-10-18', research: '2026-10-17' },
        operator: { displayName: 'BenchPoll operator', identityPending: true, email: 'privacy@benchpoll.com' }
    }) : 'BenchPoll Resend privacy@benchpoll.com support@benchpoll.com <time datetime="2026-10-18">' };
}

test('private setup accepts exactly one simple mailbox and a bounded, untrimmed string key', () => {
    assert.deepEqual(validatePrivateResendSetup(fixture), { key: fixture.RESEND_API_KEY, recipient: fixture.BENCHPOLL_EMAIL_TEST_TO });
    for (const recipient of ['owner@example.invalid\r\nBcc: other@example.invalid', 'owner@example.invalid\n',
        'A <owner@example.invalid>', 'owner@example.invalid,other@example.invalid', 'first;second@example.invalid',
        'first,second@example.invalid', '.owner@example.invalid', 'a..b@example.invalid', 'a@-example.invalid',
        'a@example-.invalid', 'a@localhost', ' owner@example.invalid', 'a'.repeat(65) + '@example.invalid']) {
        assert.throws(() => validatePrivateResendSetup({ ...fixture, BENCHPOLL_EMAIL_TEST_TO: recipient }), { code: 'INVALID_TEST_RECIPIENT' });
    }
    for (const key of ['not-a-key', fixture.RESEND_API_KEY + '\n', ' ' + fixture.RESEND_API_KEY, 're_' + 'x'.repeat(254), {}]) {
        assert.throws(() => validatePrivateResendSetup({ ...fixture, RESEND_API_KEY: key }), { code: 'INVALID_RESEND_KEY' });
    }
    assert.throws(() => validatePrivateResendSetup({ ...fixture, NODE_OPTIONS: '--inspect' }), { code: 'INVALID_SETUP_OPTIONS' });
});

test('private environment shares the documented single-quote dotenv/EnvironmentFile subset', () => {
    const environment = resendEnvironment(fixture, '231');
    assert.equal(environment.BENCHPOLL_EMAIL_DELIVERY_ENABLED, 'false');
    assert.equal(environment.BENCHPOLL_EMAIL_DAILY_LIMIT, '80');
    const bytes = serializePrivateEnvironment(environment);
    assert.deepEqual(dotenv.parse(bytes), environment);
    assert.deepEqual(parsePrivateEnvironment(Buffer.from(bytes)), environment);
    const systemdSubset = Object.fromEntries(bytes.trimEnd().split('\n').map(line => {
        const [, name, value] = /^([A-Z][A-Z0-9_]*)='([^']*)'$/.exec(line);
        return [name, value];
    }));
    assert.deepEqual(systemdSubset, environment);
    assert.deepEqual(dotenv.parse(serializePrivateEnvironment({ VALUE: '# $ % = "quoted"' })), { VALUE: '# $ % = "quoted"' });
    for (const minimum of ['0', '230', '-1', '1.1', '9007199254740992', '231\n', 231.5, {}]) {
        assert.throws(() => resendEnvironment(fixture, minimum), { code: 'INVALID_NOTIFICATION_FLOOR' });
    }
});

test('environment parsing rejects escapes, control bytes, duplicates, extra variables and partial settings', () => {
    for (const value of ['x\nINJECTED=true', 'x\r', 'x\0', 'x\t', 'x\\n', "x'y", 'x\u2028', 123]) {
        assert.throws(() => serializePrivateEnvironment({ VALUE: value }), { code: 'INVALID_ENVIRONMENT' });
    }
    assert.throws(() => serializePrivateEnvironment({ 'PASSWORD\nINJECTED': 'key' }), { code: 'INVALID_ENVIRONMENT' });
    const good = serializePrivateEnvironment(resendEnvironment(fixture, '231'));
    for (const bytes of [good + "BENCHPOLL_SMTP_PORT='25'\n", good + "NODE_OPTIONS='--inspect'\n",
        good.replace("'465'", "'25'"), good.replace(/BENCHPOLL_SMTP_USER=.*\n/, ''), good + '# comment\n',
        good.replace("'resend'", 'resend')]) assert.throws(() => parsePrivateEnvironment(Buffer.from(bytes)));
});

test('existing paused files need no contacts; optional contact fields accept only the confirmed fixed addresses', () => {
    const environment = resendEnvironment(fixture, '231');
    assert.deepEqual(parsePrivateEnvironment(Buffer.from(serializePrivateEnvironment(environment))), environment);
    const contact = { ...environment, BENCHPOLL_PRIVACY_EMAIL: 'privacy@benchpoll.com', BENCHPOLL_NOTIFICATION_REPLY_TO: 'support@benchpoll.com' };
    assert.deepEqual(parsePrivateEnvironment(Buffer.from(serializePrivateEnvironment(contact))), contact);
    for (const change of [{ BENCHPOLL_PRIVACY_EMAIL: 'other@example.invalid' }, { BENCHPOLL_NOTIFICATION_REPLY_TO: 'other@example.invalid' }]) {
        assert.throws(() => parsePrivateEnvironment(Buffer.from(serializePrivateEnvironment({ ...contact, ...change }))),
            { code: 'EMAIL_CONFIGURATION_REQUIRES_REVIEW' });
    }
});

test('activation and test-send confirmations must be strict booleans before any file or service access', async () => {
    for (const value of [undefined, false, 'false', 'true', 0, 1, null]) {
        await assert.rejects(runEmailPreflight('--activate', { ownerConfirmedTest: value }));
        await assert.rejects(runEmailPreflight('--activate', { ownerConfirmedTest: true, contactInboxesConfirmed: value }));
        await assert.rejects(runEmailPreflight('--send-test', { sendTestAuthorized: value }));
    }
    await assert.rejects(runEmailPreflight('--activate', { ...confirmation, supportReplyConfirmed: 'false' }), { code: 'INVALID_SETUP_OPTIONS' });
    await assert.rejects(runEmailPreflight('--activate', { ...confirmation, unexpected: true }), { code: 'INVALID_SETUP_OPTIONS' });
});

test('staging is paused, uses MAX(ID)+1 with a hard historical floor, and is idempotent', async () => {
    for (const [highestID, floor] of [['0', '231'], ['230', '231'], ['500', '501']]) {
        const h = harness({ staged: false, highestID });
        const first = await h.run('--stage', { input: fixture });
        assert.equal(first.minimumNotificationID, floor);
        assert.equal(parsePrivateEnvironment(h.fs.get(paths.environmentFile).bytes).BENCHPOLL_EMAIL_DELIVERY_ENABLED, 'false');
        assert.deepEqual(await h.run('--stage', { input: fixture }), first);
        assert.equal(h.state.commands.length, 0); assert.equal(h.state.smtpCreated, 0);
        await assert.rejects(h.run('--stage', { input: { ...fixture, RESEND_API_KEY: fixture.RESEND_API_KEY + 'x' } }),
            { code: 'EMAIL_CONFIGURATION_REQUIRES_REVIEW' });
    }
});

test('partial or unexpected runtime mail configuration is not treated as unconfigured', async () => {
    for (const runtime of [{ BENCHPOLL_SMTP_HOST: 'smtp.resend.com' }, { BENCHPOLL_SMTP_HOST: '' },
        { BENCHPOLL_EMAIL_DELIVERY_ENABLED: 'false' }, { BENCHPOLL_EMAIL_DAILY_LIMIT: '80' },
        { BENCHPOLL_NOTIFICATION_UNKNOWN: 'value' }, { BENCHPOLL_PRIVACY_EMAIL: 'other@example.invalid' }]) {
        const h = harness({ staged: false, runtime });
        await assert.rejects(h.run('--stage', { input: fixture }), { code: 'EXISTING_MAIL_CONFIGURATION_REQUIRES_REVIEW' });
        assert.equal(h.fs.files.has(paths.environmentFile), false); assert.equal(h.state.commands.length, 0);
        assert.equal(h.events.some(event => event.kind === 'queue'), false);
    }
});

test('protected file checks reject permissive files, foreign owners, hard links and symbolic links', async () => {
    for (const attributes of [{ mode: 0o644 }, { uid: 0 }, { nlink: 2 }, { type: 'symlink' }, { type: 'directory' }]) {
        const h = harness(); Object.assign(h.fs.get(paths.environmentFile), attributes);
        await assert.rejects(h.run('--verify'), { code: 'UNSAFE_EMAIL_FILE_PERMISSIONS' });
        assert.equal(h.state.smtpCreated, 0);
    }
    for (const attributes of [{ mode: 0o755 }, { uid: 0 }, { type: 'symlink' }, { realpath: '/elsewhere' }]) {
        const h = harness(); Object.assign(h.fs.get(paths.privateDirectory), attributes);
        await assert.rejects(h.run('--verify'), { code: 'UNSAFE_EMAIL_DIRECTORY' });
    }
});

test('SMTP verification cannot send and uses authenticated, verified TLS with bounded waits', async () => {
    const h = harness();
    const result = await h.run('--verify');
    assert.equal(result.newMessages, 0); assert.equal(h.state.sent.length, 0); assert.equal(h.state.closed, 1);
    const config = h.state.transportConfiguration;
    assert.deepEqual([config.host, config.port, config.secure], ['smtp.resend.com', 465, true]);
    assert.deepEqual(config.tls, { servername: 'smtp.resend.com', minVersion: 'TLSv1.2', rejectUnauthorized: true });
    for (const name of ['dnsTimeout', 'connectionTimeout', 'greetingTimeout', 'socketTimeout']) assert.ok(config[name] > 0 && config[name] <= 30_000);
    assert.equal(config.logger, false); assert.equal(config.debug, false);
    assert.equal(JSON.stringify(result).includes(fixture.RESEND_API_KEY), false);
    const unverified = harness({ verify: () => false });
    await assert.rejects(unverified.run('--verify'), { code: 'SMTP_CONNECTION_NOT_VERIFIED' });
});

test('one authorized fake test persists a bound intent before sending; retries never send again', async () => {
    const h = harness({ legacy: false });
    const result = await h.run('--send-test', { sendTestAuthorized: true });
    assert.equal(result.acceptedByProvider, true); assert.equal(result.inboxConfirmed, false); assert.equal(result.newMessages, 1);
    assert.equal(h.state.sent.length, 1);
    assert.deepEqual(h.state.sent[0].envelope.to, [fixture.BENCHPOLL_EMAIL_TEST_TO]);
    assert.equal(h.state.sent[0].headers['Resend-Idempotency-Key'], `benchpoll/setup/${testUUID}`);
    const receipt = JSON.parse(h.fs.get(paths.receiptFile).bytes);
    assert.equal(receipt.version, 2); assert.match(receipt.configurationHash, /^[a-f0-9]{64}$/);
    const repeated = await h.run('--send-test', { sendTestAuthorized: true });
    assert.equal(repeated.alreadyAccepted, true); assert.equal(repeated.newMessages, 0);
    assert.equal(h.state.smtpCreated, 1); assert.equal(h.state.commands.length, 0);
    assert.equal('configurationHash' in result, false); assert.equal('idempotencyKey' in result, false);
});

test('ambiguous SMTP outcome, partial acceptance and receipt-write failure never cause an automatic resend', async () => {
    for (const mode of ['throw', 'wrong-recipient', 'rejected', 'receipt-write']) {
        const h = harness({ legacy: false, send: () => {
            if (mode === 'throw') throw Object.assign(new Error(fixture.RESEND_API_KEY), { response: fixture.RESEND_API_KEY });
            return { accepted: [mode === 'wrong-recipient' ? 'other@example.invalid' : fixture.BENCHPOLL_EMAIL_TEST_TO],
                rejected: mode === 'rejected' ? ['other@example.invalid'] : [] };
        } });
        if (mode === 'receipt-write') h.fs.hook = (operation, path) => { if (operation === 'write' && path === paths.receiptFile) throw error('EIO'); };
        await assert.rejects(h.run('--send-test', { sendTestAuthorized: true }));
        assert.equal(h.state.sent.length, 1);
        await assert.rejects(h.run('--send-test', { sendTestAuthorized: true }));
        assert.equal(h.state.sent.length, 1); assert.equal(h.state.smtpCreated, 1);
    }
});

test('SMTP hard deadlines close the transport; an attempted send retains its intent', async () => {
    const never = () => new Promise(() => {});
    const verifying = harness({ legacy: false, verify: never, dependencies: { smtpTimeout: 5 } });
    await assert.rejects(verifying.run('--verify'), { code: 'SMTP_OPERATION_TIMEOUT' });
    assert.ok(verifying.state.closed > 0); assert.equal(verifying.state.sent.length, 0);
    const sending = harness({ legacy: false, send: never, dependencies: { smtpTimeout: 5 } });
    await assert.rejects(sending.run('--send-test', { sendTestAuthorized: true }), { code: 'SMTP_OPERATION_TIMEOUT' });
    assert.equal(sending.fs.files.has(paths.intentFile), true);
    await assert.rejects(sending.run('--send-test', { sendTestAuthorized: true }), { code: 'TEST_SEND_REQUIRES_REVIEW' });
    assert.equal(sending.state.sent.length, 1);
});

test('concurrent test attempts are serialized with an exclusive lock', async () => {
    const h = harness({ legacy: false });
    const outcomes = await Promise.allSettled([h.run('--send-test', { sendTestAuthorized: true }), h.run('--send-test', { sendTestAuthorized: true })]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'EMAIL_SETUP_BUSY');
    assert.equal(h.state.sent.length, 1); assert.equal(h.fs.files.has(paths.lockFile), false);
});

test('legacy receipt plus a fresh no-mail verification activates contacts without another test', async () => {
    const h = await readyHarness();
    h.state.now += 2 * 24 * 60 * 60_000;
    await h.run('--verify');
    const smtpBefore = h.state.smtpCreated;
    const result = await h.run('--activate', confirmation);
    assert.equal(result.enabled, true); assert.equal(result.contactInboxesConfirmed, true);
    assert.equal(result.legacyReceiptConfirmed, true); assert.equal(result.operatorIdentityPending, true);
    assert.equal(result.legalComplianceVerified, false);
    const environment = parsePrivateEnvironment(h.fs.get(paths.environmentFile).bytes);
    assert.equal(environment.BENCHPOLL_PRIVACY_EMAIL, 'privacy@benchpoll.com');
    assert.equal(environment.BENCHPOLL_NOTIFICATION_REPLY_TO, 'support@benchpoll.com');
    assert.equal(environment.BENCHPOLL_EMAIL_MIN_OUTBOX_ID, '231');
    assert.deepEqual(h.state.starts, ['false', 'true']);
    assert.equal(h.state.sent.length, 0); assert.equal(h.state.smtpCreated, smtpBefore);
    assert.deepEqual(h.state.historical, historical);
    const firstEnabledWrite = h.events.findIndex(event => event.kind === 'rename'
        && event.path === paths.environmentFile && event.bytes.includes("BENCHPOLL_EMAIL_DELIVERY_ENABLED='true'"));
    const policyCheck = h.events.findIndex(event => event.kind === 'origin' && event.path === '/api/privacy_information');
    assert.ok(policyCheck >= 0 && policyCheck < firstEnabledWrite);
    assert.ok(h.events.slice(0, firstEnabledWrite).filter(event => event.kind === 'command' && event.args.includes('stop')).length >= 2);
    assert.equal(JSON.stringify(result).includes(fixture.RESEND_API_KEY), false);
    assert.equal(JSON.stringify(result).includes(fixture.BENCHPOLL_EMAIL_TEST_TO), false);
});

test('successful activation is idempotent and never restarts or re-sends on retry', async () => {
    const h = await readyHarness();
    await h.run('--activate', confirmation);
    const commands = h.state.commands.length, transports = h.state.smtpCreated;
    h.state.now += 48 * 60 * 60_000;
    const result = await h.run('--activate', confirmation);
    assert.equal(result.alreadyActivated, true); assert.equal(result.newMessages, 0);
    assert.equal(h.state.commands.length, commands); assert.equal(h.state.smtpCreated, transports);
    const recorded = JSON.parse(h.fs.get(paths.activationFile).bytes);
    assert.equal(recorded.configurationHash.length, 64);
    assert.equal(recorded.historical.total, 221);
    assert.equal('configurationHash' in result, false);
});

test('legacy receipt requires a separate, literal boolean attestation, not a resend', async () => {
    const h = await readyHarness();
    await assert.rejects(h.run('--activate', { ownerConfirmedTest: true, contactInboxesConfirmed: true }),
        { code: 'LEGACY_TEST_RECEIPT_CONFIRMATION_REQUIRED' });
    await assert.rejects(h.run('--activate', { ...confirmation, legacyTestReceiptConfirmed: 'true' }), { code: 'INVALID_SETUP_OPTIONS' });
    assert.equal(h.state.commands.length, 0); assert.equal(h.state.sent.length, 0);
    const repeatedTest = await h.run('--send-test', { sendTestAuthorized: true });
    assert.equal(repeatedTest.alreadyAccepted, true); assert.equal(repeatedTest.newMessages, 0);
});

test('activation needs a recent, protected SMTP verification bound to this exact configuration', async () => {
    const missing = harness();
    await assert.rejects(missing.run('--activate', confirmation), { code: 'FRESH_SMTP_VERIFICATION_REQUIRED' });
    const expired = await readyHarness(); expired.state.now += 15 * 60_000 + 1;
    await assert.rejects(expired.run('--activate', confirmation), { code: 'FRESH_SMTP_VERIFICATION_REQUIRED' });
    assert.equal(expired.state.commands.length, 0);
    await expired.run('--verify');
    assert.equal((await expired.run('--activate', confirmation)).enabled, true);
    const changed = await readyHarness();
    changed.fs.get(paths.environmentFile).bytes = Buffer.from(changed.original.replace(fixture.RESEND_API_KEY, fixture.RESEND_API_KEY + 'x'));
    await assert.rejects(changed.run('--activate', confirmation), { code: 'FRESH_SMTP_VERIFICATION_REQUIRED' });
    const unsafe = await readyHarness(); unsafe.fs.get(paths.verificationFile).mode = 0o644;
    await assert.rejects(unsafe.run('--activate', confirmation), { code: 'UNSAFE_EMAIL_FILE_PERMISSIONS' });
});

test('v2 test evidence stays bound to SMTP identity, recipient, floor and intent even after fresh verification', async () => {
    for (const change of ['key', 'recipient', 'floor', 'intent', 'receipt']) {
        const h = harness({ legacy: false });
        await h.run('--send-test', { sendTestAuthorized: true });
        if (change === 'intent') {
            const intent = JSON.parse(h.fs.get(paths.intentFile).bytes); intent.idempotencyKey = 'benchpoll/setup/22222222-2222-4222-8222-222222222222';
            h.fs.get(paths.intentFile).bytes = Buffer.from(JSON.stringify(intent));
        } else if (change === 'receipt') {
            const receipt = JSON.parse(h.fs.get(paths.receiptFile).bytes); receipt.configurationHash = 'f'.repeat(64);
            h.fs.get(paths.receiptFile).bytes = Buffer.from(JSON.stringify(receipt));
        } else {
            const environment = parsePrivateEnvironment(h.fs.get(paths.environmentFile).bytes);
            if (change === 'key') environment.BENCHPOLL_SMTP_PASSWORD += 'x';
            if (change === 'recipient') environment.BENCHPOLL_EMAIL_TEST_TO = 'other@example.invalid';
            if (change === 'floor') environment.BENCHPOLL_EMAIL_MIN_OUTBOX_ID = '232';
            h.fs.get(paths.environmentFile).bytes = Buffer.from(serializePrivateEnvironment(environment));
        }
        await h.run('--verify');
        await assert.rejects(h.run('--activate', confirmation), { code: 'CURRENT_TEST_RECEIPT_REQUIRED' });
        assert.equal(h.state.commands.length, 0); assert.equal(h.state.sent.length, 1);
    }
});

test('expired but bound v2 receipt can be used with a fresh no-mail verification and explicit owner confirmation', async () => {
    const h = harness({ legacy: false });
    await h.run('--send-test', { sendTestAuthorized: true });
    h.state.now += 48 * 60 * 60_000;
    await assert.rejects(h.run('--activate', confirmation), { code: 'FRESH_SMTP_VERIFICATION_REQUIRED' });
    await h.run('--verify');
    const result = await h.run('--activate', { ownerConfirmedTest: true, contactInboxesConfirmed: true });
    assert.equal(result.enabled, true); assert.equal(result.legacyReceiptConfirmed, false);
    assert.equal(h.state.sent.length, 1);
});

test('verification expiring during the paused health phase cannot enable delivery', async () => {
    const h = await readyHarness({ origin(path, state) {
        if (path === '/api/privacy_information') state.now += 16 * 60_000;
        return publishedPage(path);
    } });
    await assert.rejects(h.run('--activate', confirmation), { code: 'FRESH_SMTP_VERIFICATION_REQUIRED' });
    assert.equal(h.state.starts.includes('true'), false);
    assert.equal(h.fs.get(paths.environmentFile).bytes.toString(), h.original);
});

test('receipt existence alone, malformed acceptance and unsafe receipt permissions cannot authorize activation', async () => {
    for (const change of ['missing-intent', 'bad-json', 'accepted-string', 'future', 'world-readable', 'symlink', 'hard-link']) {
        const h = await readyHarness();
        const receipt = JSON.parse(h.fs.get(paths.receiptFile).bytes);
        if (change === 'missing-intent') h.fs.files.delete(paths.intentFile);
        if (change === 'bad-json') h.fs.get(paths.receiptFile).bytes = Buffer.from('{');
        if (change === 'accepted-string') { receipt.acceptedByProvider = 'true'; h.fs.get(paths.receiptFile).bytes = Buffer.from(JSON.stringify(receipt)); }
        if (change === 'future') { receipt.acceptedAt = '2099-01-01T00:00:00.000Z'; h.fs.get(paths.receiptFile).bytes = Buffer.from(JSON.stringify(receipt)); }
        if (change === 'world-readable') h.fs.get(paths.receiptFile).mode = 0o644;
        if (change === 'symlink') h.fs.get(paths.receiptFile).type = 'symlink';
        if (change === 'hard-link') h.fs.get(paths.receiptFile).nlink = 2;
        await assert.rejects(h.run('--activate', confirmation));
        assert.equal(h.state.commands.length, 0); assert.equal(h.state.sent.length, 0);
    }
});

test('policy, metadata or paused-runtime failure rolls back before ever enabling delivery', async () => {
    for (const failure of ['date', 'provider', 'identity', 'contact', 'runtime']) {
        const h = await readyHarness({
            origin(path, state) {
                if (failure === 'runtime' && path === '/Intelligence' && state.starts.at(-1) === 'false') {
                    state.runtime.BENCHPOLL_EMAIL_MIN_OUTBOX_ID = '1';
                }
                const page = publishedPage(path);
                if (path === '/privacy' && failure === 'date') page.body = 'BenchPoll Resend';
                if (path === '/privacy' && failure === 'provider') page.body = '<time datetime="2026-10-18">';
                if (path === '/api/privacy_information' && ['identity', 'contact'].includes(failure)) {
                    const information = JSON.parse(page.body);
                    if (failure === 'identity') information.operator.identityPending = false;
                    else information.operator.email = null;
                    page.body = JSON.stringify(information);
                }
                return page;
            }
        });
        await assert.rejects(h.run('--activate', confirmation));
        assert.deepEqual(h.state.starts, ['false', 'unconfigured']);
        assert.equal(h.fs.get(paths.environmentFile).bytes.toString(), h.original);
        assert.equal(h.fs.files.has(paths.unitFile), false);
        assert.equal(h.fs.files.has(paths.journalFile), false);
        assert.equal(h.events.some(event => event.kind === 'rename' && event.bytes.includes("DELIVERY_ENABLED='true'")), false);
        assert.equal(h.state.sent.length, 0);
    }
});

test('failed post-activation health stops the active service before restoring only our files', async () => {
    const h = await readyHarness({ origin(path, state) {
        return state.starts.at(-1) === 'true' && path === '/Intelligence' ? { status: 503, body: '' } : publishedPage(path);
    } });
    await assert.rejects(h.run('--activate', confirmation), { code: 'HEALTH_CHECK_FAILED' });
    assert.deepEqual(h.state.starts, ['false', 'true', 'unconfigured']);
    assert.equal(h.fs.get(paths.environmentFile).bytes.toString(), h.original);
    assert.equal(h.fs.files.has(paths.unitFile), false); assert.equal(h.fs.files.has(paths.journalFile), false);
    const activeStart = h.events.findLastIndex(event => event.kind === 'command' && event.args.includes('start'));
    const rollbackRename = h.events.findLastIndex(event => event.kind === 'rename' && event.path === paths.environmentFile);
    assert.ok(rollbackRename < activeStart);
    const priorStop = h.events.slice(0, rollbackRename).findLast(event => event.kind === 'command' && event.args.includes('stop'));
    assert.ok(priorStop); assert.deepEqual(h.state.historical, historical);
});

test('rollback conflicts preserve concurrent environment or unit edits, stop service and retain recovery journal', async () => {
    for (const target of ['environment', 'unit']) {
        const foreign = target === 'environment' ? 'FOREIGN_CONFIG=untouched\n' : '[Service]\n# foreign operator change\n';
        let changed = false;
        const h = await readyHarness({ origin(path, state, fs) {
            if (state.starts.at(-1) === 'true' && path === '/Intelligence') {
                if (!changed) {
                    fs.put(target === 'environment' ? paths.environmentFile : paths.unitFile, foreign,
                        target === 'unit' ? { uid: 0, mode: 0o644 } : {});
                    changed = true;
                }
                return { status: 503, body: '' };
            }
            return publishedPage(path);
        } });
        await assert.rejects(h.run('--activate', confirmation), { code: 'ACTIVATION_ROLLBACK_FAILED' });
        assert.equal(h.fs.get(target === 'environment' ? paths.environmentFile : paths.unitFile).bytes.toString(), foreign);
        assert.equal(h.state.running, false); assert.equal(h.fs.files.has(paths.journalFile), true);
        assert.deepEqual(h.state.starts, ['false', 'true']);
    }
});

test('a failed stop or rollback command does not claim success or start a replacement service', async () => {
    const h = await readyHarness({ command(_command, args) {
        if (args.includes('stop')) throw error('ETIMEDOUT');
    } });
    await assert.rejects(h.run('--activate', confirmation), { code: 'ACTIVATION_ROLLBACK_FAILED' });
    assert.equal(h.state.starts.length, 0); assert.equal(h.fs.files.has(paths.journalFile), true);
    assert.equal(h.fs.get(paths.environmentFile).bytes.toString(), h.original);
    const result = redactedSetupError('--activate', error('ACTIVATION_ROLLBACK_FAILED'));
    assert.equal(result.deliveryState, 'requires-status-check'); assert.equal('mailWorkerStarted' in result, false);
});

test('a replacement runtime discovered during rollback is stopped again, not left delivering', async () => {
    const h = await readyHarness({ origin(path, state) {
        if (path === '/Intelligence' && state.starts.at(-1) === 'true') return { status: 503, body: '' };
        if (path === '/Intelligence' && state.starts.at(-1) === 'unconfigured') state.runtime.BENCHPOLL_SMTP_HOST = 'unexpected.invalid';
        return publishedPage(path);
    } });
    await assert.rejects(h.run('--activate', confirmation), { code: 'ACTIVATION_ROLLBACK_FAILED' });
    assert.equal(h.state.running, false); assert.equal(h.fs.files.has(paths.journalFile), true);
});

test('certificate trust errors fail before stopping or changing the running service', async () => {
    const h = await readyHarness({ origin() { throw error('UNSAFE_EMAIL_FILE_PERMISSIONS'); } });
    await assert.rejects(h.run('--activate', confirmation), { code: 'UNSAFE_EMAIL_FILE_PERMISSIONS' });
    assert.equal(h.state.running, true);
    assert.deepEqual(h.state.starts, []);
    assert.equal(h.fs.get(paths.environmentFile).bytes.toString(), h.original);
    assert.equal(h.fs.files.has(paths.journalFile), false);
    assert.equal(h.fs.files.has(paths.unitFile), false);
});

test('a health probe failure does not stop a restored and verified non-mail runtime', async () => {
    const h = await readyHarness({ origin(path, state) {
        if (path === '/Intelligence' && state.starts.length) throw error('UNSAFE_EMAIL_FILE_PERMISSIONS');
        return publishedPage(path);
    } });
    await assert.rejects(h.run('--activate', confirmation), { code: 'ACTIVATION_ROLLBACK_FAILED' });
    assert.equal(h.state.running, true);
    assert.equal(h.state.starts.at(-1), 'unconfigured');
    assert.equal(h.fs.get(paths.environmentFile).bytes.toString(), h.original);
    assert.equal(h.fs.files.has(paths.unitFile), false);
    assert.equal(h.fs.files.has(paths.journalFile), true);
    const report = [...h.fs.files].find(([path]) => /email-activation-failure-/.test(path));
    const diagnostic = JSON.parse(report[1].bytes);
    assert.equal(diagnostic.phase, 'start-paused-service');
    assert.equal(diagnostic.code, 'UNSAFE_EMAIL_FILE_PERMISSIONS');
    assert.deepEqual(diagnostic.rollbackIssues, [{ step: 'restart-verification', code: 'UNSAFE_EMAIL_FILE_PERMISSIONS' }]);
    assert(!report[1].bytes.toString().includes(fixture.RESEND_API_KEY));
});

test('single install, link, reload or start failures restore the paused environment and original service', async () => {
    for (const phase of ['install', 'ln', 'daemon-reload', 'paused-start', 'enabled-start']) {
        let failed = false, starts = 0;
        const h = await readyHarness({ command(_command, args) {
            if (args[1] === 'systemctl' && args[2] === 'start') starts++;
            const matches = phase === 'install' ? args[1] === 'install' && !args.includes('-d')
                : phase === 'ln' ? args[1] === 'ln'
                    : phase === 'daemon-reload' ? args.includes('daemon-reload')
                        : args[1] === 'systemctl' && args[2] === 'start' && starts === (phase === 'paused-start' ? 1 : 2);
            if (!failed && matches) { failed = true; throw error('EIO'); }
        } });
        await assert.rejects(h.run('--activate', confirmation));
        assert.equal(failed, true);
        assert.equal(h.fs.get(paths.environmentFile).bytes.toString(), h.original);
        assert.equal(h.fs.files.has(paths.unitFile), false); assert.equal(h.fs.files.has(paths.journalFile), false);
        assert.equal(h.state.running, true); assert.equal(h.state.starts.at(-1), 'unconfigured');
        assert.equal(h.state.sent.length, 0);
    }
});

test('stale locks, incomplete activation journals and foreign service units fail closed', async () => {
    for (const [path, code] of [[paths.lockFile, 'EMAIL_SETUP_BUSY'], [paths.journalFile, 'ACTIVATION_REQUIRES_REVIEW'],
        [paths.unitFile, 'EXISTING_SERVICE_EMAIL_CONFIGURATION']]) {
        const h = await readyHarness(); h.fs.put(path, '{}', path === paths.unitFile ? { uid: 0, mode: 0o644 } : {});
        await assert.rejects(h.run('--activate', confirmation), { code });
        assert.equal(h.state.commands.length, 0); assert.equal(h.state.sent.length, 0);
    }
});

test('changed historical state is detected even when aggregate counts have not changed', async () => {
    let changed = false;
    const h = await readyHarness({ origin(path, state) {
        if (!changed && state.starts.at(-1) === 'false' && path === '/Intelligence') {
            state.historical.stateHash = 'different-row-state'; changed = true;
        }
        return publishedPage(path);
    } });
    await assert.rejects(h.run('--activate', confirmation), { code: 'ACTIVATION_ROLLBACK_FAILED' });
    assert.equal(h.state.starts.includes('true'), false);
    assert.equal(h.fs.get(paths.environmentFile).bytes.toString(), h.original);
});

test('CLI action/flag grammar rejects injection, unknown options, repeated options and misplaced consent', () => {
    assert.deepEqual(parseConfigureArguments(['--activate', '--owner-confirmed-test', '--contact-inboxes-confirmed',
        '--legacy-test-receipt-confirmed', '--support-reply-confirmed']).input, {
        ownerConfirmedTest: true, contactInboxesConfirmed: true, supportReplyConfirmed: true, legacyTestReceiptConfirmed: true
    });
    for (const args of [[], ['--status; whoami'], ['--status', '--owner-confirmed-test'],
        ['--activate', '--owner-confirmed-test'], ['--activate', '--support-reply-confirmed'],
        ['--activate', '--owner-confirmed-test=false', '--contact-inboxes-confirmed'],
        ['--activate', '--owner-confirmed-test', '--contact-inboxes-confirmed', '--contact-inboxes-confirmed'],
        ['--stage', '--unrecognized'], ['--send-test']]) assert.throws(() => parseConfigureArguments(args));
    assert.deepEqual(parseConfigureArguments(['--send-test', '--owner-authorized-send-test']).input, { sendTestAuthorized: true });
});

test('local wrapper transmits staging credentials only through SSH stdin and whitelists success output', async () => {
    const calls = [];
    const run = createResendConfigurator({ readPrivateSetup: async () => fixture, execute(command, args, options) {
        calls.push({ command, args, options });
        return JSON.stringify({ action: 'stage', configured: true, minimumNotificationID: '231', dailyLimit: 80,
            secret: fixture.RESEND_API_KEY, recipient: fixture.BENCHPOLL_EMAIL_TEST_TO, runtime: { smtpConfigured: false,
                configurationError: fixture.RESEND_API_KEY }, queue: { total: 221, highestID: '230', password: fixture.RESEND_API_KEY } });
    } });
    const result = await run(['--stage']);
    assert.deepEqual(JSON.parse(calls[0].options.input), fixture);
    assert.equal(JSON.stringify(calls[0].args).includes(fixture.RESEND_API_KEY), false);
    assert.equal(JSON.stringify(calls[0].args).includes(fixture.BENCHPOLL_EMAIL_TEST_TO), false);
    assert.ok(calls[0].args.includes('StrictHostKeyChecking=yes')); assert.ok(calls[0].args.includes('BatchMode=yes'));
    assert.equal(JSON.stringify(result).includes(fixture.RESEND_API_KEY), false);
    assert.equal(JSON.stringify(result).includes(fixture.BENCHPOLL_EMAIL_TEST_TO), false);
    assert.deepEqual(result.runtime, { smtpConfigured: false, deliveryConfigured: false, configurationValid: false });
});

test('local activation forwards strict contact/legacy confirmation booleans and allows bounded rollback time', async () => {
    const calls = [];
    const run = createResendConfigurator({ readPrivateSetup: () => assert.fail('Activation must not read the local key'),
        execute(command, args, options) { calls.push({ command, args, options }); return '{"action":"activate","enabled":true}'; } });
    await run(['--activate', '--owner-confirmed-test', '--contact-inboxes-confirmed', '--legacy-test-receipt-confirmed']);
    assert.deepEqual(JSON.parse(calls[0].options.input), { ownerConfirmedTest: true, contactInboxesConfirmed: true,
        supportReplyConfirmed: false, legacyTestReceiptConfirmed: true });
    assert.equal(calls[0].options.timeout, 600_000);
    const before = calls.length;
    await assert.rejects(run(['--activate', '--owner-confirmed-test', '--unexpected']));
    assert.equal(calls.length, before);
});

test('child exceptions, arbitrary uppercase codes, stdout and stderr never escape the redacted schema', async () => {
    for (const payload of [fixture.RESEND_API_KEY, JSON.stringify({ errorCode: fixture.RESEND_API_KEY.toUpperCase(),
        smtpStatus: 535, password: fixture.RESEND_API_KEY })]) {
        const run = createResendConfigurator({ execute() { throw Object.assign(new Error(fixture.RESEND_API_KEY), {
            code: fixture.RESEND_API_KEY.toUpperCase(), stderr: payload, stdout: fixture.RESEND_API_KEY
        }); } });
        await assert.rejects(run(['--status']), failure => {
            const output = redactedSetupError('--status', failure);
            assert.equal(output.errorCode, 'EMAIL_SETUP_FAILED');
            assert.equal(JSON.stringify(output).includes(fixture.RESEND_API_KEY), false);
            assert.equal(JSON.stringify(output).includes(fixture.RESEND_API_KEY.toUpperCase()), false);
            return true;
        });
    }
    const output = redactedSetupError(fixture.RESEND_API_KEY, { code: fixture.RESEND_API_KEY.toUpperCase(), responseCode: 12345 });
    assert.equal(output.action, 'invalid'); assert.equal(output.smtpStatus, null);
    assert.throws(() => publicSetupResult('--status', { action: fixture.RESEND_API_KEY }), { code: 'INVALID_REMOTE_RESULT' });
});

test('local private-file parser rejects duplicate settings, injection and unsafe permissions using synthetic files', async () => {
    const file = 'C:/Users/18665/.benchpoll-email-setup-20261018/resend.env', parent = dirname(file);
    const fs = fakeFiles();
    fs.put(parent, '', { type: 'directory', mode: 0o700, realpath: resolve(parent) });
    fs.put(file, `RESEND_API_KEY=${fixture.RESEND_API_KEY}\nBENCHPOLL_EMAIL_TEST_TO='${fixture.BENCHPOLL_EMAIL_TEST_TO}'\n`);
    const deps = { fileSystem: fs, platform: 'linux', uid: () => 1000 };
    assert.deepEqual(await readLocalPrivateSetup(deps), fixture);
    fs.get(file).mode = 0o644;
    await assert.rejects(readLocalPrivateSetup(deps), { code: 'UNSAFE_LOCAL_PRIVATE_FILE' });
    fs.get(file).mode = 0o600;
    for (const extra of [`RESEND_API_KEY=${fixture.RESEND_API_KEY}\n`, 'NODE_OPTIONS=--inspect\n', 'INJECTED=true\n']) {
        fs.get(file).bytes = Buffer.from(`RESEND_API_KEY=${fixture.RESEND_API_KEY}\nBENCHPOLL_EMAIL_TEST_TO=${fixture.BENCHPOLL_EMAIL_TEST_TO}\n${extra}`);
        await assert.rejects(readLocalPrivateSetup(deps), { code: 'INVALID_SETUP_OPTIONS' });
    }
});

test('Windows ACL inspection is fail-closed and emits only a boolean, not account or credential data', async () => {
    const file = 'C:/Users/18665/.benchpoll-email-setup-20261018/resend.env', parent = dirname(file);
    const fs = fakeFiles(); fs.put(parent, '', { type: 'directory', realpath: resolve(parent) });
    fs.put(file, `RESEND_API_KEY=${fixture.RESEND_API_KEY}\nBENCHPOLL_EMAIL_TEST_TO=${fixture.BENCHPOLL_EMAIL_TEST_TO}\n`);
    let accepted = true;
    const deps = { fileSystem: fs, platform: 'win32', execute(command, args, options) {
        assert.equal(command, 'powershell.exe'); assert.ok(args.includes('-NonInteractive')); assert.ok(options.timeout > 0);
        assert.ok(args.at(-1).includes('Get-Acl')); assert.equal(args.at(-1).includes(fixture.RESEND_API_KEY), false);
        return accepted ? 'true\n' : 'false\n';
    } };
    assert.deepEqual(await readLocalPrivateSetup(deps), fixture);
    accepted = false; await assert.rejects(readLocalPrivateSetup(deps), { code: 'UNSAFE_LOCAL_PRIVATE_FILE' });
});

test('stdin limits count UTF-8 bytes and malformed input is redacted', async () => {
    assert.deepEqual(await readSetupInput(Readable.from([JSON.stringify(confirmation)]), 1024), confirmation);
    await assert.rejects(readSetupInput(Readable.from(['"\u4e2d\u6587"']), 4), { code: 'SETUP_INPUT_TOO_LARGE' });
    await assert.rejects(readSetupInput(Readable.from(['{"secret":"' + fixture.RESEND_API_KEY])), { code: 'INVALID_SETUP_OPTIONS' });
});

test('origin checks verify TLS or the installed certificate pin and enforce timeout/response limits without network', async () => {
    let captured;
    function fakeGet(mode) {
        return (_url, options, callback) => {
            captured = options;
            const request = new EventEmitter(); request.destroy = failure => request.emit('error', failure);
            queueMicrotask(() => {
                if (mode === 'timeout') { request.emit('timeout'); return; }
                const response = new EventEmitter(); response.statusCode = 200; response.setEncoding = () => {};
                callback(response);
                response.emit('data', mode === 'large' ? 'x'.repeat(2_000_001) : 'BenchPoll'); response.emit('end');
            });
            return request;
        };
    }
    assert.equal((await originPage('/Intelligence', fakeGet('ok'))).status, 200);
    assert.equal(captured.rejectUnauthorized, true); assert.equal(captured.minVersion, 'TLSv1.2');
    assert.equal(captured.servername, 'benchpoll.com'); assert.equal(captured.timeout, 3000);
    await originPage('/Intelligence', fakeGet('ok'), { ca: 'synthetic-public-certificate', fingerprint256: 'expected' });
    assert.equal(captured.checkServerIdentity('ignored', { fingerprint256: 'expected' }), undefined);
    assert.equal(captured.checkServerIdentity('ignored', { fingerprint256: 'foreign' }).code, 'ORIGIN_TLS_CERTIFICATE_MISMATCH');
    await assert.rejects(originPage('/Intelligence', fakeGet('timeout')), { code: 'HEALTH_TIMEOUT' });
    await assert.rejects(originPage('/Intelligence', fakeGet('large')), { code: 'ORIGIN_RESPONSE_TOO_LARGE' });
    let cancelled = false;
    await assert.rejects(withDeadline(() => new Promise(() => {}), 5, 'HEALTH_TIMEOUT', () => { cancelled = true; }), { code: 'HEALTH_TIMEOUT' });
    assert.equal(cancelled, true);
});

test('queue snapshots run read-only SQL, hash per-row delivery state, redact row data and close connections', async () => {
    const h = harness({ runtime: { BENCHPOLL_DB_PASSWORD: 'synthetic-db-password' } });
    const statements = [];
    let rolledBack = 0, ended = 0;
    const deps = { ...h.dependencies, createConnection: async configuration => {
        assert.equal(configuration.supportBigNumbers, true); assert.equal(configuration.bigNumberStrings, true);
        return {
            async query(options) { statements.push(options.sql); assert.equal(options.timeout, 10_000); },
            async execute(options) {
                statements.push(options.sql); assert.equal(options.timeout, 10_000);
                const summary = { ...historical }; delete summary.stateHash;
                return options.sql.includes('COUNT(*)') ? [[summary]]
                    : [[{ ID: '1', delivery_status: 'pending', attempt_count: 0, last_error: 'synthetic-sensitive-error' }]];
            },
            async rollback() { rolledBack++; }, async end() { ended++; }, destroy() { assert.fail('No timeout expected'); }
        };
    } };
    delete deps.queueSnapshot;
    const result = await createEmailPreflight(deps)('--status');
    assert.equal(rolledBack, 2); assert.equal(ended, 2); assert.equal(result.historicalQueue.total, 221);
    assert.equal(JSON.stringify(result).includes('synthetic-sensitive-error'), false);
    assert.equal('stateHash' in result.historicalQueue, false);
    assert.ok(statements.every(sql => /^START TRANSACTION READ ONLY$|^SELECT\b/.test(sql.trim())));
    assert.equal(statements.some(sql => /recipient_email|SELECT\s+\*/i.test(sql)), false);
});

test('database hard deadline destroys a stalled read-only connection', async () => {
    const h = harness({ runtime: { BENCHPOLL_DB_PASSWORD: 'synthetic-db-password' } });
    let destroyed = false;
    const deps = { ...h.dependencies, databaseTimeout: 5, createConnection: async () => ({
        async query() {}, execute: () => new Promise(() => {}), async rollback() {}, async end() {}, destroy() { destroyed = true; }
    }) };
    delete deps.queueSnapshot;
    await assert.rejects(createEmailPreflight(deps)('--status'), { code: 'DATABASE_TIMEOUT' });
    assert.equal(destroyed, true);
});

test('actual CLI invalid-input paths exit without reading credentials, SSH or sending', () => {
    for (const [file, args, input] of [
        ['../ops/configure-resend-email.mjs', ['--stage', '--unrecognized'], undefined],
        ['../ops/configure-resend-email.mjs', [fixture.RESEND_API_KEY], undefined],
        ['../ops/verify-resend-email.mjs', ['--activate'], '{"ownerConfirmedTest":"true"}'],
        ['../ops/verify-resend-email.mjs', ['--send-test'], '{"sendTestAuthorized":false}']
    ]) {
        assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...args], {
            input, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
        }), failure => {
            assert.equal(failure.status, 1); assert.equal(failure.stdout, '');
            assert.equal(JSON.parse(failure.stderr).ok, false);
            assert.equal(failure.stderr.includes(fixture.RESEND_API_KEY), false);
            return true;
        });
    }
});
