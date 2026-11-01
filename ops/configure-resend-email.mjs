import * as fileSystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePrivateResendSetup, publicSetupResult, redactedSetupError } from './verify-resend-email.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const ssh = 'C:/Windows/System32/OpenSSH/ssh.exe';
const scp = 'C:/Windows/System32/OpenSSH/scp.exe';
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
const host = 'ubuntu@18.226.222.18';
const remoteDirectory = '/home/ubuntu/benchpoll/scripts/resend-activation-20261018';
const privateFile = 'C:/Users/18665/.benchpoll-email-setup-20261018/resend.env';
const setupError = code => Object.assign(new Error(code), { code });
const actions = ['--upload', '--status', '--stage', '--verify', '--send-test', '--activate'];

export function parseConfigureArguments(args) {
    const [action, ...flags] = args;
    if (!actions.includes(action)) throw setupError('INVALID_SETUP_ACTION');
    const allowed = action === '--activate'
        ? ['--owner-confirmed-test', '--contact-inboxes-confirmed', '--support-reply-confirmed', '--legacy-test-receipt-confirmed']
        : action === '--send-test' ? ['--owner-authorized-send-test'] : [];
    if (new Set(flags).size !== flags.length || flags.some(flag => !allowed.includes(flag))) throw setupError('INVALID_SETUP_OPTIONS');
    if (action === '--activate') {
        if (!flags.includes('--owner-confirmed-test')) throw setupError('OWNER_RECEIPT_CONFIRMATION_REQUIRED');
        if (!flags.includes('--contact-inboxes-confirmed')) throw setupError('CONTACT_INBOX_CONFIRMATION_REQUIRED');
    }
    if (action === '--send-test' && !flags.includes('--owner-authorized-send-test')) throw setupError('TEST_SEND_AUTHORIZATION_REQUIRED');
    return { action, input: action === '--activate' ? {
        ownerConfirmedTest: true, contactInboxesConfirmed: true,
        supportReplyConfirmed: flags.includes('--support-reply-confirmed'),
        legacyTestReceiptConfirmed: flags.includes('--legacy-test-receipt-confirmed')
    } : action === '--send-test' ? { sendTestAuthorized: true } : undefined };
}

export async function readLocalPrivateSetup(dependencies = {}) {
    const fs = dependencies.fileSystem ?? fileSystem;
    const execute = dependencies.execute ?? execFileSync;
    const platform = dependencies.platform ?? process.platform;
    const parent = await fs.lstat(dirname(privateFile)), before = await fs.lstat(privateFile);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !before.isFile() || before.isSymbolicLink()
        || before.nlink !== 1 || before.size > 8192
        || (await fs.realpath(dirname(privateFile))).toLowerCase() !== resolve(dirname(privateFile)).toLowerCase()) {
        throw setupError('UNSAFE_LOCAL_PRIVATE_FILE');
    }
    if (platform === 'win32') {
        // Emit one boolean only. Account names, ACL diagnostics and file contents never enter the output schema.
        const script = `$ErrorActionPreference='Stop'; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; `
            + `$allowed=@($me,'S-1-5-18','S-1-5-32-544'); foreach($p in @('${dirname(privateFile)}','${privateFile}')) { `
            + `$acl=Get-Acl -LiteralPath $p; if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $me) { throw 'unsafe' }; `
            + `foreach($rule in $acl.Access) { if($rule.AccessControlType -eq 'Allow' -and `
            + `$allowed -notcontains $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value) { throw 'unsafe' } } }; 'true'`;
        if (String(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            encoding: 'utf8', timeout: 10_000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'pipe']
        })).trim() !== 'true') throw setupError('UNSAFE_LOCAL_PRIVATE_FILE');
    } else {
        const uid = (dependencies.uid ?? (() => process.getuid()))();
        if (before.uid !== uid || parent.uid !== uid || before.mode & 0o077 || parent.mode & 0o077) {
            throw setupError('UNSAFE_LOCAL_PRIVATE_FILE');
        }
    }
    const handle = await fs.open(privateFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let bytes;
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1
            || opened.size > 8192 || (platform !== 'win32' && (opened.uid !== before.uid || opened.mode & 0o077))) {
            throw setupError('UNSAFE_LOCAL_PRIVATE_FILE');
        }
        bytes = await handle.readFile();
        if (bytes.length > 8192) throw setupError('SETUP_INPUT_TOO_LARGE');
    } finally { await handle.close(); }
    const input = {};
    for (const line of bytes.toString('utf8').replace(/\r\n/g, '\n').split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const match = /^(RESEND_API_KEY|BENCHPOLL_EMAIL_TEST_TO)=(?:"([^"\\]*)"|'([^'\\]*)'|([^\s'"\\#]+))$/.exec(line);
        if (!match || Object.hasOwn(input, match[1])) throw setupError('INVALID_SETUP_OPTIONS');
        input[match[1]] = match[2] ?? match[3] ?? match[4];
    }
    validatePrivateResendSetup(input);
    return input;
}

export function createResendConfigurator(dependencies = {}) {
    const execute = dependencies.execute ?? execFileSync;
    const readPrivate = dependencies.readPrivateSetup ?? readLocalPrivateSetup;
    return async function run(args) {
        const { action, input: confirmation } = parseConfigureArguments(args);
        const commandOptions = { encoding: 'utf8', maxBuffer: 65_536, stdio: ['ignore', 'pipe', 'pipe'] };
        if (action === '--upload') {
            execute(ssh, [...options, host, `mkdir -p ${remoteDirectory}`], { ...commandOptions, timeout: 30_000 });
            execute(scp, [...options, join(directory, 'verify-resend-email.mjs'), `${host}:${remoteDirectory}/verify-resend-email.mjs`],
                { ...commandOptions, timeout: 60_000 });
            return { action: 'upload', helperUploaded: true, credentialsUploaded: false };
        }
        const input = action === '--stage' ? await readPrivate() : confirmation;
        if (action === '--stage') validatePrivateResendSetup(input);
        let result;
        try {
            result = execute(ssh, [...options, '-T', host, `node ${remoteDirectory}/verify-resend-email.mjs ${action}`], {
                ...commandOptions, input: input === undefined ? undefined : JSON.stringify(input),
                // Include the helper's two health phases and its bounded rollback; do not kill it at 90 seconds.
                timeout: action === '--activate' ? 600_000 : 120_000, stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (error) {
            let remote;
            try { remote = JSON.parse(String(error.stderr ?? '').trim()); } catch { /* Only structured, allowlisted errors survive. */ }
            const safe = redactedSetupError(action, { code: remote?.errorCode, responseCode: remote?.smtpStatus });
            throw Object.assign(new Error(safe.errorCode), { code: safe.errorCode, responseCode: safe.smtpStatus });
        }
        try { return publicSetupResult(action, JSON.parse(String(result).trim())); }
        catch { throw setupError('INVALID_REMOTE_RESULT'); }
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { console.log(JSON.stringify(await createResendConfigurator()(process.argv.slice(2)))); }
    catch (error) {
        console.error(JSON.stringify(redactedSetupError(process.argv[2], error)));
        process.exitCode = 1;
    }
}
