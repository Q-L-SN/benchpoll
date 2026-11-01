import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const root = resolve('artifacts/launch-20261009/strategy-v2');
const historical = resolve('artifacts/launch-20261008');
const checks = [];
const provenance = JSON.parse(await readFile(join(root, 'screenshot-provenance.json'), 'utf8'));
assert.deepEqual(provenance, JSON.parse(await readFile(join(historical, 'screenshot-provenance.json'), 'utf8')));
for (const item of provenance) {
    const digest = buffer => createHash('sha256').update(buffer).digest('hex');
    assert.equal(digest(await readFile(join(root, item.file))), digest(await readFile(join(historical, item.file))));
    assert.equal(item.synthetic, false);
}
checks.push({ preservedScreenshotDatesAndPixels: true });

const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const file of ['launch-kit.html', 'x-first-post.html']) {
        await page.goto(pathToFileURL(join(root, file)).href);
        const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(node => node.href));
        for (const link of links) {
            const url = new URL(link);
            if (url.protocol !== 'file:') continue;
            const path = fileURLToPath(url);
            const local = relative(root, path);
            assert.ok(!local.startsWith('..'), `Non-portable link: ${link}`);
            assert.ok((await stat(path)).isFile(), `Missing local link: ${link}`);
        }
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 960 });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            assert.ok(await page.locator('img').evaluateAll(nodes => nodes.every(node => node.complete && node.naturalWidth > 0)));
            if (file === 'x-first-post.html') await page.screenshot({ path: join(root, `x-draft-${width}.png`) });
        }
        checks.push({ file, localLinksExistAndStayInPackage: true, desktopMobileLayout: true });
    }
    const expected = (await readFile(join(root, 'posts/x-launch-en.txt'), 'utf8')).trim();
    assert.equal((await page.locator('#draft').textContent()).trim(), expected);
    const intent = new URL(await page.locator('#open-draft').getAttribute('href'));
    assert.equal(intent.origin, 'https://x.com');
    assert.equal(intent.pathname, '/intent/post');
    assert.equal(intent.searchParams.get('text'), expected);
    assert.deepEqual(errors, []);
    checks.push({ xDraftMatchesExportAndPrefill: true, pageErrors: 0 });
    for (const [file, maximum] of [
        ['x-bio-en.txt', 160], ['product-hunt-name.txt', 40],
        ['product-hunt-tagline.txt', 60], ['product-hunt-description.txt', 260]
    ]) {
        const text = (await readFile(join(root, 'posts', file), 'utf8')).trim();
        assert.ok(text.length <= maximum, `${file}: working copy length budget exceeded`);
    }
    checks.push({ shortFieldWorkingBudgets: true });
} finally {
    await browser.close();
}

const report = { checkedAt: new Date().toISOString(), checks,
    scope: 'Local package links, historical screenshot preservation, copy lengths, draft consistency and responsive layout only. No social posting or production application validation.' };
await writeFile(join(root, 'strategy-check.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
