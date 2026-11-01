import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const transportOnly = process.argv.includes('--transport-only');
const businessTransport = process.argv.includes('--business-transport');
const moderationPagination = process.argv.includes('--moderation-pagination');
const moderationIntent = process.argv.includes('--moderation-intent');
const moderationTransactions = process.argv.includes('--moderation-transactions');
const writeReplay = process.argv.includes('--write-replay');
const moderationReplay = process.argv.includes('--moderation-replay');
const accountPrecision = process.argv.includes('--account-precision');
const transactionCleanup = process.argv.includes('--transaction-cleanup');
const dbDeadlines = process.argv.includes('--db-deadlines');
const part = dbDeadlines ? 'db-deadlines' : transactionCleanup ? 'transaction-cleanup' : accountPrecision ? 'account-precision' : moderationReplay ? 'moderation-replay' : writeReplay ? 'write-replay' : moderationTransactions ? 'moderation-transactions' : moderationIntent ? 'moderation-intent' : moderationPagination ? 'moderation-pagination' : businessTransport ? 'account-business-transport' : transportOnly ? 'account-contribution-transport' : 'remaining-account';
const output = resolve(`artifacts/review-20261008/${part}-deployment`);
const baseline = `D:/BenchPoll-artifacts/review-20261008/${part}-production-before`;
const names = dbDeadlines ? ['server.js', 'db.js', 'db-transaction.js', 'db-deadlines.js', 'public/css/censor.css', 'public/js/censor.js']
    : transactionCleanup ? ['server.js', 'db-transaction.js', 'discussion-service.js', 'private-category-service.js',
    'comparison-profiles.js', 'navigation-service.js', 'ranking-service.js', 'benchmark-scores.js',
    'arena-sync.js', 'arena-sync-conflicts.js', 'scripts/import-arena-latest.mjs', 'score-sync-service.js', 'scripts/register-score-sync.mjs']
    : accountPrecision ? ['server.js', 'db.js', 'discussion-service.js', 'moderation-admin.js', 'moderation-email.js']
    : moderationReplay ? ['server.js', 'public/js/censor.js', 'private/censor.html']
    : writeReplay ? ['server.js', 'write-idempotency.js', 'scripts/migrate-write-requests.mjs',
    'public/js/shared/write-intent.js', 'public/js/shared/http.js', 'public/js/contribute.js',
    'public/js/contribution/score-fields.js', 'public/js/censor.js', 'private/contribute.html', 'private/censor.html']
    : moderationTransactions ? ['server.js'] : moderationIntent ? ['public/js/censor.js', 'private/censor.html']
    : moderationPagination ? ['server.js', 'public/js/censor.js', 'public/css/censor.css',
    'private/censor.html', 'public/js/home-workspace.js', 'private/home.html']
    : businessTransport ? ['public/js/shared/account-identity.js', 'discussion-service.js', 'private-category-service.js', 'server.js']
    : transportOnly ? ['server.js'] : ['public/js/shared/account-identity.js', 'public/js/contribution/score-fields.js',
    'public/js/contribute.js', 'public/js/discussion.js', 'public/js/navigation/sidebar.js',
    'public/js/home.js', 'discussion-service.js', 'server.js'];
