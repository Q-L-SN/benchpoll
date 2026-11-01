import * as fileSystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash, X509Certificate } from 'node:crypto';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import mysql from 'mysql2/promise';

const root = '/home/ubuntu/benchpoll';
const privateDirectory = '/home/ubuntu/.config/benchpoll';
export const emailSetupPaths = Object.freeze({
    privateDirectory,
    environmentFile: join(privateDirectory, 'email.env'),
    intentFile: join(privateDirectory, 'email-test-intent.json'),
    receiptFile: join(privateDirectory, 'email-test-receipt.json'),
    verificationFile: join(privateDirectory, 'email-smtp-verification.json'),
    activationFile: join(privateDirectory, 'email-activation-receipt.json'),
    journalFile: join(privateDirectory, 'email-activation-intent.json'),
    lockFile: join(privateDirectory, 'email-setup.lock'),
    unitDirectory: '/etc/systemd/system/benchpoll.service.d',
    unitFile: '/etc/systemd/system/benchpoll.service.d/email.conf'
});
const historicalFloor = 231n;
const privacyEmail = 'privacy@benchpoll.com';
const replyEmail = 'support@benchpoll.com';
const maximumAge = 24 * 60 * 60_000;
const actions = ['--status', '--stage', '--verify', '--send-test', '--activate'];
const setupError = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const managedName = name => /^BENCHPOLL_(?:SMTP_|EMAIL_|NOTIFICATION_)/.test(name) || name === 'BENCHPOLL_PRIVACY_EMAIL';
const errorCodes = new Set(`INVALID_SETUP_ACTION INVALID_SETUP_OPTIONS INVALID_RESEND_KEY INVALID_TEST_RECIPIENT
INVALID_NOTIFICATION_FLOOR INVALID_ENVIRONMENT EMAIL_CONFIGURATION_REQUIRES_REVIEW SETUP_INPUT_TOO_LARGE
UNSAFE_EMAIL_DIRECTORY UNSAFE_EMAIL_FILE_PERMISSIONS EMAIL_SETUP_BUSY EMAIL_CONFIGURATION_CHANGED
APPLICATION_NOT_RUNNING APPLICATION_DATABASE_UNAVAILABLE INVALID_QUEUE_SNAPSHOT EXISTING_MAIL_CONFIGURATION_REQUIRES_REVIEW
TEST_REQUIRES_PAUSED_DELIVERY TEST_SEND_AUTHORIZATION_REQUIRED TEST_MESSAGE_NOT_ACCEPTED TEST_SEND_REQUIRES_REVIEW
CURRENT_TEST_RECEIPT_REQUIRED FRESH_SMTP_VERIFICATION_REQUIRED LEGACY_TEST_RECEIPT_CONFIRMATION_REQUIRED OWNER_RECEIPT_CONFIRMATION_REQUIRED
CONTACT_INBOX_CONFIRMATION_REQUIRED SMTP_CONNECTION_NOT_VERIFIED SAFE_WORKER_NOT_INSTALLED UNSAFE_WORKER_DATABASE_ACCESS UNSAFE_WORKER_TEST_SEND
UNSAFE_WORKER_TIMER HISTORICAL_QUEUE_NOT_PROTECTED CURRENT_POLICIES_NOT_PUBLISHED EMAIL_PROVIDER_NOT_DISCLOSED
PRIVACY_METADATA_UNAVAILABLE PUBLIC_POLICY_CONFIGURATION_REQUIRES_REVIEW CONTACT_INBOXES_NOT_PUBLISHED
ORIGIN_RESPONSE_TOO_LARGE ORIGIN_TLS_CERTIFICATE_MISMATCH HEALTH_TIMEOUT SMTP_OPERATION_TIMEOUT DATABASE_TIMEOUT HEALTH_CHECK_FAILED
ACTIVATION_REQUIRES_PAUSED_CONFIGURATION EXISTING_SERVICE_EMAIL_CONFIGURATION UNSAFE_SERVICE_DIRECTORY
ACTIVATION_REQUIRES_REVIEW ACTIVATION_STATE_CHANGED SERVICE_NOT_STOPPED POST_ACTIVATION_VERIFICATION_FAILED
ACTIVATION_ROLLBACK_FAILED SETUP_FAILED EMAIL_SETUP_FAILED INVALID_REMOTE_RESULT UNSAFE_LOCAL_PRIVATE_FILE`.split(/\s+/));

export function redactedSetupError(action, error) {
    return { action: actions.includes(action) || action === '--upload' ? action.slice(2) : 'invalid', ok: false,
        errorCode: errorCodes.has(error?.code) ? error.code : 'EMAIL_SETUP_FAILED',
        smtpStatus: Number.isInteger(error?.responseCode) && error.responseCode >= 400 && error.responseCode <= 599
            ? error.responseCode : null,
        ...(action === '--activate' ? { deliveryState: 'requires-status-check' } : {}) };
}

// Whitelist both process boundaries: worker and child output are not trusted log schemas.
export function publicSetupResult(action, result) {
    if ((!actions.includes(action) && action !== '--upload') || !isObject(result) || result.action !== action.slice(2)) {
        throw setupError('INVALID_REMOTE_RESULT');
    }
    const output = { action: result.action };
    for (const name of ['configured', 'liveServiceChanged', 'mailWorkerStarted', 'privateConfigurationPresent',
        'stagedDeliveryEnabled', 'smtpConnectionVerified', 'acceptedByProvider', 'inboxConfirmed', 'alreadyAccepted',
        'enabled', 'alreadyActivated', 'ownerConfirmedTest', 'contactInboxesConfirmed', 'historicalQueueUntouched',
        'replyAddressConfirmed', 'healthy', 'operatorIdentityPending', 'legalComplianceVerified', 'legacyReceiptConfirmed',
        'helperUploaded', 'credentialsUploaded']) {
        if (typeof result[name] === 'boolean') output[name] = result[name];
    }
    for (const name of ['dailyLimit', 'newMessages']) {
        if (Number.isSafeInteger(result[name]) && result[name] >= 0) output[name] = result[name];
    }
    if (typeof result.minimumNotificationID === 'string' && /^[1-9][0-9]{0,15}$/.test(result.minimumNotificationID)) {
        output.minimumNotificationID = result.minimumNotificationID;
    }
    for (const name of ['acceptedAt', 'activatedAt']) {
        if (typeof result[name] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result[name])) output[name] = result[name];
    }
    if (isObject(result.runtime)) output.runtime = {
        smtpConfigured: result.runtime.smtpConfigured === true,
        deliveryConfigured: result.runtime.deliveryConfigured === true,
        configurationValid: result.runtime.configurationValid === true
    };
    for (const name of ['queue', 'historicalQueue']) {
        if (!isObject(result[name])) continue;
        output[name] = {};
        for (const field of ['total', 'pending', 'sending', 'failed', 'sent', 'minimumAttempts', 'maximumAttempts', 'totalAttempts']) {
            if (Number.isSafeInteger(result[name][field]) && result[name][field] >= 0) output[name][field] = result[name][field];
        }
        if (typeof result[name].highestID === 'string' && /^[0-9]{1,16}$/.test(result[name].highestID)) output[name].highestID = result[name].highestID;
    }
    return output;
}

