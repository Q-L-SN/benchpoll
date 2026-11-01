import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Manrope declares explicit regular through extra-bold font resources', () => {
    const css = readFileSync('public/css/typography.css', 'utf8');
    const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match => match[1]);
    assert.equal(faces.length, 5);
    for (const [index, weight] of [400, 500, 600, 700, 800].entries()) {
        assert.match(faces[index], new RegExp(`font-weight:\\s*${weight};`));
        assert.ok(faces[index].includes(`/assets/fonts/manrope-${weight}.woff2`));
        assert.match(faces[index], /font-display:\s*swap/);
        const bytes = readFileSync(`public/assets/fonts/manrope-${weight}.woff2`);
        assert.equal(bytes.toString('ascii', 0, 4), 'wOF2');
        assert.equal(bytes.readUInt32BE(8), bytes.length);
    }
    assert.match(css, /--font-sans:\s*'Manrope'/);
    assert.match(css, /--headline-weight:\s*800/);
    assert.doesNotMatch(css, /200\s+800|manrope\.ttf/);
    assert.match(readFileSync('public/assets/fonts/manrope-OFL.txt', 'utf8'), /SIL OPEN FONT LICENSE/);
    for (const name of ['home', 'contribute', 'how-it-works', 'terms', 'privacy', 'adminlogin', 'censor', 'dialogPage', 'loginCallback']) {
        const html = readFileSync(`private/${name}.html`, 'utf8');
        assert.ok(html.includes('/css/typography.css?v=manrope-static-20261007'), name + ': cached typography must refresh');
    }
});
