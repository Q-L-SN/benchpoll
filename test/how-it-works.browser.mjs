import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = join(root, 'public');
const output = resolve(process.env.HOW_IT_WORKS_OUTPUT ?? (process.platform === 'win32'
    ? 'D:/Codex-artifacts/website1/how-it-works-topics-20261022' : join(tmpdir(), 'benchpoll-topics-help-20261022')));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
const browsers = new Map();
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
let server, url;

before(async () => {
    await mkdir(output, { recursive: true });
    server = createServer(async (request, response) => {
        const path = new URL(request.url, 'http://localhost').pathname;
        const guide = path === '/how-it-works' || path === '/';
        const file = guide ? join(root, 'private/how-it-works.html') : resolve(publicRoot, '.' + path);
        if (!guide && relative(publicRoot, file).startsWith('..')) {
            response.writeHead(403).end();
            return;
        }
        try {
            const content = await readFile(file);
            response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
            response.end(content);
        } catch {
            response.writeHead(404).end();
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    for (const [name, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
        browsers.set(name, await launcher.launch({ headless: true, env }));
    }
});

after(async () => {
    for (const browser of browsers.values()) await browser.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
});

const cases = [['chromium', 1440], ['chromium', 761], ['chromium', 760], ['chromium', 390], ['chromium', 320],
    ['webkit', 1440], ['webkit', 390], ['webkit', 320], ['chromium', 390, 'no-preference'], ['webkit', 390, 'no-preference']];

for (const [engine, width, motion = 'reduce'] of cases) {
    const name = `${engine}-${width}${motion === 'reduce' ? '' : '-motion'}`;
    test(`${name}: readable guide, quiet links, drawer and linked fallback answer`, async t => {
        const mobile = width <= 760;
        const context = await browsers.get(engine).newContext({ viewport: { width, height: 900 },
            hasTouch: mobile, reducedMotion: motion });
        t.after(() => context.close());
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
        await context.route('**/*', route => route.request().url().startsWith(url + '/') ? route.continue() : route.abort());
        await page.goto(url + '/how-it-works', { waitUntil: 'networkidle' });
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.title(), 'How BenchPoll works');
        assert.equal(await page.getByRole('link', { name: 'Back to topics', exact: true }).count(), 0);
        assert.equal(await page.locator('.bp-brand-lockup').evaluate(image => image.complete && image.naturalWidth > 0), true);
        assert.equal(await page.locator('.bp-how-primary-link').first().getAttribute('data-ui-variant'), 'quiet');
        await page.screenshot({ path: join(output, `${name}-start.png`) });

        const layout = await page.evaluate(() => {
            const content = document.querySelector('.bp-how-content');
            const blocks = [...content.querySelectorAll('header, section')].map(node => node.getBoundingClientRect());
            const overflow = [...content.querySelectorAll('h1, h2, p, li, summary, a')]
                .filter(node => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).display !== 'inline')
                .map(node => node.textContent);
            return { fits: document.documentElement.scrollWidth <= innerWidth + 1,
                separated: blocks.every((block, index) => !index || block.top >= blocks[index - 1].bottom - 1), overflow };
        });
        assert.deepEqual(layout, { fits: true, separated: true, overflow: [] });

        const primary = page.locator('.bp-how-primary-link').first();
        const quietStyle = () => primary.evaluate(node => {
            const style = getComputedStyle(node);
            return { color: style.color, icon: getComputedStyle(node.querySelector('i')).color,
                background: style.backgroundColor, border: style.borderTopWidth, decoration: style.textDecorationLine,
                height: node.getBoundingClientRect().height };
        });
        const normal = await quietStyle();
        assert.equal(normal.background, 'rgba(0, 0, 0, 0)');
        assert.equal(normal.border, '0px');
        assert.equal(normal.decoration, 'none');
        assert.equal(normal.icon, normal.color);
        assert.ok(normal.height >= 44);
        if (!mobile) {
            await primary.hover();
            await page.waitForFunction(normalColor => {
                const node = document.querySelector('.bp-how-primary-link');
                return getComputedStyle(node).color !== normalColor
                    && getComputedStyle(node).color === getComputedStyle(node.querySelector('i')).color;
            }, normal.color);
            assert.equal((await quietStyle()).icon, (await quietStyle()).color);
        }
        await page.keyboard.press('Tab');
        await primary.focus();
        assert.equal(await primary.evaluate(node => node.matches(':focus-visible') && getComputedStyle(node).outlineStyle !== 'none'), true);

        if (mobile) {
            const toggle = page.locator('#taxonomy-toggle');
            await toggle.click();
            assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
            const topicLink = page.locator('[data-how-link][href="#topics"]');
            assert.ok((await topicLink.boundingBox()).height >= 44);
            await topicLink.click();
            await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
            assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
            await page.waitForFunction(() => document.querySelector('[href="#topics"][data-how-link]').getAttribute('aria-current') === 'location');
            await toggle.click();
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
            await toggle.click();
            await page.locator('#taxonomy-scrim').click({ position: { x: width - 10, y: 600 } });
            await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
        } else {
            await page.locator('[data-how-link][href="#topics"]').click();
            await page.waitForFunction(() => document.querySelector('[href="#topics"][data-how-link]').getAttribute('aria-current') === 'location');
        }

        await page.goto(url + '/how-it-works#calculation-details', { waitUntil: 'networkidle' });
        assert.match(await page.locator('#calculation-details').textContent(), /in this topic/);
        await page.waitForFunction(() => document.querySelector('[href="#public"][data-how-link]').getAttribute('aria-current') === 'location');

        await page.goto(url + '/how-it-works#fallback-versions', { waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.getElementById('fallback-versions').open);
        const answer = page.locator('#fallback-versions');
        assert.match(await answer.locator('p').textContent(), /New versions join automatically/);
        await answer.locator('summary').focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.getElementById('fallback-versions').open);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.getElementById('fallback-versions').open);
        await page.locator('#rankings').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, `${name}-scores.png`) });
        assert.deepEqual(errors, []);
        t.diagnostic(`Screenshots: ${output}`);
    });
}