export function validatePrivateResendSetup(input) {
    if (!isObject(input) || Object.keys(input).some(name => !['RESEND_API_KEY', 'BENCHPOLL_EMAIL_TEST_TO'].includes(name))) {
        throw setupError('INVALID_SETUP_OPTIONS');
    }
    const key = input.RESEND_API_KEY, recipient = input.BENCHPOLL_EMAIL_TEST_TO;
    if (typeof key !== 'string' || /[\r\n]/.test(key) || !/^re_[A-Za-z0-9_-]{12,253}$/.test(key)) throw setupError('INVALID_RESEND_KEY');
    if (typeof recipient !== 'string' || recipient.length > 254 || /[\r\n]/.test(recipient)
        || !/^[A-Za-z0-9_%+~-]+(?:\.[A-Za-z0-9_%+~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(recipient)
        || recipient.slice(0, recipient.indexOf('@')).length > 64) throw setupError('INVALID_TEST_RECIPIENT');
    return { key, recipient };
}

export function resendEnvironment(input, minimumID) {
    const { key, recipient } = validatePrivateResendSetup(input);
    if (!['string', 'number'].includes(typeof minimumID) || /[\r\n]/.test(String(minimumID)) || !/^[1-9][0-9]{0,15}$/.test(String(minimumID))
        || BigInt(minimumID) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(minimumID) < historicalFloor) {
        throw setupError('INVALID_NOTIFICATION_FLOOR');
    }
    return {
        BENCHPOLL_SMTP_HOST: 'smtp.resend.com', BENCHPOLL_SMTP_PORT: '465', BENCHPOLL_SMTP_SECURE: 'true',
        BENCHPOLL_SMTP_USER: 'resend', BENCHPOLL_SMTP_PASSWORD: key,
        BENCHPOLL_NOTIFICATION_FROM: 'BenchPoll <notifications@benchpoll.com>',
        BENCHPOLL_EMAIL_DELIVERY_ENABLED: 'false', BENCHPOLL_EMAIL_DAILY_LIMIT: '80',
        BENCHPOLL_EMAIL_MIN_OUTBOX_ID: String(minimumID), BENCHPOLL_EMAIL_TEST_TO: recipient
    };
}

export function serializePrivateEnvironment(environment) {
    if (!isObject(environment)) throw setupError('INVALID_ENVIRONMENT');
    return Object.entries(environment).map(([name, value]) => {
        if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value)
            || /['\\]/.test(value)) throw setupError('INVALID_ENVIRONMENT');
        return `${name}='${value}'`;
    }).join('\n') + '\n';
}

export function parsePrivateEnvironment(bytes) {
    const lines = bytes.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const environment = {};
    for (const line of lines) {
        // Accept the previous helper's unescaped double quotes, not comments, duplicates or dotenv-only syntax.
        const match = /^([A-Z][A-Z0-9_]*)=(?:'([^'\\]*)'|"([^"\\]*)")$/.exec(line);
        if (!match || Object.hasOwn(environment, match[1])) throw setupError('INVALID_ENVIRONMENT');
        environment[match[1]] = match[2] ?? match[3];
    }
    serializePrivateEnvironment(environment);
    const expected = resendEnvironment({ RESEND_API_KEY: environment.BENCHPOLL_SMTP_PASSWORD,
        BENCHPOLL_EMAIL_TEST_TO: environment.BENCHPOLL_EMAIL_TEST_TO }, environment.BENCHPOLL_EMAIL_MIN_OUTBOX_ID);
    const allowed = new Set([...Object.keys(expected), 'BENCHPOLL_PRIVACY_EMAIL', 'BENCHPOLL_NOTIFICATION_REPLY_TO']);
    if (Object.keys(environment).some(name => !allowed.has(name))
        || Object.entries(expected).some(([name, value]) => name !== 'BENCHPOLL_EMAIL_DELIVERY_ENABLED' && environment[name] !== value)
        || !['true', 'false'].includes(environment.BENCHPOLL_EMAIL_DELIVERY_ENABLED)
        || (Object.hasOwn(environment, 'BENCHPOLL_PRIVACY_EMAIL') && environment.BENCHPOLL_PRIVACY_EMAIL !== privacyEmail)
        || (Object.hasOwn(environment, 'BENCHPOLL_NOTIFICATION_REPLY_TO') && environment.BENCHPOLL_NOTIFICATION_REPLY_TO !== replyEmail)
        || (Object.hasOwn(environment, 'BENCHPOLL_PRIVACY_EMAIL') && !Object.hasOwn(environment, 'BENCHPOLL_NOTIFICATION_REPLY_TO'))) {
        throw setupError('EMAIL_CONFIGURATION_REQUIRES_REVIEW');
    }
    return environment;
}

function configurationHash(environment) {
    const normalized = { ...environment, BENCHPOLL_EMAIL_DELIVERY_ENABLED: 'false' };
    delete normalized.BENCHPOLL_PRIVACY_EMAIL;
    delete normalized.BENCHPOLL_NOTIFICATION_REPLY_TO;
    return hash(serializePrivateEnvironment(Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)))));
}

