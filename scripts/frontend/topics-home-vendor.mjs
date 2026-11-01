import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'benchpoll-topics-d3-'));
const integrity = 'FX/9frcub54beBdugHjDCdikxThEqjnR93Qt7PvQTOHxyiNCAlvMrHhclk3cD5VeAaq9fxmfRp+CnWw9rEMBuA==';
try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = ['pack', 'd3-hierarchy@3.1.2', '--ignore-scripts', '--json', '--registry=https://registry.npmjs.org', '--pack-destination', temporary];
    const result = execFileSync(npm, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 120000 });
    const [{ filename }] = JSON.parse(result);
    assert.equal(filename, 'd3-hierarchy-3.1.2.tgz');
    const archive = join(temporary, filename);
    assert.equal(createHash('sha512').update(await readFile(archive)).digest('base64'), integrity);
    execFileSync('tar', ['-xzf', archive, '-C', temporary]);
    const source = await readFile(join(temporary, 'package/dist/d3-hierarchy.min.js'), 'utf8');
    const license = await readFile(join(temporary, 'package/LICENSE'), 'utf8');
    const destination = resolve(root, 'public/js/vendor/d3-hierarchy-3.1.2.js');
    await writeFile(destination, `/* Official d3-hierarchy@3.1.2. npm SHA-512: ${integrity}\n${license}\n*/\n${source}`, 'utf8');
    console.log(`Vendored official d3-hierarchy@3.1.2 with ISC license: ${destination}`);
} finally {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('benchpoll-topics-d3-'));
    await rm(temporary, { recursive: true, force: true });
}
