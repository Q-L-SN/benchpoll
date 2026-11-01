import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/review-concurrency-20261004');
const files = [
    ['public/js/shared/notice-navigation.js', null],
    ['public/js/global.js', '1605d795e83ea0bea4abae657952aabc5fb23f8646a2650cec703b254b47794f'],
    ['public/js/discussion.js', '6c17cf0787255d66a1ee2938ced4af1f495d580e9592423e08fbdc0a8d8de555'],
    ['public/js/contribute.js', 'cf42f5b47a629c83fccd1cf64496416d1b3cad9f904bc0f75369f0c5afb74748'],
    ['public/js/home.js', '4332d8ee4dee3a6b778146a4e35b28d3e9adb20ac330fd93e657e290215a00b2'],
    ['public/js/dialogPage.js', '6527855bb166e05f117b0cd87f88eb08774a82d608f8e70c3f184027cc1050c2'],
    ['test/notice-navigation.test.mjs', null],
    ['scripts/frontend/review-concurrency.mjs', null],
    ['scripts/frontend/notice-pages.mjs', null],
    ['scripts/frontend/review-concurrency-live.mjs', null]
];
mkdirSync(output, { recursive: true });
const manifest = { createdAt: new Date().toISOString(), files: files.map(([file, previousSha256]) => ({
    path: file, previousSha256,
    sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')
})) };
writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync('tar', ['-cf', path.join(output, 'release.tar'), '-C', output, 'release-manifest.json', '-C', root,
    ...files.map(([file]) => file)]);
console.log(JSON.stringify({ files: files.length, archive: path.join(output, 'release.tar') }));