export async function withDeadline(operation, milliseconds, code, cancel = () => {}) {
    let timer;
    try {
        return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
            timer = setTimeout(() => { try { cancel(); } catch { /* Preserve the bounded failure. */ } reject(setupError(code)); }, milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}

export function createResendTransport(environment, createTransport = options => nodemailer.createTransport(options)) {
    return createTransport({ host: 'smtp.resend.com', port: 465, secure: true,
        auth: { user: 'resend', pass: environment.BENCHPOLL_SMTP_PASSWORD },
        logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
        dnsTimeout: 10_000, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
        tls: { servername: 'smtp.resend.com', minVersion: 'TLSv1.2', rejectUnauthorized: true } });
}

export function originPage(path, get = https.get, trust = {}) {
    return new Promise((resolvePage, reject) => {
        let timer;
        const request = get('https://127.0.0.1:1337' + path, {
            agent: false, servername: 'benchpoll.com', rejectUnauthorized: true, minVersion: 'TLSv1.2',
            ...(trust.ca ? { ca: trust.ca, allowPartialTrustChain: true,
                checkServerIdentity: (_hostname, certificate) => certificate.fingerprint256 === trust.fingerprint256
                    ? undefined : setupError('ORIGIN_TLS_CERTIFICATE_MISMATCH') } : {}),
            timeout: 3000, headers: { Host: 'benchpoll.com' }
        }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                body += chunk;
                if (Buffer.byteLength(body) > 2_000_000) request.destroy(setupError('ORIGIN_RESPONSE_TOO_LARGE'));
            });
            response.on('end', () => { clearTimeout(timer); resolvePage({ status: response.statusCode, body }); });
            response.on('error', error => { clearTimeout(timer); reject(error); });
            response.on('aborted', () => { clearTimeout(timer); reject(setupError('HEALTH_CHECK_FAILED')); });
        });
        timer = setTimeout(() => request.destroy(setupError('HEALTH_TIMEOUT')), 3000);
        request.on('timeout', () => request.destroy(setupError('HEALTH_TIMEOUT')));
        request.on('error', error => { clearTimeout(timer); reject(error); });
    });
}

function validateOptions(action, options) {
    if (!isObject(options)) throw setupError('INVALID_SETUP_OPTIONS');
    const names = action === '--activate'
        ? ['ownerConfirmedTest', 'supportReplyConfirmed', 'contactInboxesConfirmed', 'legacyTestReceiptConfirmed']
        : action === '--send-test' ? ['sendTestAuthorized'] : action === '--stage' ? ['input'] : [];
    if (Object.keys(options).some(name => !names.includes(name) || (name !== 'input' && typeof options[name] !== 'boolean'))) {
        throw setupError('INVALID_SETUP_OPTIONS');
    }
    if (action === '--activate') {
        if (options.ownerConfirmedTest !== true) throw setupError('OWNER_RECEIPT_CONFIRMATION_REQUIRED');
        if (options.contactInboxesConfirmed !== true) throw setupError('CONTACT_INBOX_CONFIRMATION_REQUIRED');
    }
    if (action === '--send-test' && options.sendTestAuthorized !== true) throw setupError('TEST_SEND_AUTHORIZATION_REQUIRED');
}

