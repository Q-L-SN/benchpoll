import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';

const output = resolve(process.env.HOME_SPACING_ARTIFACTS || 'D:/Codex-artifacts/website1/home-spacing-20261031');
const browsers = new Map();
const reports = [];
const widths = [393, 760, 820, 1024, 1280, 1440, 1920];

before(async () => {
    const temp = join(output, 'tmp');
    await mkdir(temp, { recursive: true });
    const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const launcher of [chromium, webkit]) browsers.set(launcher.name(), await launcher.launch({ headless: true, env }));
});

after(async () => {
    try { await writeFile(join(output, 'geometry.json'), JSON.stringify(reports, null, 2)); }
    finally { for (const browser of browsers.values()) await browser.close(); }
});

async function open(t, engine, width) {
    const fixture = await startTopicsPreview({ built: false });
    Object.assign(fixture.state.topics.find(topic => topic.ID === 54), {
        name: 'Intelligence', slug: 'intelligence', url: '/intelligence', description: 'Community weights for intelligence.'
    });
    const context = await browsers.get(engine).newContext({ viewport: { width, height: width === 393 ? 852 : 900 },
        isMobile: width === 393, hasTouch: width === 393, deviceScaleFactor: 1,
        reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    t.after(async () => {
        await context.close();
        await fixture.close();
        assert.deepEqual(errors, [], 'No uncaught page errors');
    });
    await page.goto(fixture.url);
    await page.waitForSelector('.th-card.is-featured[data-preview-state="loaded"] .th-model');
    await settle(page);
    return page;
}

async function settle(page) {
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.th-card')].every(card => {
        const box = card.getBoundingClientRect();
        return box.top >= innerHeight || box.bottom <= 0 || card.dataset.previewState === 'loaded';
    }));
}

async function geometry(page) {
    return page.evaluate(() => {
        const rect = node => {
            const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
        };
        const grid = document.getElementById('topics-grid');
        const cards = [...grid.querySelectorAll('.th-card')];
        const filters = document.getElementById('topics-filters');
        return {
            viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, scrollX,
            grid: rect(grid), columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
            gap: parseFloat(getComputedStyle(grid).columnGap), rowGap: parseFloat(getComputedStyle(grid).rowGap),
            gridPaddingTop: parseFloat(getComputedStyle(grid).paddingTop),
            header: rect(document.querySelector('.th-header-inner')), hero: rect(document.getElementById('home-hero')),
            settings: filters.hidden ? null : { ...rect(filters), position: getComputedStyle(filters).position },
            cards: cards.map(card => ({ ...rect(card), id: card.dataset.topicId,
                name: card.querySelector('.th-topic-name').textContent, featured: card.classList.contains('is-featured'),
                column: getComputedStyle(card).gridColumn })),
            charts: cards.filter(card => card.querySelector('.th-model-scroll')).map(card => {
                const scroll = card.querySelector('.th-model-scroll');
                return { id: card.dataset.topicId, frame: rect(scroll), scrollLeft: scroll.scrollLeft,
                    visual: rect(card.querySelector('.th-visual')),
                    models: [...scroll.querySelectorAll('.th-model')].filter(model => Number(getComputedStyle(model).opacity) > 0)
                        .map(model => ({ ...rect(model), opacity: Number(getComputedStyle(model).opacity),
                            bars: [...model.querySelectorAll('.th-model-bar,.th-model-range')].map(rect) })) };
            })
        };
    });
}

