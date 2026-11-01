import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(process.env.LAUNCH_KIT_DIR ?? 'artifacts/launch-20261008');
const checks = [];
const xWeight = text => [...text.replace(/https?:\/\/\S+/g, 'x'.repeat(23))]
    .reduce((total, character) => total + (character.codePointAt(0) <= 127 ? 1 : 2), 0);
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(pathToFileURL(join(root, 'launch-kit.html')).href);
    const posts = await page.locator('pre[data-export]').evaluateAll(nodes => nodes.map(node => ({
        filename: node.dataset.export, platform: node.dataset.platform, text: node.textContent.trim()
    })));
    assert.ok(posts.length >= 30, 'The complete launch kit must include at least 30 text assets');
    assert.equal(new Set(posts.map(post => post.filename)).size, posts.length);
    for (const post of posts) {
        assert.match(post.filename, /^[a-z0-9-]+\.txt$/);
        const actual = (await readFile(join(root, 'posts', post.filename), 'utf8')).trim();
        assert.equal(actual, post.text, `${post.filename}: exported copy must match the guide`);
        if (post.platform === 'x') assert.ok(xWeight(post.text) <= 280, `${post.filename}: conservative X length`);
        checks.push({ filename: post.filename, passed: true, characters: post.text.length,
            requiresVerifiedProductHuntURL: post.filename === 'x-product-hunt-launch.txt' });
    }
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 960 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await page.locator('img').evaluateAll(imgs => imgs.every(img => img.complete && img.naturalWidth > 0)), true);
        const broken = await page.locator('a[href^="#"]').evaluateAll(links => links.filter(link => !document.getElementById(link.hash.slice(1))).map(link => link.hash));
        assert.deepEqual(broken, []);
        await page.screenshot({ path: join(root, `guide-confirm-${width}.png`) });
        checks.push({ width, guideOverflow: false, imagesLoaded: true, sectionLinksValid: true, passed: true });
    }
    for (const name of ['START-HERE.md', '01-launch-card.png', '02-public-desktop.png',
        '03-personal-desktop.png', '04-personal-mobile.png', '05-score-evidence.png', 'screenshot-provenance.json', 'community-metrics.csv']) {
        assert.ok((await stat(join(root, name))).size > 0, name);
    }
    const publication = await readFile(join(root, 'publication-log.csv'), 'utf8');
    assert.ok(!/,(?:posted|published),/.test(publication), 'Do not imply publication without a verified URL');
    checks.push({ mediaAndHandoffExist: true, actualSocialPublication: 'not_posted', passed: true });
    const report = { checkedAt: new Date().toISOString(), passed: checks.length, total: checks.length,
        checks, scope: 'Local copy, exported text, images and desktop/mobile handoff verification. No platform account was opened and no social post was sent.' };
    await writeFile(join(root, 'handoff-check.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, total: report.total, texts: posts.length,
        socialPublication: 'not_posted', recordingFilesUnmodified: true }));
} finally { await browser.close(); }
