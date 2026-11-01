import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const controls = process.argv.includes('--controls');
const part = controls ? 'score-field-controls' : 'option-concurrency';
const output = resolve(`artifacts/review-20261008/${part}-deployment`);
const baseline = `D:/BenchPoll-artifacts/review-20261008/${part}-before`;
const names = ['public/js/contribution/score-fields.js', 'public/js/contribute.js', ...(controls ? ['public/css/contribute.css'] : [])];
const release = `launch-20261008-${Date.now()}`;
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const files = [];
for (const path of names) {
    files.push({ path, before: await hash(join(baseline, path)), after: await hash(join(root, path)) });
    if (path.endsWith('.js')) execFileSync(process.execPath, ['--check', join(root, path)], { stdio: 'inherit' });
}
await mkdir(output, { recursive: true });
await writeFile(join(output, 'manifest.json'), JSON.stringify({ release, files }, null, 2));
const archive = join(output, `${release}.tar`);
execFileSync('tar.exe', ['-cf', archive, '-C', root, ...names, 'ops/launch-release.mjs',
    '-C', output, 'manifest.json'], { stdio: 'inherit' });
if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ release, archive, prepared: true }));
} else {
    const key = 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem';
    const options = ['-i', key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
    const host = 'ubuntu@18.226.222.18';
    execFileSync('C:/WINDOWS/System32/OpenSSH/scp.exe', [...options, archive, `${host}:/tmp/${release}.tar`], { stdio: 'inherit' });
    const result = execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', [...options, host,
        `mkdir /tmp/${release} && tar -xf /tmp/${release}.tar -C /tmp/${release} && cd /tmp/${release} && node ops/launch-release.mjs`],
    { encoding: 'utf8', timeout: 180000 });
    await writeFile(join(output, 'deployment-result.json'), result);
    console.log(result);
}
