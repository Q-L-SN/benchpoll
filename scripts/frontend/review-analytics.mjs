import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { webkit } from 'playwright';

const origin = 'https://benchpoll.com';
const output = resolve(process.env.REVIEW_OUTPUT ?? 'artifacts/review-20261008/analytics');
await mkdir(output, { recursive: true });
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const browser = await webkit.launch({ headless: true, env });
const reports = [];
try {
    for (const waitForLoad of [false, true]) {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const errors = [], failures = [], beacons = [];
        page.on('pageerror', error => errors.push({ message: error.message, stack: error.stack, page: page.url() }));
        page.on('requestfailed', request => failures.push({ url: request.url(), method: request.method(), error: request.failure()?.errorText }));
        page.on('response', response => {
            if (!response.url().includes('/cdn-cgi/rum')) return;
            beacons.push({ url: response.url(), status: response.status(), method: response.request().method(),
                origin: response.request().headers().origin, referer: response.request().headers().referer });
        });
        let features;
        try {
            for (const path of ['/how-it-works', '/privacy', '/terms']) {
                await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
                await page.evaluate(() => document.fonts.ready);
                features = await page.evaluate(() => ({ sendBeacon: typeof navigator.sendBeacon,
                    userAgent: navigator.userAgent, isSecureContext, readyState: document.readyState,
                    scripts: [...document.scripts].map(script => script.src).filter(src => src.includes('cloudflareinsights')) }));
                if (waitForLoad) { await page.waitForLoadState('load'); await page.waitForTimeout(1500); }
            }
            await page.waitForTimeout(1500);
            reports.push({ waitForLoad, features, errors, failures, beacons });
            console.log(JSON.stringify({ waitForLoad, features, errors, failures, beacons }));
        } finally { await page.close(); }
    }
} finally { await browser.close(); }
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
