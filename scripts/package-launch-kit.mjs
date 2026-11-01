import assert from 'node:assert/strict';
import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const output = resolve(process.env.LAUNCH_KIT_DIR ?? 'artifacts/launch-20261008');
assert.ok(process.argv.slice(2).every(arg => arg === '--text-only'), 'Unknown argument');
const textOnly = process.argv.includes('--text-only');
const source = process.env.LAUNCH_SCREENSHOTS ?? 'D:/BenchPoll-artifacts/launch-20261007/production-confirm';
// Conservative preflight: URLs count as 23, every non-ASCII code point as 2.
const xWeight = text => [...text.replace(/https?:\/\/\S+/g, 'x'.repeat(23))]
    .reduce((total, character) => total + (character.codePointAt(0) <= 127 ? 1 : 2), 0);
async function initializeRecordingFile(name, content) {
    try { await writeFile(join(output, name), content, { flag: 'wx' }); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
}
if (!textOnly) {
    await copyFile(resolve('public/assets/benchpoll-logo.svg'), join(output, 'brand.svg'));
    const pictures = [
        ['chromium-1440-public.png', '02-public-desktop.png'],
        ['chromium-1440-personal.png', '03-personal-desktop.png'],
        ['chromium-390-personal.png', '04-personal-mobile.png'],
        ['chromium-1440-evidence.png', '05-score-evidence.png']
    ];
    const provenance = [];
    for (const [from, to] of pictures) {
        const directory = from.includes('-1440-') && process.env.LAUNCH_DESKTOP_SCREENSHOTS ? process.env.LAUNCH_DESKTOP_SCREENSHOTS : source;
        await copyFile(join(directory, from), join(output, to));
        provenance.push({ file: to, origin: 'https://benchpoll.com', source: from, capturedAt: (await stat(join(directory, from))).mtime.toISOString(), synthetic: false });
    }
    await writeFile(join(output, 'screenshot-provenance.json'), JSON.stringify(provenance, null, 2));
}
await mkdir(join(output, 'posts'), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(pathToFileURL(join(output, 'launch-kit.html')).href);
    const posts = await page.locator('pre[data-export]').evaluateAll(nodes => nodes.map(node => ({ filename: node.dataset.export, platform: node.dataset.platform, text: node.textContent.trim() })));
    for (const post of posts) {
        assert.match(post.filename, /^[a-z0-9-]+\.txt$/);
        if (post.platform === 'x') assert.ok(xWeight(post.text) <= 280, `${post.filename} exceeds the conservative X length limit`);
        await writeFile(join(output, 'posts', post.filename), post.text + '\n');
    }
    for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 960 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Guide overflow');
        assert.equal(await page.locator('img').evaluateAll(imgs => imgs.every(img => img.complete && img.naturalWidth > 0)), true);
        await page.screenshot({ path: join(output, `guide-preview-${width}.png`) });
    }
    await writeFile(join(output, 'content-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), textFiles: posts.length,
        xPostLengths: posts.filter(post => post.platform === 'x').map(post => ({ filename: post.filename, characters: post.text.length, conservativeWeight: xWeight(post.text) })), desktopMobileOverflow: false, preservedScreenshotProvenance: textOnly }, null, 2));
    console.log(`Exported ${posts.length} ready text files; desktop/mobile guide checks passed.`);
} finally { await browser.close(); }
await initializeRecordingFile('publication-log.csv', '\uFEFFplatform,status,post_url,posted_at,copy_file,media_file,notes\nX,not_posted,,,posts/x-launch-en.txt,01-launch-card.png,Browser connection failed; ready for manual publishing\nReddit,not_posted,,,posts/reddit-body-en.txt,02-public-desktop.png,Read current community rules before publishing\nProduct Hunt,not_posted,,,posts/product-hunt-description.txt,01-launch-card.png,Requires real maker account and launch preparation\nHacker News,not_posted,,,,Human-authored only; no generated post provided\n');
await initializeRecordingFile('metrics.csv', '\uFEFFdate,platform,post_url,minutes_spent,impressions,link_clicks,confirmed_trials,confirmed_saves,confirmed_returning_users,actionable_feedback,blocking_bugs,notes\n');
await initializeRecordingFile('feedback.csv', '\uFEFFdate,source_url,task_or_category,device_browser,reported_problem,reproduction_steps,severity,status,fix_url,reporter_confirmed,notes\n');