function closeTo(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} != ${expected}`);
}

function assertLayout(layout, width) {
    const columns = width <= 640 ? 1 : width <= 1120 ? 2 : 3;
    const expectedWidth = Math.min(1120, width <= 640 ? width - 32 : width * .84);
    assert.equal(layout.viewport, width);
    assert.equal(layout.scrollX, 0);
    assert.ok(layout.documentWidth <= width + 1, `Document overflow at ${width}: ${layout.documentWidth}`);
    assert.equal(layout.columns, columns, `Bounded column count at ${width}`);
    closeTo(layout.grid.width, expectedWidth, 'Grid width');
    closeTo(layout.grid.x, width - layout.grid.right, 'Centered gutters');
    assert.ok(layout.grid.width <= 1120.5, 'Wide screens must not grow the grid');
    if (width <= 640) closeTo(layout.grid.x, 16, 'Near-full-width phone grid');
    else assert.ok(layout.grid.x >= width * .07 && layout.grid.x >= (width - 1120) / 2 - 1, 'Deliberate tablet/desktop gutters');

    const shellWidth = Math.min(1360, width - (width <= 640 ? 32 : width <= 1050 ? 48 : 80));
    for (const [name, box] of [['header', layout.header], ['hero', layout.hero]]) {
        closeTo(box.width, shellWidth, `${name} width must stay unchanged`);
        closeTo(box.x, (width - shellWidth) / 2, `${name} centering must stay unchanged`);
    }

    const [featured, ...regular] = layout.cards;
    assert.equal(layout.cards.filter(card => card.featured).length, 1);
    assert.equal(featured.id, '54');
    assert.equal(featured.name, 'Intelligence');
    assert.equal(featured.featured, true);
    assert.equal(featured.column, '1 / -1');
    closeTo(featured.x, layout.grid.x, 'Featured left edge');
    closeTo(featured.width, layout.grid.width, 'Featured full row');
    closeTo(featured.y, layout.grid.y + layout.gridPaddingTop, 'Featured stays first');
    closeTo(featured.height, 456, 'Featured height remains fixed');
    for (const [index, card] of regular.entries()) {
        const cardWidth = (layout.grid.width - (columns - 1) * layout.gap) / columns;
        closeTo(card.width, cardWidth, 'Regular card width');
        closeTo(card.height, 416, 'Regular card height remains fixed');
        closeTo(card.x, layout.grid.x + (index % columns) * (cardWidth + layout.gap), 'Regular card column');
        closeTo(card.y, featured.bottom + layout.rowGap + Math.floor(index / columns) * (416 + layout.rowGap), 'Regular card row');
        if (columns === 2) assert.ok(card.width <= 464, 'Two-column cards must not become oversized');
        if (columns === 3) assert.ok(card.width >= 300 && card.width <= 361, 'Comfortable bounded laptop/desktop cards');
    }
}

function assertWholeBars(layout) {
    assert.ok(layout.charts.length > 0, 'At least the featured chart is loaded');
    for (const chart of layout.charts) {
        closeTo(chart.scrollLeft, 0, `Initial model page for topic ${chart.id}`);
        assert.ok(chart.models.length > 0, `Visible model columns for topic ${chart.id}`);
        assert.ok(chart.frame.x >= chart.visual.x - 1 && chart.frame.right <= chart.visual.right + 1, 'Chart stays inside its card');
        closeTo(chart.frame.x - chart.visual.x, chart.visual.right - chart.frame.right, 'Chart remains centered');
        for (const model of chart.models) {
            assert.equal(model.opacity, 1, `No half-faded model at initial page in topic ${chart.id}`);
            assert.ok(model.x >= chart.frame.x - 1 && model.right <= chart.frame.right + 1, `No partial model column in topic ${chart.id}`);
            for (const bar of model.bars) {
                assert.ok(bar.x >= chart.frame.x - 1 && bar.right <= chart.frame.right + 1, 'No horizontally clipped bar');
                assert.ok(bar.y >= chart.frame.y - 1 && bar.bottom <= chart.frame.bottom + 1, 'No vertically clipped bar');
                assert.ok(bar.width >= 28 && bar.width <= 36, 'Bar width stays readable and bounded');
            }
        }
    }
}

for (const engine of ['chromium', 'webkit']) {
    for (const width of widths) test(`${engine} ${width}px centered home grid and whole initial model columns`, async t => {
        const page = await open(t, engine, width);
        const initial = await geometry(page);
        reports.push({ engine, width, state: 'initial', ...initial });
        await page.screenshot({ path: join(output, `${engine}-${width}-initial.png`) });
        assertLayout(initial, width);
        assertWholeBars(initial);
        assert.equal(initial.settings, null, 'Settings stay hidden above the directory');

        await page.evaluate(() => {
            const card = document.querySelector('.th-card:not(.is-featured)').getBoundingClientRect();
            scrollTo(0, scrollY + card.top - document.querySelector('.th-header').offsetHeight - 76);
        });
        await page.waitForSelector('#topics-filters:not([hidden])');
        const firstRow = initial.cards.slice(1, initial.columns + 1).map(card => card.id);
        await page.waitForFunction(ids => ids.every(id => document.querySelector(`.th-card[data-topic-id="${id}"][data-preview-state="loaded"] .th-model`)), firstRow);
        await settle(page);
        const scrolled = await geometry(page);
        reports.push({ engine, width, state: 'regular-row', ...scrolled });
        assertLayout(scrolled, width);
        assertWholeBars(scrolled);
        assert.equal(scrolled.settings.position, 'fixed');
        if (width <= 760) closeTo(scrolled.settings.x + scrolled.settings.width / 2, width / 2, 'Mobile settings island stays centered');
        else closeTo(scrolled.settings.x, scrolled.header.x, 'Desktop settings island follows the header, not the narrower grid');
        assert.ok(scrolled.settings.x >= 0 && scrolled.settings.right <= width + 1, 'Settings stay within the viewport');
        await page.screenshot({ path: join(output, `${engine}-${width}-settings.png`) });
    });

    test(`${engine} column boundaries and live resizing preserve centered whole model columns`, async t => {
        const page = await open(t, engine, 1920);
        for (const width of [320, 640, 641, 1050, 1120, 1121, 1280, 820, 393, 1920]) {
            await page.setViewportSize({ width, height: 900 });
            await settle(page);
            const layout = await geometry(page);
            reports.push({ engine, width, state: 'resized', ...layout });
            assertLayout(layout, width);
            assertWholeBars(layout);
        }
    });
}