// Injection is limited to imported offline tests; CLI callers cannot override paths or dependencies.
export function createEmailPreflight(dependencies = {}) {
    const fs = dependencies.fileSystem ?? fileSystem;
    const paths = emailSetupPaths;
    const uid = dependencies.uid ?? (() => process.getuid());
    const now = dependencies.now ?? Date.now;
    const uuid = dependencies.uuid ?? randomUUID;
    const sleep = dependencies.sleep ?? delay;
    const loadWorker = dependencies.loadWorker ?? (() => import(pathToFileURL(join(root, 'moderation-email.js')).href));
    let originTrust;
    const readOrigin = dependencies.originPage ?? (async path => {
        if (!originTrust) {
            // Trust the installed public leaf certificate, never the private key or an arbitrary loopback peer.
            const certificateFile = join(root, 'server.crt');
            const owner = (await fs.lstat(certificateFile)).uid;
            if (owner !== 0 && owner !== uid()) throw setupError('UNSAFE_EMAIL_FILE_PERMISSIONS');
            const { bytes } = await protectedRead(certificateFile, owner, 0o022);
            originTrust = { ca: bytes, fingerprint256: new X509Certificate(bytes).fingerprint256 };
        }
        return originPage(path, https.get, originTrust);
    });
    const execute = (command, args, timeout = 15_000) => (dependencies.execute ?? execFileSync)(command, args, {
        encoding: 'utf8', timeout, maxBuffer: 65_536, stdio: ['ignore', 'pipe', 'pipe']
    });
    const systemctl = (action, timeout = 45_000) => execute('sudo', ['-n', 'systemctl', action,
        ...(action === 'daemon-reload' ? [] : ['benchpoll.service'])], timeout);
    const unitContent = `[Service]\nEnvironmentFile=${paths.environmentFile}\n`;

    async function exists(path) {
        try { await fs.lstat(path); return true; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }
    async function directory(create = false) {
        if (create) await fs.mkdir(paths.privateDirectory, { recursive: true, mode: 0o700 });
        const info = await fs.lstat(paths.privateDirectory);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid() || info.mode & 0o077
            || await fs.realpath(paths.privateDirectory) !== paths.privateDirectory) throw setupError('UNSAFE_EMAIL_DIRECTORY');
    }
    async function protectedRead(path, owner = uid(), mask = 0o077) {
        const before = await fs.lstat(path);
        const valid = info => info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === owner
            && !(info.mode & mask) && info.size <= 16_384;
        if (!valid(before)) throw setupError('UNSAFE_EMAIL_FILE_PERMISSIONS');
        const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
            const opened = await handle.stat();
            if (!valid(opened) || opened.ino !== before.ino || opened.dev !== before.dev) throw setupError('UNSAFE_EMAIL_FILE_PERMISSIONS');
            const bytes = await handle.readFile();
            if (bytes.length > 16_384) throw setupError('SETUP_INPUT_TOO_LARGE');
            return { bytes, info: opened };
        } finally { await handle.close(); }
    }
    async function writePrivate(path, bytes) {
        const handle = await fs.open(path, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
    }
    async function protectedEnvironment() {
        await directory();
        const { bytes } = await protectedRead(paths.environmentFile);
        return { bytes, environment: parsePrivateEnvironment(bytes) };
    }
    async function protectedJSON(path) {
        const { bytes } = await protectedRead(path);
        try { return JSON.parse(bytes.toString('utf8')); }
        catch { throw setupError('ACTIVATION_REQUIRES_REVIEW'); }
    }
    async function replacePrivate(path, bytes, expectedHash) {
        if (hash((await protectedRead(path)).bytes) !== expectedHash) throw setupError('EMAIL_CONFIGURATION_CHANGED');
        const temporary = `${path}.${uuid()}.tmp`;
        await writePrivate(temporary, bytes);
        try {
            if (hash((await protectedRead(path)).bytes) !== expectedHash) throw setupError('EMAIL_CONFIGURATION_CHANGED');
            await fs.rename(temporary, path);
        } finally { if (await exists(temporary)) await fs.unlink(temporary); }
    }
    const replaceEnvironment = (bytes, expectedHash) => replacePrivate(paths.environmentFile, bytes, expectedHash);
    async function recordVerification(environment) {
        const bytes = JSON.stringify({ version: 1, configurationHash: configurationHash(environment),
            verifiedAt: new Date(now()).toISOString(), smtpConnectionVerified: true, newMessages: 0 });
        if (await exists(paths.verificationFile)) {
            await replacePrivate(paths.verificationFile, bytes, hash((await protectedRead(paths.verificationFile)).bytes));
        } else await writePrivate(paths.verificationFile, bytes);
    }
    async function assertFreshVerification(environment) {
        let verification;
        try { verification = await protectedJSON(paths.verificationFile); }
        catch (error) { if (error.code === 'ENOENT') throw setupError('FRESH_SMTP_VERIFICATION_REQUIRED'); throw error; }
        const age = now() - Date.parse(verification?.verifiedAt);
        if (!isObject(verification) || verification.version !== 1 || verification.smtpConnectionVerified !== true
            || verification.newMessages !== 0 || verification.configurationHash !== configurationHash(environment)
            || !Number.isFinite(age) || age < 0 || age > 15 * 60_000
            || Object.keys(verification).some(name => !['version', 'smtpConnectionVerified', 'newMessages', 'configurationHash', 'verifiedAt'].includes(name))) {
            throw setupError('FRESH_SMTP_VERIFICATION_REQUIRED');
        }
    }
    async function withLock(operation) {
        await directory(true);
        try { await writePrivate(paths.lockFile, JSON.stringify({ token: uuid(), createdAt: new Date(now()).toISOString() })); }
        catch (error) { if (error.code === 'EEXIST') throw setupError('EMAIL_SETUP_BUSY'); throw error; }
        const lock = await protectedRead(paths.lockFile);
        try { return await operation(); }
        finally {
            const current = await protectedRead(paths.lockFile);
            if (current.info.ino === lock.info.ino && hash(current.bytes) === hash(lock.bytes)) await fs.unlink(paths.lockFile);
        }
    }
    const runtimeEnvironment = dependencies.runtimeEnvironment ?? (async () => {
        const environment = dotenv.parse(await fs.readFile(join(root, '.env')));
        const pid = execute('systemctl', ['show', 'benchpoll.service', '--property=MainPID', '--value']).trim();
        if (!/^[1-9][0-9]*$/.test(pid)) throw setupError('APPLICATION_NOT_RUNNING');
        for (const item of (await fs.readFile(`/proc/${pid}/environ`, 'utf8')).split('\0')) {
            const separator = item.indexOf('=');
            if (separator > 0) environment[item.slice(0, separator)] = item.slice(separator + 1);
        }
        if (execute('systemctl', ['show', 'benchpoll.service', '--property=MainPID', '--value']).trim() !== pid) {
            throw setupError('APPLICATION_NOT_RUNNING');
        }
        return environment;
    });
    const queueSnapshot = dependencies.queueSnapshot ?? (async (environment, belowID = null) => {
        const password = environment.BENCHPOLL_DB_PASSWORD ?? environment.DB_PASSWORD;
        if (password === undefined) throw setupError('APPLICATION_DATABASE_UNAVAILABLE');
        const connection = await (dependencies.createConnection ?? mysql.createConnection)({ socketPath: environment.BENCHPOLL_DB_SOCKET || undefined,
            host: environment.BENCHPOLL_DB_HOST || 'localhost', port: Number(environment.BENCHPOLL_DB_PORT || 3306),
            user: environment.BENCHPOLL_DB_USER || 'root', password, database: environment.BENCHPOLL_DB_NAME || 'benchmarks',
            supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 10_000, dateStrings: true });
        return withDeadline(async () => {
            try {
                await connection.query({ sql: 'START TRANSACTION READ ONLY', timeout: 10_000 });
                const where = belowID === null ? '' : ' WHERE ID < ?';
                const parameters = belowID === null ? [] : [belowID];
                const [[row]] = await connection.execute({ sql: `SELECT COUNT(*) AS total,
                    COALESCE(SUM(delivery_status = 'pending'), 0) AS pending,
                    COALESCE(SUM(delivery_status = 'sending'), 0) AS sending,
                    COALESCE(SUM(delivery_status = 'failed'), 0) AS failed,
                    COALESCE(SUM(delivery_status = 'sent'), 0) AS sent,
                    COALESCE(MIN(attempt_count), 0) AS minimumAttempts, COALESCE(MAX(attempt_count), 0) AS maximumAttempts,
                    COALESCE(SUM(attempt_count), 0) AS totalAttempts, CAST(COALESCE(MAX(ID), 0) AS CHAR) AS highestID
                    FROM moderation_email_outbox${where}`, timeout: 10_000 }, parameters);
                const summary = Object.fromEntries(Object.entries(row).map(([name, value]) => [name, name === 'highestID' ? String(value) : Number(value)]));
                if (!/^(?:0|[1-9][0-9]{0,15})$/.test(summary.highestID) || BigInt(summary.highestID) >= BigInt(Number.MAX_SAFE_INTEGER)
                    || Object.entries(summary).some(([name, value]) => name !== 'highestID' && (!Number.isSafeInteger(value) || value < 0))) {
                    throw setupError('INVALID_QUEUE_SNAPSHOT');
                }
                if (belowID !== null) {
                    const [rows] = await connection.execute({ sql: `SELECT CAST(ID AS CHAR) AS ID, delivery_status, attempt_count,
                        sent_at, locked_at, next_attempt_at, last_error, updated_at
                        FROM moderation_email_outbox WHERE ID < ? ORDER BY ID`, timeout: 10_000 }, [belowID]);
                    summary.stateHash = hash(JSON.stringify(rows));
                }
                return summary;
            } finally { try { await connection.rollback(); } finally { await connection.end(); } }
        }, dependencies.databaseTimeout ?? 15_000, 'DATABASE_TIMEOUT', () => connection.destroy());
    });
    function assertUnconfigured(runtime) {
        if (Object.keys(runtime).some(name => managedName(name) && name !== 'BENCHPOLL_PRIVACY_EMAIL')
            || (Object.hasOwn(runtime, 'BENCHPOLL_PRIVACY_EMAIL') && runtime.BENCHPOLL_PRIVACY_EMAIL !== privacyEmail)) {
            throw setupError('EXISTING_MAIL_CONFIGURATION_REQUIRES_REVIEW');
        }
    }
    async function assertRuntime(expected) {
        const runtime = await runtimeEnvironment();
        if (Object.entries(expected).some(([name, value]) => runtime[name] !== value)
            || Object.keys(runtime).some(name => managedName(name) && !Object.hasOwn(expected, name))) {
            throw setupError('POST_ACTIVATION_VERIFICATION_FAILED');
        }
        const inspection = (await loadWorker()).inspectModerationEmailConfiguration(runtime);
        if (inspection.configurationError || !inspection.smtpConfigured
            || inspection.deliveryConfigured !== (expected.BENCHPOLL_EMAIL_DELIVERY_ENABLED === 'true')) {
            throw setupError('POST_ACTIVATION_VERIFICATION_FAILED');
        }
        return runtime;
    }
    async function status() {
        const runtime = await runtimeEnvironment();
        const inspection = (await loadWorker()).inspectModerationEmailConfiguration(runtime);
        const configured = await exists(paths.environmentFile);
        const environment = configured ? (await protectedEnvironment()).environment : null;
        return { action: 'status', privateConfigurationPresent: configured,
            stagedDeliveryEnabled: environment?.BENCHPOLL_EMAIL_DELIVERY_ENABLED === 'true',
            minimumNotificationID: environment?.BENCHPOLL_EMAIL_MIN_OUTBOX_ID,
            dailyLimit: environment ? Number(environment.BENCHPOLL_EMAIL_DAILY_LIMIT) : undefined,
            runtime: { smtpConfigured: inspection.smtpConfigured, deliveryConfigured: inspection.deliveryConfigured,
                configurationValid: !inspection.configurationError }, queue: await queueSnapshot(runtime),
            ...(environment ? { historicalQueue: await queueSnapshot(runtime, environment.BENCHPOLL_EMAIL_MIN_OUTBOX_ID) } : {}) };
    }
    async function stage(input) {
        if (await exists(paths.journalFile) || await exists(paths.unitFile) || await exists(paths.activationFile)) {
            throw setupError('ACTIVATION_REQUIRES_REVIEW');
        }
        const runtime = await runtimeEnvironment();
        assertUnconfigured(runtime);
        if ((await loadWorker()).inspectModerationEmailConfiguration(runtime).configurationError) {
            throw setupError('EXISTING_MAIL_CONFIGURATION_REQUIRES_REVIEW');
        }
        const queue = await queueSnapshot(runtime);
        if (typeof queue.highestID !== 'string' || /[\r\n]/.test(queue.highestID)
            || !/^(?:0|[1-9][0-9]{0,15})$/.test(queue.highestID)) throw setupError('INVALID_QUEUE_SNAPSHOT');
        if (await exists(paths.environmentFile)) {
            const { environment } = await protectedEnvironment();
            const requested = resendEnvironment(input, environment.BENCHPOLL_EMAIL_MIN_OUTBOX_ID);
            if (environment.BENCHPOLL_EMAIL_DELIVERY_ENABLED !== 'false' || configurationHash(environment) !== configurationHash(requested)) {
                throw setupError('EMAIL_CONFIGURATION_REQUIRES_REVIEW');
            }
            return { action: 'stage', configured: true, liveServiceChanged: false, mailWorkerStarted: false,
                dailyLimit: 80, minimumNotificationID: environment.BENCHPOLL_EMAIL_MIN_OUTBOX_ID, queue };
        }
        if (await exists(paths.intentFile) || await exists(paths.receiptFile)) throw setupError('TEST_SEND_REQUIRES_REVIEW');
        const nextID = BigInt(queue.highestID) + 1n;
        const environment = resendEnvironment(input, String(nextID > historicalFloor ? nextID : historicalFloor));
        await writePrivate(paths.environmentFile, serializePrivateEnvironment(environment));
        return { action: 'stage', configured: true, liveServiceChanged: false, mailWorkerStarted: false,
            dailyLimit: 80, minimumNotificationID: environment.BENCHPOLL_EMAIL_MIN_OUTBOX_ID, queue };
    }
    async function testEvidence(environment, allowLegacy = false) {
        let intent, receipt;
        try { intent = await protectedJSON(paths.intentFile); receipt = await protectedJSON(paths.receiptFile); }
        catch (error) { if (error.code === 'ENOENT') throw setupError('CURRENT_TEST_RECEIPT_REQUIRED'); throw error; }
        const attempted = Date.parse(intent?.attemptedAt), accepted = Date.parse(receipt?.acceptedAt);
        const legacy = intent?.version === undefined && receipt?.version === undefined;
        const allowedIntent = ['idempotencyKey', 'attemptedAt', ...(legacy ? [] : ['version', 'configurationHash'])];
        const allowedReceipt = ['action', 'smtpConnectionVerified', 'acceptedByProvider', 'inboxConfirmed', 'acceptedAt',
            'newMessages', 'mailWorkerStarted', ...(legacy ? [] : ['version', 'configurationHash', 'idempotencyKey'])];
        if (!isObject(intent) || !isObject(receipt) || Object.keys(intent).some(name => !allowedIntent.includes(name))
            || Object.keys(receipt).some(name => !allowedReceipt.includes(name))
            || !/^benchpoll\/setup\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(intent.idempotencyKey)
            || !Number.isFinite(attempted) || !Number.isFinite(accepted) || accepted < attempted || accepted - attempted > maximumAge
            || now() < accepted || now() < attempted
            || receipt.action !== 'send-test' || receipt.smtpConnectionVerified !== true || receipt.acceptedByProvider !== true
            || receipt.inboxConfirmed !== false || receipt.newMessages !== 1 || receipt.mailWorkerStarted !== false) {
            throw setupError('CURRENT_TEST_RECEIPT_REQUIRED');
        }
        if (legacy) {
            if (!allowLegacy) throw setupError('LEGACY_TEST_RECEIPT_CONFIRMATION_REQUIRED');
            // This records a human attestation about an existing send, not reconstructed cryptographic evidence.
        } else if (intent.version !== 2 || receipt.version !== 2 || intent.configurationHash !== configurationHash(environment)
            || receipt.configurationHash !== intent.configurationHash || receipt.idempotencyKey !== intent.idempotencyKey) {
            throw setupError('CURRENT_TEST_RECEIPT_REQUIRED');
        }
        return { receipt, legacy };
    }
    async function verify(sendTest) {
        const { environment } = await protectedEnvironment();
        if (environment.BENCHPOLL_EMAIL_DELIVERY_ENABLED !== 'false' || await exists(paths.journalFile) || await exists(paths.unitFile)) {
            throw setupError('TEST_REQUIRES_PAUSED_DELIVERY');
        }
        assertUnconfigured(await runtimeEnvironment());
        if (sendTest && await exists(paths.receiptFile)) {
            // Valid legacy evidence also suppresses duplicate tests; activation needs its own explicit attestation.
            await testEvidence(environment, true);
            return { action: 'send-test', alreadyAccepted: true, newMessages: 0, mailWorkerStarted: false };
        }
        if (sendTest && await exists(paths.intentFile)) throw setupError('TEST_SEND_REQUIRES_REVIEW');
        const transport = createResendTransport(environment, dependencies.createTransport);
        try {
            const verified = await withDeadline(() => transport.verify(), dependencies.smtpTimeout ?? 45_000,
                'SMTP_OPERATION_TIMEOUT', () => transport.close());
            if (verified !== true) throw setupError('SMTP_CONNECTION_NOT_VERIFIED');
            await recordVerification(environment);
            if (!sendTest) return { action: 'verify', smtpConnectionVerified: true, newMessages: 0, mailWorkerStarted: false };
            const intent = { version: 2, idempotencyKey: `benchpoll/setup/${uuid()}`,
                attemptedAt: new Date(now()).toISOString(), configurationHash: configurationHash(environment) };
            await writePrivate(paths.intentFile, JSON.stringify(intent));
            const result = await withDeadline(() => transport.sendMail({
                from: environment.BENCHPOLL_NOTIFICATION_FROM, to: environment.BENCHPOLL_EMAIL_TEST_TO,
                envelope: { from: 'notifications@benchpoll.com', to: [environment.BENCHPOLL_EMAIL_TEST_TO] },
                subject: 'BenchPoll email delivery test',
                text: 'This is the single email delivery test you requested for BenchPoll.\n\nIt is not a historical review notification.\n\nPlease confirm that this message arrived in your inbox (or spam folder).',
                headers: { 'Resend-Idempotency-Key': intent.idempotencyKey }
            }), dependencies.smtpTimeout ?? 45_000, 'SMTP_OPERATION_TIMEOUT', () => transport.close());
            if (result.accepted?.length !== 1 || result.accepted[0] !== environment.BENCHPOLL_EMAIL_TEST_TO
                || !Array.isArray(result.rejected) || result.rejected.length) throw setupError('TEST_MESSAGE_NOT_ACCEPTED');
            const receipt = { version: 2, action: 'send-test', idempotencyKey: intent.idempotencyKey,
                configurationHash: intent.configurationHash, smtpConnectionVerified: true, acceptedByProvider: true,
                inboxConfirmed: false, acceptedAt: new Date(now()).toISOString(), newMessages: 1, mailWorkerStarted: false };
            await writePrivate(paths.receiptFile, JSON.stringify(receipt));
            return receipt;
        } finally { transport.close(); }
    }
    async function assertDeliveryControls(environment) {
        const { createModerationEmailService, inspectModerationEmailConfiguration } = await loadWorker();
        const guard = { execute() { throw setupError('UNSAFE_WORKER_DATABASE_ACCESS'); } };
        const transport = { sendMail() { throw setupError('UNSAFE_WORKER_TEST_SEND'); } };
        const pausedEnvironment = { ...environment, BENCHPOLL_EMAIL_DELIVERY_ENABLED: 'false' };
        const inspection = inspectModerationEmailConfiguration(pausedEnvironment);
        if (!inspection.smtpConfigured || inspection.configurationError || inspection.deliveryConfigured) throw setupError('SAFE_WORKER_NOT_INSTALLED');
        const options = { pool: guard, publicOrigin: 'https://benchpoll.com', transport,
            setIntervalFunction() { throw setupError('UNSAFE_WORKER_TIMER'); } };
        const paused = createModerationEmailService({ ...options, environment: pausedEnvironment });
        if (paused.deliveryConfigured || (await paused.deliver(231)).reason !== 'delivery_paused') throw setupError('SAFE_WORKER_NOT_INSTALLED');
        await paused.drain(); paused.kick(231); paused.start();
        const active = createModerationEmailService({ ...options, environment: { ...environment, BENCHPOLL_EMAIL_DELIVERY_ENABLED: 'true' } });
        if (!active.deliveryConfigured || (await active.deliver(Number(environment.BENCHPOLL_EMAIL_MIN_OUTBOX_ID) - 1)).reason !== 'below_min_outbox_id') {
            throw setupError('HISTORICAL_QUEUE_NOT_PROTECTED');
        }
    }
    async function healthy() {
        for (let attempt = 0; attempt < 8; attempt++) {
            let page;
            try { page = await readOrigin('/Intelligence'); }
            catch (error) {
                if (!['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'HEALTH_TIMEOUT'].includes(error?.code)) throw error;
            }
            if (page?.status === 200 && page.body.includes('BenchPoll')) return;
            await sleep(500);
        }
        throw setupError('HEALTH_CHECK_FAILED');
    }
    async function assertPublishedPolicies() {
        for (const path of ['/privacy', '/terms', '/cookies', '/community-guidelines']) {
            const page = await readOrigin(path);
            if (page.status !== 200 || !page.body.includes('datetime="2026-10-18"')) throw setupError('CURRENT_POLICIES_NOT_PUBLISHED');
            if (path === '/privacy' && !page.body.includes('Resend')) throw setupError('EMAIL_PROVIDER_NOT_DISCLOSED');
        }
        const metadata = await readOrigin('/api/privacy_information');
        if (metadata.status !== 200) throw setupError('PRIVACY_METADATA_UNAVAILABLE');
        let information;
        try { information = JSON.parse(metadata.body); } catch { throw setupError('PRIVACY_METADATA_UNAVAILABLE'); }
        if (information?.versions?.terms !== '2026-10-18' || information.versions?.privacy !== '2026-10-18'
            || information.versions?.research !== '2026-10-17' || information.operator?.displayName !== 'BenchPoll operator'
            || information.operator?.identityPending !== true) throw setupError('PUBLIC_POLICY_CONFIGURATION_REQUIRES_REVIEW');
        if (information.operator.email !== privacyEmail) throw setupError('CONTACT_INBOXES_NOT_PUBLISHED');
    }
    function assertStopped() {
        if (execute('systemctl', ['show', 'benchpoll.service', '--property=MainPID', '--value']).trim() !== '0') {
            throw setupError('SERVICE_NOT_STOPPED');
        }
    }
    async function sameHistory(runtime, minimumID, before) {
        if (JSON.stringify(await queueSnapshot(runtime, minimumID)) !== JSON.stringify(before)) {
            throw setupError('POST_ACTIVATION_VERIFICATION_FAILED');
        }
    }
    async function activate(options) {
        const { environment, bytes: before } = await protectedEnvironment();
        if (await exists(paths.activationFile)) {
            const recorded = await protectedJSON(paths.activationFile);
            if (recorded.version !== 2 || recorded.afterHash !== hash(before) || recorded.configurationHash !== configurationHash(environment)
                || recorded.contactInboxesConfirmed !== true || recorded.ownerConfirmedTest !== true
                || environment.BENCHPOLL_EMAIL_DELIVERY_ENABLED !== 'true' || environment.BENCHPOLL_PRIVACY_EMAIL !== privacyEmail
                || environment.BENCHPOLL_NOTIFICATION_REPLY_TO !== replyEmail
                || (await protectedRead(paths.unitFile, 0, 0o022)).bytes.toString('utf8') !== unitContent) {
                throw setupError('ACTIVATION_STATE_CHANGED');
            }
            const runtime = await assertRuntime(environment);
            await sameHistory(runtime, environment.BENCHPOLL_EMAIL_MIN_OUTBOX_ID, recorded.historical);
            await healthy();
            await assertPublishedPolicies();
            return { action: 'activate', enabled: true, alreadyActivated: true, newMessages: 0,
                ownerConfirmedTest: true, contactInboxesConfirmed: true, replyAddressConfirmed: true,
                operatorIdentityPending: true, legalComplianceVerified: false, healthy: true,
                minimumNotificationID: environment.BENCHPOLL_EMAIL_MIN_OUTBOX_ID, dailyLimit: 80, historicalQueueUntouched: true };
        }
        if (await exists(paths.journalFile)) throw setupError('ACTIVATION_REQUIRES_REVIEW');
        if (environment.BENCHPOLL_EMAIL_DELIVERY_ENABLED !== 'false') throw setupError('ACTIVATION_REQUIRES_PAUSED_CONFIGURATION');
        const evidence = await testEvidence(environment, options.legacyTestReceiptConfirmed === true);
        await assertFreshVerification(environment);
        await assertDeliveryControls(environment);
        if (await exists(paths.unitFile)) throw setupError('EXISTING_SERVICE_EMAIL_CONFIGURATION');
        const originalRuntime = await runtimeEnvironment();
        assertUnconfigured(originalRuntime);
        // Validate certificate/file trust and the current app before any service interruption.
        await healthy();
        const minimumID = environment.BENCHPOLL_EMAIL_MIN_OUTBOX_ID;
        const historical = await queueSnapshot(originalRuntime, minimumID);
        const paused = { ...environment, BENCHPOLL_EMAIL_DELIVERY_ENABLED: 'false',
            BENCHPOLL_PRIVACY_EMAIL: privacyEmail, BENCHPOLL_NOTIFICATION_REPLY_TO: replyEmail };
        const pausedBytes = serializePrivateEnvironment(paused), pausedHash = hash(pausedBytes);
        const enabled = { ...paused, BENCHPOLL_EMAIL_DELIVERY_ENABLED: 'true' };
        const after = serializePrivateEnvironment(enabled), afterHash = hash(after), beforeHash = hash(before);
        const backup = join(privateDirectory, `email-before-activation-${uuid()}.env`);
        const localUnit = join(privateDirectory, `email-unit-${uuid()}.conf`);
        const temporaryUnit = `${paths.unitFile}.${uuid()}.tmp`;
        await writePrivate(backup, before);
        await writePrivate(localUnit, unitContent);
        await writePrivate(paths.journalFile, JSON.stringify({ version: 2, beforeHash, pausedHash, afterHash, backup,
            configurationHash: configurationHash(environment), legacyReceiptConfirmed: evidence.legacy }));
        let serviceTouched = false, installedUnit = false, temporaryInstalled = false, unitIdentity;
        let phase = 'stop-before-pause';
        try {
            serviceTouched = true;
            systemctl('stop'); assertStopped();
            phase = 'install-paused-configuration';
            await replaceEnvironment(pausedBytes, beforeHash);
            if (!await exists(paths.unitDirectory)) execute('sudo', ['-n', 'install', '-d', '-m', '0755', paths.unitDirectory]);
            const unitDirectory = await fs.lstat(paths.unitDirectory);
            if (!unitDirectory.isDirectory() || unitDirectory.isSymbolicLink() || unitDirectory.uid !== 0 || unitDirectory.mode & 0o022) {
                throw setupError('UNSAFE_SERVICE_DIRECTORY');
            }
            execute('sudo', ['-n', 'install', '-o', 'root', '-g', 'root', '-m', '0644', localUnit, temporaryUnit]);
            temporaryInstalled = true;
            unitIdentity = (await protectedRead(temporaryUnit, 0, 0o022)).info;
            execute('sudo', ['-n', 'ln', temporaryUnit, paths.unitFile]);
            installedUnit = true;
            execute('sudo', ['-n', 'unlink', temporaryUnit]); temporaryInstalled = false;
            phase = 'start-paused-service';
            systemctl('daemon-reload', 15_000); systemctl('start');
            await healthy();
            phase = 'verify-paused-service';
            const pausedRuntime = await assertRuntime(paused);
            await sameHistory(pausedRuntime, minimumID, historical);
            await assertPublishedPolicies();
            await assertFreshVerification(paused);
            phase = 'stop-before-enabling';
            systemctl('stop'); assertStopped();
            await replaceEnvironment(after, pausedHash);
            systemctl('start');
            phase = 'verify-enabled-service';
            await healthy();
            const activeRuntime = await assertRuntime(enabled);
            await sameHistory(activeRuntime, minimumID, historical);
            phase = 'record-activation';
            const activation = { version: 2, action: 'activate', enabled: true, activatedAt: new Date(now()).toISOString(),
                ownerConfirmedTest: true, contactInboxesConfirmed: true, dailyLimit: 80, minimumNotificationID: minimumID,
                historicalQueueUntouched: true, replyAddressConfirmed: true, healthy: true,
                operatorIdentityPending: true, legalComplianceVerified: false, legacyReceiptConfirmed: evidence.legacy };
            await writePrivate(paths.activationFile, JSON.stringify({ ...activation, configurationHash: configurationHash(environment),
                beforeHash, afterHash, backup, historical }));
            return activation;
        } catch (error) {
            let failed = false, stopped = false;
            const rollbackIssues = [];
            const safeCode = failure => errorCodes.has(failure?.code) ? failure.code
                : ['ENOENT', 'EEXIST', 'EACCES', 'EPERM', 'ETIMEDOUT'].includes(failure?.code) ? failure.code : 'SETUP_FAILED';
            const issue = (step, failure) => { failed = true; rollbackIssues.push({ step, code: safeCode(failure) }); };
            if (serviceTouched) {
                try { systemctl('stop'); assertStopped(); stopped = true; } catch (failure) { issue('stop', failure); }
            }
            try {
                const currentHash = hash((await protectedRead(paths.environmentFile)).bytes);
                if (currentHash === afterHash || currentHash === pausedHash) await replaceEnvironment(before, currentHash);
                else if (currentHash !== beforeHash) failed = true;
            } catch (failure) { issue('environment', failure); }
            if (temporaryInstalled) {
                try { execute('sudo', ['-n', 'unlink', temporaryUnit]); temporaryInstalled = false; }
                catch (failure) { issue('temporary-unit', failure); }
            }
            if (installedUnit) {
                try {
                    const current = await protectedRead(paths.unitFile, 0, 0o022);
                    if (!unitIdentity || current.info.ino !== unitIdentity.ino || current.info.dev !== unitIdentity.dev
                        || current.bytes.toString('utf8') !== unitContent) throw setupError('ACTIVATION_STATE_CHANGED');
                    execute('sudo', ['-n', 'unlink', paths.unitFile]);
                } catch (failure) { issue('unit', failure); }
            }
            if (stopped && !failed) {
                let runtimeRestored = false;
                try {
                    systemctl('daemon-reload', 15_000); systemctl('start');
                    const runtime = await runtimeEnvironment(); assertUnconfigured(runtime);
                    await sameHistory(runtime, minimumID, historical);
                    runtimeRestored = true;
                    await healthy();
                    runtimeRestored = false;
                    const verifiedRuntime = await runtimeEnvironment(); assertUnconfigured(verifiedRuntime);
                    await sameHistory(verifiedRuntime, minimumID, historical);
                    runtimeRestored = true;
                } catch (failure) {
                    issue('restart-verification', failure);
                    // Keep a proven non-mail runtime running when only the origin health probe fails.
                    try {
                        const runtime = await runtimeEnvironment(); assertUnconfigured(runtime);
                        await sameHistory(runtime, minimumID, historical);
                        runtimeRestored = true;
                    } catch { runtimeRestored = false; }
                    if (!runtimeRestored) {
                        try { systemctl('stop'); assertStopped(); } catch { /* State remains explicitly uncertain. */ }
                    }
                }
            }
            try {
                await writePrivate(join(privateDirectory, `email-activation-failure-${uuid()}.json`),
                    JSON.stringify({ phase, code: safeCode(error), rollbackIssues }));
            } catch { /* Diagnostics must not prevent recovery. No raw errors or secrets are recorded. */ }
            if (failed) throw setupError('ACTIVATION_ROLLBACK_FAILED');
            await fs.unlink(paths.journalFile);
            throw error;
        }
    }
    return async function run(action, options = {}) {
        if (!actions.includes(action)) throw setupError('INVALID_SETUP_ACTION');
        validateOptions(action, options);
        if (action === '--stage') validatePrivateResendSetup(options.input);
        const result = action === '--status' ? await status() : await withLock(async () => {
            if (action === '--stage') return stage(options.input);
            if (action === '--activate') return activate(options);
            return verify(action === '--send-test');
        });
        return publicSetupResult(action, result);
    };
}

export const runEmailPreflight = createEmailPreflight();

export async function readSetupInput(stream, limit = 8192) {
    const chunks = [];
    let length = 0;
    for await (const chunk of stream) {
        length += Buffer.byteLength(chunk);
        if (length > limit) throw setupError('SETUP_INPUT_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw setupError('INVALID_SETUP_OPTIONS'); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const action = process.argv[2];
    try {
        if (process.argv.length !== 3 || !actions.includes(action)) throw setupError('INVALID_SETUP_ACTION');
        const options = action === '--stage' ? { input: await readSetupInput(process.stdin) }
            : ['--activate', '--send-test'].includes(action) ? await readSetupInput(process.stdin, 1024) : {};
        console.log(JSON.stringify(await runEmailPreflight(action, options)));
    } catch (error) {
        console.error(JSON.stringify(redactedSetupError(action, error)));
        process.exitCode = 1;
    }
}