const key = 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem';
const options = ['-i', key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const host = 'ubuntu@18.226.222.18';
const ssh = 'C:/WINDOWS/System32/OpenSSH/ssh.exe';
const scp = 'C:/WINDOWS/System32/OpenSSH/scp.exe';
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const existingHash = async path => {
    try { return await hash(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const addedFiles = new Set(['write-idempotency.js', 'scripts/migrate-write-requests.mjs', 'public/js/shared/write-intent.js', 'db-transaction.js', 'db-deadlines.js']);
const allowAddedFiles = writeReplay || transactionCleanup || dbDeadlines;
const extraStageFiles = dbDeadlines ? ['package.json', 'ops/review-db-deadlines.mjs']
    : transactionCleanup ? ['package.json', 'ops/review-transaction-cleanup.mjs']
    : accountPrecision ? ['package.json', 'db-deadlines.js', 'db-transaction.js', 'score-aggregation.js', 'public/js/shared/account-identity.js',
    'ops/review-account-precision.mjs']
    : moderationReplay ? ['ops/review-moderation-replay.mjs']
    : writeReplay ? ['package.json', 'public/js/shared/account-identity.js',
    'ops/review-write-idempotency.mjs', 'ops/apply-write-replay-schema.mjs'] : [];
await mkdir(output, { recursive: true });

if ((transactionCleanup || dbDeadlines) && process.argv.includes('--capture-extra')) {
    const recordPath = join(output, 'production-before.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    const recorded = new Set(record.hashes.map(file => file.path));
    const extra = names.filter(path => !recorded.has(path));
    if (!extra.length) throw new Error('No additional baseline files to capture.');
    const remote = `/tmp/benchpoll-${part}-extra-${Date.now()}.tar`;
    const archive = join(output, 'production-before-extra.tar');
    execFileSync(ssh, [...options, host, `tar -cf ${remote} -C /home/ubuntu/benchpoll ${extra.join(' ')}`],
        { stdio: 'inherit', timeout: 90000 });
    execFileSync(scp, [...options, `${host}:${remote}`, archive], { stdio: 'inherit', timeout: 90000 });
    execFileSync('tar.exe', ['-xf', archive, '-C', baseline], { stdio: 'inherit' });
    for (const path of extra) record.hashes.push({ path, hash: await hash(join(baseline, path)) });
    await writeFile(recordPath, JSON.stringify(record, null, 2));
    console.log(JSON.stringify({ capturedAdditionalFiles: extra, originalBaselinePreserved: true }));
} else if (process.argv.includes('--capture')) {
    const remote = `/tmp/benchpoll-${part}-before-${Date.now()}.tar`;
    const archive = join(output, 'production-before.tar');
    await mkdir(baseline, { recursive: true });
    if ((writeReplay || moderationReplay || accountPrecision || transactionCleanup || dbDeadlines) && await existingHash(join(output, 'production-before.json'))) throw new Error('Review baseline already captured.');
    execFileSync(ssh, [...options, host, `tar ${allowAddedFiles ? '--ignore-failed-read ' : ''}-cf ${remote} -C /home/ubuntu/benchpoll ${names.join(' ')}`],
        { stdio: 'inherit', timeout: 90000 });
    execFileSync(scp, [...options, `${host}:${remote}`, archive], { stdio: 'inherit', timeout: 90000 });
    execFileSync('tar.exe', ['-xf', archive, '-C', baseline], { stdio: 'inherit' });
    const hashes = [];
    for (const path of names) {
        const value = await existingHash(join(baseline, path));
        if (value === null && (!allowAddedFiles || !addedFiles.has(path))) throw new Error(`Missing required production file: ${path}`);
        hashes.push({ path, hash: value });
    }
    await writeFile(join(output, 'production-before.json'), JSON.stringify({ baseline, hashes }, null, 2));
    console.log(JSON.stringify({ captured: true, baseline, files: names.length }));
} else {
    const release = `launch-20261008-${Date.now()}`;
    const files = [];
    for (const path of names) {
        const before = await existingHash(join(baseline, path));
        if (before === null && (!allowAddedFiles || !addedFiles.has(path))) throw new Error(`Missing required baseline file: ${path}`);
        files.push({ path, before, after: await hash(join(root, path)) });
        if (['.js', '.mjs'].includes(extname(path))) {
            execFileSync(process.execPath, ['--check', join(root, path)], { stdio: 'inherit' });
        }
    }
    await writeFile(join(output, 'manifest.json'), JSON.stringify({ release, files }, null, 2));
    const archive = join(output, `${release}.tar`);
    execFileSync('tar.exe', ['-cf', archive, '-C', root, ...names, ...extraStageFiles, 'ops/launch-release.mjs',
        '-C', output, 'manifest.json'], { stdio: 'inherit' });
    if (!process.argv.includes('--apply')) console.log(JSON.stringify({ release, archive, prepared: true }));
    else {
        execFileSync(scp, [...options, archive, `${host}:/tmp/${release}.tar`], { stdio: 'inherit', timeout: 90000 });
        const result = execFileSync(ssh, [...options, host,
            `mkdir /tmp/${release} && tar -xf /tmp/${release}.tar -C /tmp/${release} && cd /tmp/${release} && node ops/launch-release.mjs`],
        { encoding: 'utf8', timeout: 180000 });
        await writeFile(join(output, 'deployment-result.json'), result);
        console.log(result);
    }
}
