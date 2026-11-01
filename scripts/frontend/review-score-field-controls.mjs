import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = resolve(process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length)
    ?? 'artifacts/review-20261008/score-field-controls');
const baseline = process.argv.find(value => value.startsWith('--baseline='))?.slice('--baseline='.length);
const oldStyles = baseline ? await readFile(join(baseline, 'public/css/contribute.css'), 'utf8') : null;
const oldModule = baseline ? await readFile(join(baseline, 'public/js/contribution/score-fields.js'), 'utf8') : null;
await mkdir(output, { recursive: true });
const reports = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            const preview = await startPreview();
            const page = await browser.newPage({ viewport: { width, height: 1000 }, isMobile: width < 500, hasTouch: width < 500 });
            const errors = [];
            const failedChecks = [];
            page.on('pageerror', error => errors.push(error.message));
            try {
                if (baseline) {
                    await page.route(url => url.pathname === '/css/contribute.css', route => route.fulfill({ contentType: 'text/css', body: oldStyles }));
                    await page.route(url => url.pathname === '/js/contribution/score-fields.js', route => route.fulfill({ contentType: 'text/javascript', body: oldModule }));
                }
                await page.goto(`${preview.url}/contribute/scores/new`);
                await page.locator('#form-surface:not([hidden])').waitFor();
                assert.equal(await page.locator('[data-score-value-input]').getAttribute('placeholder'), 'Choose a version first');
                const search = page.getByRole('searchbox', { name: 'Search score fields' });
                await search.fill('Token');
                await page.getByRole('button', { name: 'Token budget', exact: true }).click();
                const numeric = page.getByRole('textbox', { name: 'Token budget value' });
                await numeric.fill('-0.25'); await numeric.blur();
                await page.evaluate(() => document.fonts.ready);
                const controls = await page.evaluate(() => {
                    const read = selector => {
                        const node = document.querySelector(selector), style = getComputedStyle(node);
                        return { height: node.getBoundingClientRect().height, fontSize: parseFloat(style.fontSize),
                            radius: style.borderTopLeftRadius, boxShadow: style.boxShadow };
                    };
                    return { search: read('.score-field-editor > input'), numeric: read('.score-field-value input'),
                        model: read('input[placeholder="Search models"]'),
                        icons: [...document.querySelectorAll('.score-field-row a[aria-label="Change field"] i')]
                            .map(icon => ({ weight: getComputedStyle(icon).fontWeight, content: getComputedStyle(icon, '::before').content })) };
                });
                const check = (name, actual, expected) => {
                    try { assert.equal(actual, expected, name); }
                    catch (error) { failedChecks.push(error.message); }
                };
                for (const key of ['search', 'numeric']) {
                    check(`${key} has the standard form control height`, controls[key].height, controls.model.height);
                    check(`${key} has the standard control radius`, controls[key].radius, controls.model.radius);
                    check(`${key} has the standard font size`, controls[key].fontSize, controls.model.fontSize);
                    if (width < 500) check(`${key} uses a mobile-friendly input font`, controls[key].fontSize >= 16, true);
                }
                check('The field edit icon uses the installed solid glyph', controls.icons.length > 0
                    && controls.icons.every(icon => icon.weight === '900' && icon.content === '"\uf05a"'), true);
                await numeric.focus();
                const focus = await numeric.evaluate(node => {
                    const style = getComputedStyle(node);
                    return { shadow: style.boxShadow, outline: style.outlineStyle, offset: parseFloat(style.outlineOffset) };
                });
                check('The focused value input has no external halo', (focus.shadow === 'none' || focus.shadow.includes('inset'))
                    && (focus.outline === 'none' || focus.offset <= 0), true);
                await numeric.blur();
                check('The contribution page has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                check('The page has no script errors', errors.length, 0);
                await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
                await page.screenshot({ path: join(output, `${engine}-${width}.png`), fullPage: true });
                reports.push({ engine, width, passed: failedChecks.length === 0, controls, focus, failedChecks, errors });
                console.log(`${failedChecks.length ? 'FAIL' : 'PASS'} ${engine} ${width}: ${failedChecks.length} failed checks`);
            } catch (error) {
                reports.push({ engine, width, passed: false, error: error.stack, failedChecks, errors });
                console.error(`FAIL ${engine} ${width}: ${error.message}`);
            } finally { await page.close(); await preview.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
if (reports.some(report => !report.passed)) process.exitCode = 1;
