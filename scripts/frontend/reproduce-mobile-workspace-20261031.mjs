import { chromium, webkit, devices } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startConfigSidebarPreview } from '../../test/helpers/config-sidebar-fixture-20261022.mjs';

const output = resolve(process.env.MOBILE_REPRO_DIR ?? 'D:/Codex-artifacts/website1/mobile-workspace-20261031/repro');
await mkdir(join(output, 'tmp'), { recursive: true });
const fixture = await startConfigSidebarPreview();
const results = [];
const env = { ...process.env, TEMP: join(output, 'tmp'), TMP: join(output, 'tmp'), TMPDIR: join(output, 'tmp'),
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
async function capture(page, label) {
    const state = await page.evaluate(() => {
        const box = selector => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight,
                transform: style.transform, position: style.position, top: style.top,
                overflowX: style.overflowX, overflowY: style.overflowY,
                paddingLeft: style.paddingLeft, paddingRight: style.paddingRight };
        };
        return { innerWidth, innerHeight, scrollX, scrollY, dpr: devicePixelRatio,
            visual: visualViewport && { width: visualViewport.width, height: visualViewport.height,
                top: visualViewport.offsetTop, left: visualViewport.offsetLeft, scale: visualViewport.scale },
            classes: document.body.className,
            boxes: Object.fromEntries(['html', 'body', '.bp-shell', '#config-sidebar', '.bp-brand',
                '.bp-workspace', '.bp-context-identity', '.bp-mobile-panels', '.bp-right-workspace', '#weight-pie']
                .map(selector => [selector, box(selector)])) };
    });
    results.push({ label, ...state });
    const { boxes } = state;
    console.log(label, JSON.stringify({ vw: state.innerWidth, visual: state.visual, x: state.scrollX,
        header: boxes['#config-sidebar'], workspace: boxes['.bp-workspace'] }));
    await page.screenshot({ path: join(output, label + '.png') });
}
try {
    for (const engine of process.env.MOBILE_REPRO_CHANNEL ? [chromium] : [chromium, webkit]) {
        const browser = await engine.launch({ headless: true, env, channel: process.env.MOBILE_REPRO_CHANNEL });
        try {
            for (let pass = 1; pass <= 2; pass++) {
                const context = await browser.newContext({ ...devices['iPhone 16'], viewport: { width: 393, height: 852 },
                    isMobile: true, deviceScaleFactor: 3, reducedMotion: 'no-preference' });
                const page = await context.newPage();
                page.on('pageerror', error => console.log('pageerror:', error.message));
                await page.goto(process.env.MOBILE_REPRO_URL ?? fixture.url + '/intelligence', { waitUntil: 'domcontentloaded', timeout: 60000 });
                await page.waitForSelector('#weight-pie [data-object-id]', { timeout: 20000 });
                await page.evaluate(() => document.fonts.ready);
                await page.waitForTimeout(450);
                const prefix = `${engine.name()}-${pass}`;
                await capture(page, prefix + '-cold');
                await page.locator('#model-index-tab').click();
                await page.evaluate(() => scrollTo(0, 350));
                await page.waitForTimeout(350);
                await capture(page, prefix + '-models-scroll');
                await page.reload();
                await page.waitForSelector('#weight-pie [data-object-id]', { timeout: 20000 });
                await page.locator('#model-index-tab').click();
                await page.evaluate(() => scrollTo(0, 350));
                await page.waitForTimeout(350);
                await capture(page, prefix + '-reload-scroll');
                await page.locator('#taxonomy-toggle').click();
                await page.waitForTimeout(350);
                await page.locator('#taxonomy-close').click();
                await page.waitForTimeout(350);
                await capture(page, prefix + '-drawer-close');
                await page.setViewportSize({ width: 520, height: 852 });
                await page.waitForTimeout(350);
                await page.setViewportSize({ width: 393, height: 852 });
                await page.waitForTimeout(350);
                await capture(page, prefix + '-resize-back');
                await context.close();
            }
        } finally { await browser.close(); }
    }
} finally {
    await fixture.close();
    await writeFile(join(output, 'geometry.json'), JSON.stringify(results, null, 2));
}
