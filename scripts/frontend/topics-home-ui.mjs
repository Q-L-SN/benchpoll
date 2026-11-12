import assert from 'node:assert/strict';
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { fixtureModels, startTopicsPreview } from './topics-home-fixtures.mjs';
import { HOME_WEIGHT_THEME, weightLayout, weightChainLength } from '../../public/js/topics-home/layout.js';

const require = createRequire(import.meta.url);
const { PNG } = require(join(dirname(require.resolve('playwright-core')), 'lib/utilsBundle.js'));
const built = process.argv.includes('--built');
const output = resolve(process.env.TOPICS_HOME_OUTPUT || `D:/Codex-artifacts/website1/home-glass-header-20261024/${built ? 'built' : 'source'}`);
await mkdir(output, { recursive: true });
const temporary = resolve(process.env.TOPICS_HOME_TEMP || 'D:/Codex-artifacts/website1/showcase-composition-20261021/tmp');
await mkdir(temporary, { recursive: true });
process.env.TEMP = temporary; process.env.TMP = temporary;
const widths = process.argv.find(value => value.startsWith('--width='))?.split('=')[1]?.split(',').map(Number) ?? [1440, 1280, 1024, 768, 390, 320];
const engineOnly = process.argv.find(value => value.startsWith('--engine='))?.split('=')[1];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const report = { design: 'home-interactions-20261025', scope: process.argv.includes('--cards-only') ? 'cards-only' : process.argv.includes('--directory-only') ? 'directory-only' : process.argv.includes('--layout-only') ? 'layout-only' : 'full',
    variant: built ? 'built' : 'source', storage: { output, temporary },
    browsers: {}, layouts: [], interactions: [], errors: [], passed: false };
let buildRoot;
const startApp = options => startTopicsPreview({ ...options, root: buildRoot, built });

async function prepareBuiltFixture() {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    buildRoot = await mkdtemp(join(tmpdir(), 'benchpoll-topics-build-'));
    await cp(join(root, 'public'), join(buildRoot, 'public'), { recursive: true,
        filter: source => relative(join(root, 'public'), source).split(/[\\/]/)[0] !== 'build' });
    await mkdir(join(buildRoot, 'private'));
    await copyFile(join(root, 'private/index.html'), join(buildRoot, 'private/index.html'));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(root, 'scripts/build-home-assets.mjs'), '--index'],
        { cwd: buildRoot, env, maxBuffer: 1024 * 1024 });
    if (stderr.trim()) console.error(stderr.trim());
    const html = await readFile(join(buildRoot, 'private/index-built.html'), 'utf8');
    assert.match(html, /<script src="\/build\/index\/entry-0-[^"]+\.js" type="module"><\/script>/);
    assert.doesNotMatch(html, /src="\/js\/topics-home\.js"/);
    report.build = { command: 'node scripts/build-home-assets.mjs --index', entry: 'private/index-built.html',
        summary: JSON.parse(stdout.trim().split(/\r?\n/).at(-1)) };
    console.log(`Built root fixture with actual CLI: ${stdout.trim()}`);
}

function geometryInPage() {
    const rect = node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
    const grid = document.querySelector('.th-grid');
    const heading = document.querySelector('#home-title');
    const headingRange = document.createRange(); headingRange.selectNodeContents(heading);
    return {
        width: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth,
        background: getComputedStyle(document.body).backgroundColor,
        headline: heading.textContent, headlineBounds: rect(heading),
        headlineRects: [...headingRange.getClientRects()].map(box => ({ x: box.x, right: box.right, y: box.y, bottom: box.bottom })),
        subtitle: { ...rect(document.querySelector('.th-intro-copy')), text: document.querySelector('.th-intro-copy').textContent },
        collection: document.body.dataset.collection, theme: document.body.dataset.weightTheme, cardStyle: document.body.dataset.cardStyle,
        redundantHeading: document.querySelectorAll('#topic-count,#topics-title,.th-collection-heading').length,
        toolbar: rect(document.querySelector('.th-toolbar')),
        filters: { ...rect(document.querySelector('#topics-filters')), hidden: document.querySelector('#topics-filters').hidden,
            position: getComputedStyle(document.querySelector('#topics-filters')).position,
            blur: getComputedStyle(document.querySelector('#topics-filters')).backdropFilter || getComputedStyle(document.querySelector('#topics-filters')).webkitBackdropFilter,
            radius: getComputedStyle(document.querySelector('#topics-filters')).borderRadius,
            shadow: getComputedStyle(document.querySelector('#topics-filters')).boxShadow },
        dock: rect(document.querySelector('.th-directory-dock')),
        dockPosition: getComputedStyle(document.querySelector('.th-directory-dock')).position,
        toolbarPosition: getComputedStyle(document.querySelector('.th-toolbar')).position,
        shellPosition: getComputedStyle(document.querySelector('.th-navigation-shell')).position,
        controls: [...document.querySelectorAll('.th-score-controls button,.th-view-controls button,.th-toolbar summary')].map(rect).filter(box => box.width > 0),
        island: rect(document.querySelector('.th-island')),
        navigation: [...document.querySelectorAll('.th-island button,.th-island input')].map(rect).filter(box => box.width > 0),
        firstID: grid.firstElementChild?.dataset.topicId,
        columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        cards: [...document.querySelectorAll('.th-card[data-preview-state="loaded"]')].filter(card => !card.hidden).map(card => {
            const visual = card.querySelector('.th-visual');
            const frame = card.querySelector('.th-chart-frame');
            const tree = card.querySelector('.th-treemap');
            const scroll = card.querySelector('.th-model-scroll');
            const scroller = scroll && rect(scroll);
            const models = scroll ? [...scroll.querySelectorAll('.th-model')].map(model => {
                if (Number(getComputedStyle(model).opacity) === 0) return null;
                const column = rect(model);
                const overlap = Math.min(column.right, scroller.right) - Math.max(column.x, scroller.x);
                if (overlap < .5) return null;
                const bars = [...model.querySelectorAll('.th-model-bar,.th-model-range')].map(bar => ({ ...rect(bar),
                    kind: bar.classList.contains('th-model-range') ? 'range' : 'known', opacity: getComputedStyle(bar).opacity, color: getComputedStyle(bar).backgroundColor }));
                const label = model.querySelector('.th-model-name'), labelStyle = getComputedStyle(label);
                const matrix = new DOMMatrix(labelStyle.transform), labelParent = label.parentElement.getBoundingClientRect();
                return { ...column, href: model.getAttribute('href'), full: column.x >= scroller.x - .6 && column.right <= scroller.right + .6,
                    plot: rect(model.querySelector('.th-model-plot')), bars,
                    name: rect(model.querySelector('.bp-model-display-name')),
                    label: { ...rect(model.querySelector('.th-model-name')), transform: getComputedStyle(model.querySelector('.th-model-name')).transform,
                        base: model.querySelector('.bp-model-display-name').textContent,
                        anchorX: labelParent.x + parseFloat(labelStyle.left) + label.offsetWidth * matrix.a + label.offsetHeight / 2 * matrix.c,
                        wordsUnbroken: [...label.querySelectorAll('.th-label-word')].every(word => getComputedStyle(word).whiteSpace === 'nowrap' && word.getClientRects().length <= 1),
                        lines: Number(model.querySelector('.bp-model-display-name').dataset.lines) },
                    scores: [...model.querySelectorAll('.th-model-score')].map(score => ({ ...rect(score), outside: score.classList.contains('is-outside'),
                        text: score.textContent, font: getComputedStyle(score).fontSize,
                        bar: score.closest('.th-model-bar') ? rect(score.closest('.th-model-bar')) : null, color: getComputedStyle(score).color })),
                    parameters: [...model.querySelectorAll('.bp-model-display-parameter')].map(part => {
                        const value = part.querySelector('span'), icon = part.querySelector('i');
                        const style = getComputedStyle(value);
                        return { ...rect(part), icon: { ...rect(icon), localX: icon.offsetLeft, localWidth: icon.offsetWidth },
                            lines: Number(part.dataset.lines), title: part.title, value: { ...rect(value), text: value.textContent,
                            localX: value.offsetLeft, clientHeight: value.clientHeight,
                            scrollWidth: value.scrollWidth, clientWidth: value.clientWidth, font: style.fontSize,
                            whiteSpace: style.whiteSpace, overflow: style.overflow, textOverflow: style.textOverflow } };
                    }),
                    logos: [...model.querySelectorAll('.th-vendor-mark img')].map(image => ({ ...rect(image), complete: image.complete && image.naturalWidth > 0, fit: getComputedStyle(image).objectFit })) };
            }).filter(Boolean) : [];
            const tiles = [...tree.querySelectorAll('.th-tile')].map(tile => ({ ...rect(tile), weight: Number(tile.dataset.weight), name: tile.title,
                color: getComputedStyle(tile).backgroundColor, ink: getComputedStyle(tile).color,
                borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => Number.parseFloat(getComputedStyle(tile)[`border${side}Width`])),
                share: Number(tile.dataset.share), labelKind: tile.dataset.labelKind,
                labels: [...tile.querySelectorAll('.th-tile-label > span')].map(label => ({ ...rect(label), text: label.textContent,
                    share: label.classList.contains('th-tile-share'), kind: label.classList.contains('th-tile-version') ? 'version' : 'name', font: getComputedStyle(label).fontSize,
                    weight: getComputedStyle(label).fontWeight, opacity: getComputedStyle(label).opacity,
                    symbolFont: label.querySelector('.th-tile-share-symbol') ? parseFloat(getComputedStyle(label.querySelector('.th-tile-share-symbol')).fontSize) : null,
                    overflow: label.dataset.overflow === 'true', align: getComputedStyle(label).textAlign,
                    mask: getComputedStyle(label).maskImage || getComputedStyle(label).webkitMaskImage,
                    color: getComputedStyle(label).color, scrollWidth: label.scrollWidth, clientWidth: label.clientWidth })) }));
            return { id: card.dataset.topicId, card: rect(card), visual: rect(visual), frame: rect(frame), tree: rect(tree),
                mode: visual.dataset.view, mask: getComputedStyle(tree).maskImage || getComputedStyle(tree).webkitMaskImage,
                header: rect(card.querySelector('.th-card-header')), title: rect(card.querySelector('.th-card-title')),
                creator: rect(card.querySelector('.th-creator')), shadow: getComputedStyle(card).boxShadow,
                creatorPrefix: card.querySelector('.bp-topic-byline-prefix').textContent,
                pagination: card.querySelector('.th-pagination').hidden ? null : rect(card.querySelector('.th-pagination')),
                footerCount: card.querySelectorAll('.th-card-footer').length,
                texture: tree.dataset.texture,
                labelInset: parseFloat(getComputedStyle(frame).getPropertyValue('--th-label-inset')),
                scroller, models, tiles, layoutWidth: visual.clientWidth, modelCount: scroll?.querySelectorAll('.th-model').length ?? 0,
                scrollLeft: scroll?.scrollLeft ?? 0, scrollWidth: scroll?.scrollWidth ?? 0 };
        })
    };
}

function checkGeometry(result, mode) {
    assert.ok(result.overflow <= 1, `page overflow ${result.overflow} at ${result.width}`);
    if (result.collection === 'popular') assert.equal(result.firstID, '54');
    assert.equal(result.background, 'rgb(255, 255, 255)');
    assert.equal(result.theme, 'frost-hatch'); assert.equal(result.cardStyle, 'outline');
    assert.equal(result.headline, 'Trust benchmarks. Question the selection.');
    for (const line of result.headlineRects) {
        assert.ok(line.x >= result.headlineBounds.x - .6 && line.right <= result.headlineBounds.right + .6, 'headline text overflows its container');
        assert.ok(line.x >= -.6 && line.right <= result.width + .6, 'headline text overflows the viewport');
    }
    assert.ok(result.subtitle.y >= result.headlineBounds.bottom, 'headline overlaps the subtitle');
    assert.equal(result.subtitle.text, 'Choose what matters. Shape the weights together.');
    assert.equal(result.redundantHeading, 0);
    assert.equal(result.dockPosition, 'sticky');
    assert.equal(result.toolbarPosition, 'relative');
    assert.equal(result.shellPosition, 'relative');
    if (result.filters.hidden) {
        assert.equal(result.filters.height, 0, 'hidden filters reserve space');
        assert.equal(result.controls.length, 0, 'hidden filter controls have layout boxes');
    } else {
        assert.equal(result.filters.position, 'fixed');
        assert.equal(result.filters.x, 0);
        assert.equal(result.filters.y, 0);
        assert.equal(result.filters.width, result.width, 'glass bar must span the viewport');
        assert.ok(result.filters.blur.includes('blur(20px)'), 'missing frosted glass');
        assert.equal(result.filters.radius, '0px', 'filters must not be an island');
        assert.equal(result.filters.shadow, 'none');
        assert.ok(result.island.y >= result.filters.bottom - .6, 'collection island overlaps top filters');
    }
    for (const control of result.controls) {
        assert.ok(control.x >= result.toolbar.x - .6 && control.right <= result.toolbar.right + .6, `toolbar width at ${result.width}`);
        assert.ok(control.y >= result.toolbar.y && control.bottom <= result.toolbar.bottom, `toolbar height at ${result.width}`);
    }
    assert.ok(result.island.x >= 0 && result.island.right <= result.width + .6, `island overflow at ${result.width}`);
    assert.ok(Math.abs(result.island.x + result.island.width / 2 - result.width / 2) < .6, 'island is not centered');
    for (const control of result.navigation) assert.ok(control.x >= result.island.x - .6 && control.right <= result.island.right + .6, 'navigation control overflow');
    assert.equal(result.columns, result.width <= 640 ? 1 : result.width <= 1050 ? 2 : 3);
    for (const card of result.cards) {
        assert.equal(Math.round(card.card.height), card.id === '54' ? 456 : 416);
        assert.equal(card.shadow === 'none', result.cardStyle !== 'lift');
        assert.equal(card.footerCount, 0, 'pagination must not leave a card footer');
        assert.ok(Math.abs(card.visual.y - card.header.bottom) < .6, 'topic card must not have a header/chart gap');
        assert.equal(card.creatorPrefix, 'by');
        if (card.pagination) {
            assert.ok(card.pagination.y >= card.header.y - .6 && card.pagination.bottom <= card.header.bottom + .6, 'pagination must fit the header');
            assert.ok(card.pagination.bottom <= card.visual.y + .6, 'pagination must be above the chart');
        }
        for (const item of [card.title, card.creator]) {
            assert.ok(item.x >= card.header.x - .6 && item.right <= card.header.right + .6, `header width ${card.id}`);
            assert.ok(item.y >= card.header.y && item.bottom <= card.header.bottom + .6, `header wrap ${card.id}`);
        }
        assert.ok(Math.abs(card.frame.x + card.frame.width / 2 - card.visual.x - card.visual.width / 2) < .6, `uncentered ${card.id}`);
        assert.equal(card.mode, mode);
        assert.ok(mode === 'weights' ? card.mask === 'none' : card.mask.includes('32%') && card.mask.includes('76%'));
        if (card.tiles.length) {
            assert.ok(Math.abs(card.tiles[0].x - card.tree.x) < .1 && Math.abs(card.tiles[0].y - card.tree.y) < .1, 'largest must be upper left');
            const top = card.tiles.filter(tile => Math.abs(tile.y - card.tree.y) < .1).sort((a, b) => a.x - b.x);
            const ideal = weightLayout(card.tiles.map((tile, index) => ({ conditionID: index, name: tile.name, weightBasisPoints: tile.weight })), card.tree.width, card.tree.height);
            assert.equal(top.length, ideal.filter(tile => tile.y < .1).length, `priority top-row count ${card.id} at ${result.width}`);
            assert.deepEqual(top.map(tile => tile.name), card.tiles.slice(0, top.length).map(tile => tile.name), `top row must be the sorted prefix in ${card.id}`);
            assert.equal(weightChainLength(card.tiles.map(tile => ({ y: tile.y - card.tree.y })), card.tree.height), weightChainLength(ideal, card.tree.height));
            if (top.length > 1) assert.ok(top.every(tile => tile.width < card.tree.width - .6), 'top must have parallel blocks, not full-width strips');
        }
        for (let index = 0; index < card.tiles.length; index++) {
            const tile = card.tiles[index];
            if (card.texture === 'lines') {
                assert.equal(tile.color, card.tiles[0].color, 'line themes must use a continuous surface');
                assert.deepEqual(tile.borders, [0, tile.right < card.tree.right - .1 ? 1 : 0,
                    tile.bottom < card.tree.bottom - .1 ? 1 : 0, 0], 'line themes must draw each internal seam once, without outer frames');
            }
            assert.ok(Math.abs(tile.width * tile.height / (card.tree.width * card.tree.height) - tile.share) < .0003);
            if (index) {
                assert.ok(card.tiles[index - 1].weight >= tile.weight);
            }
            for (const label of tile.labels) {
                if (label.share) {
                    assert.equal(label.color, 'rgb(138, 148, 159)');
                    assert.equal(label.opacity, '0.38'); assert.equal(label.weight, '800');
                    assert.ok(parseFloat(label.font) >= 32);
                    assert.ok(Math.abs(label.symbolFont - parseFloat(label.font) / 2) < .01, 'percentage symbol must be half the digit size');
                    assert.ok(Math.abs(label.x + label.width / 2 - tile.x - tile.width / 2) < 1);
                } else {
                    assert.equal(label.color, tile.ink);
                    assert.equal(label.color, 'rgb(17, 17, 17)');
                    assert.ok(colorContrast(tile.color, label.color) >= 4.5, `label contrast ${tile.name}`);
                    assert.equal(parseFloat(label.font), label.kind === 'version' ? 12 : 14);
                    assert.equal(label.align, label.overflow ? 'left' : 'center');
                    assert.ok(label.overflow ? label.mask.includes('linear-gradient(to right') : label.mask === 'none', `text fade ${label.text}`);
                    if (!label.overflow) assert.ok(Math.abs(label.x + label.width / 2 - tile.x - tile.width / 2) < 1, 'fitting names must center in their tile');
                }
                assert.ok(label.x >= tile.x && label.right <= tile.right + .6, `label width ${label.text}`);
                if (!label.share) assert.ok(label.y >= tile.y && label.bottom <= tile.bottom + .6, `label height ${label.text}`);
                if (mode === 'default' && !label.share) assert.ok(label.bottom <= card.tree.y + card.tree.height * .25 + .6,
                    `foreground bars can cover priority label ${label.text} in ${card.id}`);
                if (!label.share && !label.overflow) assert.ok(label.scrollWidth <= label.clientWidth + 1, `clipped label ${label.text}`);
            }
        }
        if (card.modelCount > 10 && !card.models.some(model => model.parameters.length)) {
            assert.equal(card.models.length, Math.min(card.modelCount, Math.max(1, Math.floor((card.layoutWidth - card.labelInset * 2) / 48))), 'dense default columns are missing');
        }
        for (const model of card.models) {
            assert.ok(model.full, `partial column in ${card.id} at ${result.width}: ${JSON.stringify(model)}`);
            assert.ok(model.name.bottom <= model.bottom + .6, 'model name is clipped below the identity area');
            assert.ok(model.label.x >= card.scroller.x - .6 && model.label.right <= card.scroller.right + .6, 'diagonal label is clipped at the chart edge');
            assert.equal(model.label.wordsUnbroken, true);
            assert.ok(model.label.bottom <= model.bottom + .6, 'diagonal label is clipped');
            assert.notEqual(model.label.transform, 'none');
            assert.doesNotMatch(model.label.base, /(?:Harness|Effort|Reasoning effort)=/);
            assert.ok(Math.abs(model.plot.bottom - 1 - card.tree.bottom) <= .2, `baseline mismatch ${card.id}`);
            for (const bar of model.bars) {
                assert.ok(bar.width >= 28 && bar.width <= 36, 'model bars must be thicker with bounded gaps');
                assert.ok(bar.y >= card.tree.y + card.tree.height * .35 - 1, `bar exceeds 65% in ${card.id}`);
                assert.ok(Math.abs(bar.bottom - card.tree.bottom) <= .2, `bar bottom ${card.id}`);
                assert.ok(bar.x >= model.x && bar.right <= model.right + .6);
            }
            const range = model.bars.find(bar => bar.kind === 'range'), known = model.bars.find(bar => bar.kind === 'known');
            assert.ok(Math.abs(model.label.anchorX - known.x - known.width / 2) < 1, 'central text line must align with the bar center');
            if (range) {
                assert.equal(range.color, 'rgb(229, 231, 235)');
                assert.equal(range.opacity, '1');
                assert.ok(range.height >= known.height && range.y <= known.y + .2, 'range must cover the full upper height');
                assert.ok(Math.abs(range.bottom - known.bottom) <= .2 && Math.abs(range.x - known.x) <= .2 && Math.abs(range.width - known.width) <= .2, 'range/known baseline and width mismatch');
                assert.ok(model.bars.indexOf(range) < model.bars.indexOf(known), 'gray must paint behind colored known column');
            }
            for (const score of model.scores) {
                if (score.text === '100' && known.height > 18) assert.equal(score.outside, false, '100 should fit inside a tall dense bar');
                assert.equal(score.color, score.outside ? 'rgb(40, 49, 62)' : 'rgb(255, 255, 255)');
                assert.ok(score.right <= model.right + 1 && score.x >= model.x - 1, `score outside own column in ${card.id}`);
                if (!score.outside) {
                    assert.ok(parseFloat(score.font) >= 9, `in-bar microtype ${score.text}`);
                    assert.ok(score.height <= score.bar.height + .6, `score does not physically fit its bar: ${score.text}`);
                    assert.ok(Math.abs(score.x + score.width / 2 - score.bar.x - score.bar.width / 2) <= .6, `score horizontal center ${card.id}`);
                    assert.ok(Math.abs(score.y + score.height / 2 - score.bar.y - score.bar.height / 2) <= .6, `score vertical center ${card.id}`);
                }
            }
            for (const logo of model.logos) {
                assert.ok(logo.complete && logo.fit === 'contain', `missing/cropped logo ${card.id}`);
                assert.equal(logo.width, 24);
                assert.ok(logo.x >= model.x && logo.right <= model.right + .6 && logo.bottom <= card.card.bottom);
            }
            for (const part of model.parameters) {
                assert.ok(part.icon.x >= part.x - .6 && part.value.right <= part.right + .6, `parameter width ${part.value.text}`);
                assert.ok(part.icon.localX + part.icon.localWidth + 2 <= part.value.localX + .6, `parameter icon overlap ${part.value.text}`);
                assert.equal(part.value.overflow, 'hidden');
                assert.equal(parseFloat(part.value.font), 11, `parameter type must not shrink: ${part.value.text}`);
                assert.ok(part.value.clientHeight <= part.lines * 13 + 1);
                assert.ok(part.title.endsWith(part.value.text), 'long values must remain available in full');
                assert.ok(part.bottom <= model.bottom + .6, `parameter height ${part.value.text}`);
            }
        }
    }
}

function colorLuminance(color) {
    const values = color.match(/\d+/g).slice(0, 3).map(value => {
        const channel = Number(value) / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
}

function colorContrast(background, foreground) {
    const values = [colorLuminance(background), colorLuminance(foreground)].sort((a, b) => b - a);
    return (values[0] + .05) / (values[1] + .05);
}

function pixelAt(png, x, y) {
    const index = (Math.max(0, Math.min(png.height - 1, Math.floor(y))) * png.width + Math.max(0, Math.min(png.width - 1, Math.floor(x)))) * 4;
    return [...png.data.subarray(index, index + 3)];
}

function pixelChecks(buffer, card, mode) {
    const png = PNG.sync.read(buffer);
    const x = card.tree.x - card.card.x + 3;
    const top = pixelAt(png, x, card.tree.y - card.card.y + 3);
    const bottom = pixelAt(png, x, card.tree.bottom - card.card.y - 4);
    const whiteTexture = ['outline', 'hatch'].includes(card.texture);
    if (!whiteTexture) assert.ok(Math.min(...top) < 245, `treemap pixels absent: ${top}`);
    const topTiles = card.tiles.filter(tile => Math.abs(tile.y - card.tree.y) < .1);
    const topPixels = topTiles.map(tile => pixelAt(png, tile.right - card.card.x - 3, card.tree.y - card.card.y + 3));
    if (whiteTexture) {
        const borders = topTiles.map(tile => pixelAt(png, tile.x - card.card.x + .2, card.tree.y - card.card.y + 3));
        assert.ok(borders.every(pixel => Math.min(...pixel) < 245), 'white theme rectangle borders absent');
    } else {
        assert.ok(topPixels.every(pixel => Math.min(...pixel) < 245), 'theme top rectangles absent');
        if (card.texture === 'lines') {
            assert.equal(new Set(topPixels.map(pixel => pixel.join(','))).size, 1, 'line themes must not alternate color blocks');
            const lines = topTiles.slice(0, -1).map(tile => [-1.5, -.5, .5]
                .map(offset => pixelAt(png, tile.right - card.card.x + offset, card.tree.y - card.card.y + 3))
                .sort((a, b) => Math.min(...a) - Math.min(...b))[0]);
            assert.ok(lines.every(pixel => Math.min(...pixel) < Math.min(...topPixels[0]) - 8), 'single-pixel separators absent');
        } else if (card.tree.width > 700 && card.tiles.length > 3) assert.ok(new Set(topPixels.map(pixel => pixel.join(','))).size >= 3, 'wide top pixels must show varied blocks');
    }
    if (mode === 'default') {
        assert.ok(Math.min(...bottom) >= 249, `treemap must disappear below fade: ${bottom}`);
        const bar = card.models[0]?.bars.find(bar => bar.height > 30);
        assert.ok(bar, 'no visible tall model bar');
        const fill = pixelAt(png, bar.x - card.card.x + 4, bar.y - card.card.y + 18);
        const expected = bar.color.match(/\d+/g).slice(0, 3).map(Number);
        assert.ok(fill.every((value, index) => Math.abs(value - expected[index]) <= 3), `bar pixel ${fill} != ${expected}`);
        return { top, bottom, topPixels, bar: fill };
    }
    if (!whiteTexture) assert.ok(Math.min(...bottom) < 245, `full composition bottom missing: ${bottom}`);
    return { top, bottom, topPixels };
}

function rangePixelChecks(buffer, card) {
    const model = card.models.find(model => {
        const range = model.bars.find(bar => bar.kind === 'range'), known = model.bars.find(bar => bar.kind === 'known');
        return range && known && known.height > 40 && known.y - range.y > 6;
    });
    assert.ok(model, 'no exposed range for pixel check');
    const range = model.bars.find(bar => bar.kind === 'range'), known = model.bars.find(bar => bar.kind === 'known');
    const png = PNG.sync.read(buffer);
    const gray = pixelAt(png, range.x + range.width / 2 - card.card.x, (range.y + known.y) / 2 - card.card.y);
    assert.deepEqual(gray, [229, 231, 235], 'upper background is not neutral gray');
    const foreground = pixelAt(png, known.x + 5 - card.card.x, known.y + 10 - card.card.y);
    const expected = known.color.match(/\d+/g).slice(0, 3).map(Number);
    assert.deepEqual(foreground, expected, 'known vendor fill changed');
    return { gray, foreground };
}

async function waitLoaded(page, id = 54) {
    await page.waitForFunction(idValue => document.querySelector(`[data-topic-id="${idValue}"]`)?.dataset.previewState === 'loaded', id);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.querySelectorAll('.th-vendor-mark img')].every(image => image.complete));
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
}

async function newPage(browser, app, width, options = {}) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, hasTouch: width < 500,
        ...(options.context ?? {}) });
    await context.addInitScript(() => {
        const original = window.fetch;
        window.__thPreviewFlight = { active: 0, max: 0 };
        window.fetch = (url, options = {}) => {
            if (!String(url).includes('/api/get_topic_preview')) return original(url, options);
            const flight = window.__thPreviewFlight;
            flight.active++; flight.max = Math.max(flight.max, flight.active);
            let ended = false;
            const end = () => {
                if (ended) return;
                ended = true; flight.active--; options.signal?.removeEventListener('abort', end);
            };
            options.signal?.addEventListener('abort', end, { once: true });
            if (options.signal?.aborted) end();
            return original(url, options).then(response => {
                const json = response.json.bind(response);
                response.json = () => json().finally(end);
                if (!response.headers.get('content-type')?.includes('application/json')) end();
                return response;
            }, error => { end(); throw error; });
        };
    });
    if (options.initScript) await context.addInitScript(options.initScript);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(app.url, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('script[type="module"]').first().getAttribute('src').then(src => src.startsWith('/build/index/')), built);
    return { context, page };
}

async function revealFilters(page) {
    if (await page.locator('#topics-filters').evaluate(node => node.hidden)) {
        await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
    }
    await page.waitForFunction(() => {
        const filters = document.getElementById('topics-filters');
        return !filters.hidden && parseFloat(document.body.style.getPropertyValue('--th-filter-height')) >= filters.getBoundingClientRect().height;
    });
}

async function returnToTop(page) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForFunction(() => document.getElementById('topics-filters').hidden);
}

async function inputHasNoFrame(input) {
    await input.focus();
    const result = await input.evaluate(node => {
        const style = getComputedStyle(node);
        return { outline: style.outlineStyle, shadow: style.boxShadow };
    });
    assert.equal(result.outline, 'none');
    assert.equal(result.shadow, 'none');
}

async function checkInputFocus(page, engine, width) {
    await page.locator('#topic-search-toggle').click();
    await page.locator('#topics-account').evaluate(node => node.focus({ preventScroll: true }));
    const search = page.locator('#topic-search');
    const before = await page.locator('.th-island').evaluate(node => {
        const style = getComputedStyle(node); return { border: style.borderColor, background: style.backgroundColor, shadow: style.boxShadow };
    });
    await inputHasNoFrame(search);
    const focused = await page.locator('.th-island').evaluate(node => {
        const style = getComputedStyle(node);
        return { outline: style.outlineStyle, shadow: style.boxShadow, border: style.borderColor, background: style.backgroundColor };
    });
    assert.equal(focused.outline, 'none');
    assert.equal(focused.shadow, before.shadow);
    assert.notEqual(focused.border, before.border);
    assert.notEqual(focused.background, before.background);
    if (width === 320) await page.screenshot({ path: join(output, `${engine}-320-search-focus.png`), animations: 'disabled' });
    await search.press('Tab');
    assert.equal(await page.locator('#topic-search-close').evaluate(node => node === document.activeElement && node.matches(':focus-visible')), true);
    assert.notEqual(await page.locator('#topic-search-close').evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    await page.locator('#topic-search-close').press('Enter');
}

async function hoverRun(browser, engine) {
    const app = await startApp();
    const { page, context } = await newPage(browser, app, 1280);
    try {
        await waitLoaded(page); await delay(150);
        const model = page.locator('[data-topic-id="54"] .th-model').first();
        await page.mouse.move(0, 0);
        const before = PNG.sync.read(await model.screenshot({ path: join(output, `${engine}-1280-model-rest.png`), animations: 'disabled' }));
        const geometry = await model.evaluate(node => {
            const column = node.getBoundingClientRect(), plot = node.querySelector('.th-model-plot').getBoundingClientRect(), bar = node.querySelector('.th-model-bar').getBoundingClientRect();
            return { plotHeight: plot.height, bar: { x: bar.x - column.x, y: bar.y - column.y, width: bar.width, height: bar.height },
                color: getComputedStyle(node.querySelector('.th-model-bar')).backgroundColor };
        });
        await model.hover();
        const after = PNG.sync.read(await model.screenshot({ path: join(output, `${engine}-1280-model-hover.png`), animations: 'disabled' }));
        const restGap = pixelAt(before, 3, geometry.plotHeight - 10), hoverGap = pixelAt(after, 3, geometry.plotHeight - 10);
        assert.ok(restGap.every(value => value >= 249));
        assert.ok(hoverGap.some((value, index) => Math.abs(value - restGap[index]) >= 8), 'plot background did not change on hover');
        let plotChanges = 0, identityChanges = 0, barChanges = 0;
        for (let y = 0; y < before.height; y++) for (let x = 0; x < before.width; x++) {
            const index = (y * before.width + x) * 4;
            if ([0, 1, 2].every(channel => before.data[index + channel] === after.data[index + channel])) continue;
            if (y > geometry.plotHeight + 1) identityChanges++;
            else plotChanges++;
            if (x >= geometry.bar.x + 4 && x < geometry.bar.x + geometry.bar.width - 4
                && y >= geometry.bar.y + 4 && y < geometry.bar.y + geometry.bar.height - 4) barChanges++;
        }
        assert.ok(plotChanges > 50);
        assert.equal(identityChanges, 0, 'hover extended to logos/model names');
        assert.equal(barChanges, 0, 'hover changed the colored bar/score');
        assert.equal(await model.locator('.th-model-bar').evaluate(node => getComputedStyle(node).backgroundColor), geometry.color);
        assert.equal(await model.evaluate(node => node.tagName), 'A');
        assert.ok(await model.getAttribute('href'));
        assert.equal(await model.getAttribute('tabindex'), null);
        checkGeometry(await page.evaluate(geometryInPage), 'default');
        report.interactions.push({ engine, plotOnlyHoverPixels: true, plotChanges, identityChanges, barChanges, restGap, hoverGap, nativeModelAnchor: true });
        console.log(`PASS plot-only hover and centered score ${engine}`);
    } finally { await context.close(); await app.close(); }
}

async function expiredSnapshotRun(browser, engine) {
    const app = await startApp({ previewDelay: 30 });
    const { page, context } = await newPage(browser, app, 1280);
    const requests = () => app.state.requests.filter(request => request.path === '/api/get_topic_preview' && request.body.categoryID === 54);
    try {
        await waitLoaded(page);
        const card = page.locator('[data-topic-id="54"]');
        const scroll = () => card.locator('.th-model-scroll');
        const base = fixtureModels({ categoryID: 54, scoreMode: 'available', reasoning: false, harness: false });
        const fresh = base.slice(1).map(model => ({ ...model, name: 'Fresh ' + model.name, modelName: 'Fresh ' + model.modelName, lower: 40, upper: 40 }));
        for (let index = 0; index < 39; index++) fresh.push({ ...fresh[0], modelID: 100 + index, rank: 37 + index,
            comparisonIdentity: JSON.stringify([['model', true, 100 + index]]) });
        app.state.previewOverrides.set(54, { models: fresh, weights: [{ conditionID: 999, name: 'Fresh benchmark', weightBasisPoints: 9000 }],
            scoreScale: { min: 0, max: 200 } });
        app.state.previewRevisions.set(54, 1);
        await scroll().focus(); await scroll().press('End');
        await card.getByRole('button', { name: 'Refresh preview', exact: true }).waitFor();
        assert.match(await card.locator('.th-card-notice').textContent(), /Preview expired.*Retry/);
        const stoppedCount = requests().length;
        await delay(250);
        assert.equal(requests().length, stoppedCount, 'expiry caused an automatic retry');
        assert.equal(stoppedCount, 2, 'old snapshot was retried before user action');
        const oldOffset = await scroll().evaluate(node => node.scrollLeft);
        const oldSlot = await card.locator('.th-model').first().evaluate(node => node.getBoundingClientRect().width);
        const oldFirst = Math.round(oldOffset / oldSlot);
        const anchor = await card.locator('.th-model').nth(oldFirst).getAttribute('data-model-key');
        const anchorIndex = fresh.findIndex(model => model.comparisonIdentity === anchor);
        app.state.previewDelay = body => body.categoryID === 54 ? 30 : 1200;
        await page.locator('[data-topic-id="4"]').scrollIntoViewIfNeeded();
        for (let attempt = 0; attempt < 50 && app.state.active < 2; attempt++) await delay(10);
        assert.equal(app.state.active, 2, 'fixture did not occupy both preview slots');
        await card.scrollIntoViewIfNeeded();
        await card.getByRole('button', { name: 'Refresh preview', exact: true }).dblclick({ delay: 20 });
        await page.waitForFunction(() => document.querySelector('[data-topic-id="54"]')?.dataset.snapshotId.endsWith(':v1'));
        await waitLoaded(page); await delay(250);
        const after = requests().slice(stoppedCount);
        assert.equal(after.filter(request => !request.body.snapshotID).length, 1, 'refresh must acquire exactly one new initial snapshot');
        assert.ok(after.every(request => !request.body.snapshotID || request.body.snapshotID.endsWith(':v1')), 'old and new snapshot requests mixed');
        assert.ok(after.filter(request => !request.body.snapshotID).every(request => !Object.hasOwn(request.body, 'offset')));
        const keys = await card.locator('.th-model').evaluateAll(nodes => nodes.map(node => node.dataset.modelKey));
        assert.deepEqual(keys, fresh.slice(0, keys.length).map(model => model.comparisonIdentity), 'fresh results appended to old rows');
        assert.ok(!keys.includes(base[0].comparisonIdentity), 'old-only model survived refresh');
        assert.equal(await card.locator('.th-treemap').getAttribute('data-total-weight'), '9000');
        assert.equal(await card.locator('.th-tile').count(), 1);
        assert.match(await card.locator('.th-tile').getAttribute('title'), /Fresh benchmark/);
        const slot = await card.locator('.th-model').first().evaluate(node => node.getBoundingClientRect().width);
        assert.ok(Math.abs(await scroll().evaluate(node => node.scrollLeft) - anchorIndex * slot) < 1, 'refresh lost available model anchor');
        const barRatio = await card.locator('.th-model-bar').first().evaluate(node => node.getBoundingClientRect().height / node.closest('.th-model-plot').getBoundingClientRect().height);
        assert.ok(Math.abs(barRatio - .65) < .005, 'fresh Available results leader must fill the relative envelope');
        assert.match(await card.locator('.th-card-notice').textContent(), /Preview refreshed/);
        checkGeometry(await page.evaluate(geometryInPage), 'default');
        await card.screenshot({ path: join(output, `${engine}-1280-snapshot-refreshed.png`), animations: 'disabled' });

        app.state.previewRevisions.set(54, 2);
        await scroll().focus(); await scroll().press('End');
        await card.getByRole('button', { name: 'Refresh preview', exact: true }).waitFor();
        const expiredAgainCount = requests().length;
        await delay(250);
        assert.equal(requests().length, expiredAgainCount, 'repeated expiry automatically reacquired a snapshot');
        app.state.failures.set(54, 1);
        await card.getByRole('button', { name: 'Refresh preview', exact: true }).click();
        await card.getByRole('button', { name: 'Retry preview', exact: true }).waitFor();
        const failedRefreshCount = requests().length;
        await delay(250);
        assert.equal(requests().length, failedRefreshCount, 'failed refresh retried itself');
        assert.equal(await card.locator('.th-model').count(), 0, 'old chart remained after failed refresh');
        await card.getByRole('button', { name: 'Retry preview', exact: true }).click();
        await waitLoaded(page);
        assert.ok((await card.getAttribute('data-snapshot-id')).endsWith(':v2'));
        assert.ok(requests().slice(expiredAgainCount).every(request => !request.body.snapshotID || request.body.snapshotID.endsWith(':v2')));
        assert.ok(app.state.maxActive <= 2);
        report.interactions.push({ engine, expiredSnapshotManualRefresh: true, noAutomaticExpiryOrFailedRefreshLoop: true,
            queuedDoubleRetryBounded: true, freshSnapshotFullyReplacesRowsWeightsAndScale: true, availableModelAnchorPreserved: true });
        console.log(`PASS expired snapshot recovery ${engine}`);
    } finally { await context.close(); await app.close(); }
}

async function relativeBarsRun(browser, engine, width) {
    const app = await startApp({ previewDelay: 20 });
    const models = fixtureModels({ categoryID: 54, scoreMode: 'available' }).map(model => ({ ...model,
        lower: model.lower * .71, upper: model.lower * .71 }));
    app.state.previewOverrides.set(54, { models, scoreScale: { min: -20, max: 200 } });
    const { page, context } = await newPage(browser, app, width);
    try {
        await waitLoaded(page);
        const card = page.locator('[data-topic-id="54"]');
        const readBars = () => card.evaluate(node => ({
            plotHeight: node.querySelector('.th-treemap').getBoundingClientRect().height,
            bars: [...node.querySelectorAll('.th-model')].map(model => ({
                height: model.querySelector('.th-model-bar').getBoundingClientRect().height,
                text: model.querySelector('.th-model-score').textContent
            }))
        }));
        const checkRelative = snapshot => {
            assert.ok(Math.abs(snapshot.bars[0].height / snapshot.plotHeight - .65) < .001, 'leader is not 65% of the treemap');
            for (const [index, bar] of snapshot.bars.entries()) {
                const expected = models[index].lower / models[0].lower * .65;
                assert.ok(Math.abs(bar.height / snapshot.plotHeight - expected) < .001, `absolute or page-local height at model ${index}`);
                assert.equal(bar.text, String(Math.round(models[index].lower)), 'normalization changed the actual score label');
            }
        };
        const before = await readBars(); checkRelative(before);
        checkGeometry(await page.evaluate(geometryInPage), 'default');
        await card.screenshot({ path: join(output, `${engine}-${width}-relative-available.png`), animations: 'disabled' });
        const scroll = card.locator('.th-model-scroll');
        const originalScroller = await scroll.elementHandle();
        await scroll.focus(); await scroll.press('End');
        await page.waitForFunction(count => document.querySelector('[data-topic-id="54"]')?.querySelectorAll('.th-model').length === count, models.length);
        const after = await readBars(); checkRelative(after);
        assert.equal(after.bars[0].height, before.bars[0].height, 'appending lower models changed the leader height');
        assert.ok(await originalScroller.evaluate(node => node.isConnected), 'normalization replaced the scrolling node on append');

        app.state.previewOverrides.set(54, { models: models.map(model => ({ ...model, upper: Math.min(100, model.lower + 14) })),
            scoreScale: { min: 0, max: 100 } });
        await revealFilters(page);
        await page.getByRole('button', { name: 'Score range', exact: true }).click();
        await card.locator('.th-model-range').first().waitFor({ state: 'attached' });
        await waitLoaded(page);
        const range = await readBars();
        assert.ok(Math.abs(range.bars[0].height / range.plotHeight - .71 * .65) < .001, 'range lost its absolute scale');
        assert.equal(range.bars[0].text, '71');
        await page.getByRole('button', { name: 'Available results', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('[data-topic-id="54"] .th-model-range'));
        await waitLoaded(page);
        checkRelative(await readBars());
        report.interactions.push({ engine, width, relativeAvailableBars: true, leaderScore: 71,
            leaderHeightRatio: after.bars[0].height / after.plotHeight, stableAcrossPages: true, originalLabels: true, rangeUnchanged: true });
        console.log(`PASS relative available bars ${engine} ${width}`);
    } finally { await context.close(); await app.close(); }
}

async function layoutRun(browser, engine, width) {
    const app = await startApp();
    const { page, context } = await newPage(browser, app, width);
    try {
        await waitLoaded(page);
        await delay(250);
        await page.evaluate(() => scrollTo(0, 0));
        const defaults = await page.evaluate(geometryInPage); checkGeometry(defaults, 'default');
        assert.equal(await page.locator('.th-card').count(), 16);
        assert.deepEqual(await page.locator('.th-card').evaluateAll(nodes => nodes.map(node => Number(node.dataset.topicId))),
            [54, ...app.state.topics.filter(topic => topic.ID !== 54).map(topic => topic.ID)]);
        assert.ok(app.state.maxActive <= 2, `concurrency ${app.state.maxActive}`);
        assert.ok(app.state.requests.filter(request => request.path.endsWith('get_topic_preview')).length < 16, 'offscreen previews were eager');
        assert.equal(await page.locator('[data-topic-id="54"] .th-card-title a').getAttribute('href'), '/community-priorities?source=home');
        await page.screenshot({ path: join(output, `${engine}-${width}-default.png`), animations: 'disabled' });
        const featured = page.locator('[data-topic-id="54"]');
        const defaultBuffer = await featured.screenshot({ path: join(output, `${engine}-${width}-featured.png`), animations: 'disabled' });
        const defaultCard = (await page.evaluate(geometryInPage)).cards.find(card => card.id === '54');
        const pixels = { default: pixelChecks(defaultBuffer, defaultCard, 'default') };
        const previewRequests = () => app.state.requests.filter(request => request.path === '/api/get_topic_preview' && request.body.categoryID === 54).length;
        const beforeScrollRequests = previewRequests();
        const firstDocumentY = await featured.evaluate(node => node.getBoundingClientRect().top + scrollY);
        await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY - 12));
        assert.equal(await page.locator('#topics-filters').isVisible(), false, 'filters appeared before the headline passed');
        await revealFilters(page);
        assert.ok(Math.abs(await featured.evaluate(node => node.getBoundingClientRect().top + scrollY) - firstDocumentY) < .6, 'filter reveal shifted cards');
        assert.equal(previewRequests(), beforeScrollRequests, 'revealing filters refetched the ranking');
        checkGeometry(await page.evaluate(geometryInPage), 'default');
        await page.getByRole('button', { name: 'Benchmark weights', exact: true }).click();
        await delay(70);
        const weights = await page.evaluate(geometryInPage); checkGeometry(weights, 'weights');
        await returnToTop(page);
        await page.screenshot({ path: join(output, `${engine}-${width}-weights.png`), animations: 'disabled' });
        const weightBuffer = await featured.screenshot({ path: join(output, `${engine}-${width}-composition.png`), animations: 'disabled' });
        const weightCard = (await page.evaluate(geometryInPage)).cards.find(card => card.id === '54');
        pixels.weights = pixelChecks(weightBuffer, weightCard, 'weights');
        assert.equal(await featured.locator('.th-model-scroll').count(), 0);
        assert.match(await featured.locator('[data-weight-key="other"]').getAttribute('title'), /Other.*2%[\s\S]*Small benchmark A/);
        await revealFilters(page);
        await page.getByRole('button', { name: 'Default view', exact: true }).click();
        const restored = await page.evaluate(geometryInPage); checkGeometry(restored, 'default');
        const footer = await page.locator('.th-footer').evaluate(node => {
            const box = node.getBoundingClientRect();
            return { left: box.left, right: box.right, links: [...node.querySelectorAll('a')].map(link => {
                const rect = link.getBoundingClientRect();
                return { text: link.textContent, href: link.getAttribute('href'), left: rect.left, right: rect.right };
            }) };
        });
        assert.ok(footer.links.every(link => link.left >= footer.left - .5 && link.right <= footer.right + .5), 'footer link overflow');
        assert.ok(footer.links.some(link => link.text === 'Cookies' && link.href === '/cookies'));
        assert.ok(footer.links.some(link => link.text === 'Community' && link.href === '/community-guidelines'));
        report.layouts.push({ engine, width, metadataCards: 16, lazyPreviewRequests: app.state.requests.filter(request => request.path.endsWith('get_topic_preview')).length,
            maxInFlight: app.state.maxActive, columns: defaults.columns, visibleModelColumns: defaultCard.models.length,
            topRectangles: defaultCard.tiles.filter(tile => Math.abs(tile.y - defaultCard.tree.y) < .1).length,
            centeredWidth: defaultCard.frame.width, pixels });
        console.log(`PASS layout ${engine} ${width}: ${defaultCard.models.length} whole columns, treemap/bar pixels checked`);
        if (width === 320) await page.locator('.th-footer').screenshot({ path: join(output, `${engine}-320-footer.png`), animations: 'disabled' });
        await checkInputFocus(page, engine, width);
        await revealFilters(page);
        checkGeometry(await page.evaluate(geometryInPage), 'default');
        const island = await page.locator('.th-island').boundingBox();
        const filters = await page.locator('#topics-filters').boundingBox();
        assert.ok(island.y >= filters.height && island.y <= filters.height + 20, 'island did not stick below top filters');
        assert.equal(await page.locator('.th-island-brand').getAttribute('aria-hidden'), 'false');
        await page.screenshot({ path: join(output, `${engine}-${width}-glass-filters.png`), animations: 'disabled' });
        await page.getByRole('button', { name: 'Benchmark weights', exact: true }).focus();
        await returnToTop(page);
        assert.equal(await page.locator('#treemap-theme-picker,#card-style-picker').count(), 0);
        assert.equal(await page.locator('#topics-popular').evaluate(node => node === document.activeElement), true, 'hiding filters lost keyboard focus');
        assert.ok(Math.abs(await featured.evaluate(node => node.getBoundingClientRect().top + scrollY) - firstDocumentY) < .6, 'filter hide shifted cards');
        assert.equal(previewRequests(), beforeScrollRequests, 'showing/hiding filters refetched the ranking');
    } finally { await context.close(); await app.close(); }
}

async function directoryRun(browser, engine) {
    const app = await startApp({ previewDelay: 80 });
    const { page, context } = await newPage(browser, app, 390, { initScript: () => {
        const record = (categoryID, visitedAt, isPrivate = false) => ({ categoryID, visitedAt, isPrivate, contextValues: {} });
        localStorage.setItem('benchpoll-sidebar-recent-v1:user:42', JSON.stringify([record(5, 600), record(15, 500, true), record(2, 400), record(999, 300)]));
        localStorage.setItem('benchpoll-sidebar-recent-v1:user:99', JSON.stringify([record(1, 900)]));
    } });
    const visibleIDs = () => page.locator('.th-card:visible').evaluateAll(nodes => nodes.map(node => Number(node.dataset.topicId)));
    const browserPeaks = [];
    const openTarget = async (link, mode, pathname) => {
        const href = await link.getAttribute('href');
        const expected = new URL(href, app.url);
        assert.equal(expected.pathname, pathname); assert.equal(expected.searchParams.get('mode'), mode);
        assert.ok(expected.searchParams.get('focusModel'));
        const popupReady = context.waitForEvent('page');
        await link.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
        const popup = await popupReady; await popup.waitForLoadState('domcontentloaded');
        assert.equal(popup.url(), expected.href); assert.equal(await popup.title(), 'Topic target fixture');
        await popup.close(); return Object.fromEntries(expected.searchParams);
    };
    try {
        await waitLoaded(page);
        await page.getByRole('tab', { name: 'Recent', exact: true }).click();
        assert.deepEqual(await visibleIDs(), [5, 15, 2], 'Recent must use this account and authorized metadata only');
        await page.getByRole('tab', { name: 'Mine', exact: true }).click();
        assert.deepEqual(await visibleIDs(), app.state.topics.filter(topic => topic.configured || topic.isPrivate && topic.isMine).map(topic => topic.ID));
        await page.getByRole('button', { name: 'New private topic', exact: true }).click();
        assert.equal(await page.locator('#create-topic-dialog input[type="checkbox"], #create-topic-dialog input[type="radio"]').count(), 0);
        await page.locator('#new-topic-name').fill('Private research');
        await page.locator('#new-topic-description').fill('Research tasks with personal benchmarks.');
        for (const [error, message] of [['reserved_topic_name', /reserved/i], ['topic_name_exists', /already exists/i]]) {
            app.state.createError = { status: error === 'reserved_topic_name' ? 400 : 409, error };
            await page.getByRole('button', { name: 'Create private topic', exact: true }).click();
            await page.waitForFunction(text => document.querySelector('#create-topic-status').textContent.includes(text),
                error === 'reserved_topic_name' ? 'reserved' : 'already exists');
            assert.match(await page.locator('#create-topic-status').textContent(), message);
            assert.equal(await page.locator('#new-topic-name').inputValue(), 'Private research');
        }
        app.state.createError = null;
        await page.getByRole('button', { name: 'Create private topic', exact: true }).click();
        await page.locator('[data-topic-id="200"]').waitFor();
        assert.equal(await page.locator('[data-topic-id="200"] .th-topic-link').getAttribute('href'), '/personal/200');
        assert.equal(await page.locator('[data-topic-id="200"]').isVisible(), true);
        assert.equal(app.state.created[0].isPrivate, true);
        await page.getByRole('tab', { name: 'Popular', exact: true }).click(); await waitLoaded(page);
        const publicTarget = await openTarget(page.locator('[data-topic-id="54"] a.th-model').first(), 'public', '/community-priorities');
        assert.equal(publicTarget.source, 'home');
        assert.equal(publicTarget.scoreMode, 'available'); assert.equal(publicTarget.compareReasoning, '0'); assert.equal(publicTarget.compareHarness, '0');
        await page.getByRole('tab', { name: 'Mine', exact: true }).click();
        await page.locator('[data-topic-id="15"]').scrollIntoViewIfNeeded(); await waitLoaded(page, 15);
        const privateTarget = await openTarget(page.locator('[data-topic-id="15"] a.th-model').first(), 'personal', '/personal/15');
        await page.getByRole('tab', { name: 'Popular', exact: true }).click();
        const themePixels = [];
        for (const theme of [HOME_WEIGHT_THEME]) {
            await revealFilters(page);
            await page.getByRole('button', { name: 'Benchmark weights', exact: true }).click(); await delay(90);
            await returnToTop(page);
            const geometry = await page.evaluate(geometryInPage); checkGeometry(geometry, 'weights');
            const card = geometry.cards.find(card => card.id === '54');
            const buffer = await page.locator('[data-topic-id="54"]').screenshot({ path: join(output, `${engine}-390-theme-${theme.id}.png`), animations: 'disabled' });
            themePixels.push({ theme: theme.id, pixels: pixelChecks(buffer, card, 'weights') });
            if (theme.texture === 'lines') {
                await page.setViewportSize({ width: 1440, height: 1000 }); await delay(80);
                const wide = await page.evaluate(geometryInPage); checkGeometry(wide, 'weights');
                const wideCard = wide.cards.find(item => item.id === '54');
                const wideBuffer = await page.locator('[data-topic-id="54"]').screenshot({ path: join(output, `${engine}-1440-theme-${theme.id}.png`), animations: 'disabled' });
                themePixels.push({ theme: theme.id, width: 1440, pixels: pixelChecks(wideBuffer, wideCard, 'weights') });
                await page.setViewportSize({ width: 390, height: 1000 }); await delay(80);
            }
        }
        assert.equal(await page.locator('#treemap-theme-picker,#card-style-picker').count(), 0);
        assert.equal(await page.locator('body').getAttribute('data-card-style'), 'outline');
        await page.evaluate(() => {
            localStorage.setItem('benchpoll-topics-home-theme-v1', 'vivid');
            localStorage.setItem('benchpoll-topic-card-style-v1', 'lift');
            dispatchEvent(new StorageEvent('storage', { key: 'benchpoll-topics-home-theme-v1', newValue: 'vivid' }));
        });
        assert.equal(await page.locator('body').getAttribute('data-weight-theme'), 'frost-hatch');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.setViewportSize({ width: 390, height: 360 });
        await revealFilters(page);
        assert.equal(await page.locator('#topics-filters').evaluate(node => getComputedStyle(node).animationName), 'none');
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        browserPeaks.push(await page.evaluate(() => window.__thPreviewFlight.max));
        await page.reload(); await waitLoaded(page);
        assert.equal(await page.locator('body').getAttribute('data-weight-theme'), 'frost-hatch', 'old palette preference must not override the fixed theme');
        assert.equal(await page.locator('body').getAttribute('data-card-style'), 'outline', 'old surface preference must not override Outline');
        await revealFilters(page);
        await page.getByRole('button', { name: 'Score range', exact: true }).click();
        await page.getByRole('button', { name: 'Compare reasoning effort separately', exact: true }).click();
        await page.getByRole('button', { name: 'Compare harnesses separately', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-topic-id="54"]').dataset.snapshotId === 'snapshot:54:range:true:true:4');
        const comparisonTarget = new URL(await page.locator('[data-topic-id="54"] a.th-model').first().getAttribute('href'), app.url);
        assert.deepEqual(['scoreMode', 'compareReasoning', 'compareHarness', 'mode'].map(key => comparisonTarget.searchParams.get(key)), ['range', '1', '1', 'public']);
        assert.equal(JSON.parse(comparisonTarget.searchParams.get('focusModel')).length, 3);
        await page.getByRole('button', { name: 'Available results', exact: true }).click();
        await page.getByRole('button', { name: 'Compare reasoning effort separately', exact: true }).click();
        await page.getByRole('button', { name: 'Compare harnesses separately', exact: true }).click();
        await page.locator('#topic-search-toggle').click(); await page.locator('#topic-search').fill('Math');
        await page.locator('[data-topic-id="3"]').scrollIntoViewIfNeeded(); await waitLoaded(page, 3);
        const math = page.locator('[data-topic-id="3"]');
        const lowScores = await math.locator('.th-model-score').evaluateAll(nodes => nodes.map(score => ({ text: score.textContent,
            outside: score.classList.contains('is-outside'), font: parseFloat(getComputedStyle(score).fontSize), color: getComputedStyle(score).color,
            barHeight: score.closest('.th-model-plot').querySelector('.th-model-bar').getBoundingClientRect().height })));
        for (const score of ['16', '14']) assert.ok(lowScores.some(item => item.text === score && !item.outside && item.font >= 9), `low score ${score} is not readable white inside`);
        const eleven = lowScores.find(item => item.text === '11');
        assert.ok(eleven && (eleven.outside ? eleven.barHeight < 13 && eleven.color === 'rgb(40, 49, 62)' : eleven.font >= 9), '11 can move outside only when the actual shorter chart cannot fit its minimum readable line');
        assert.ok(lowScores.filter(score => ['3', '0'].includes(score.text)).every(score => score.outside), 'physically impossible scores must remain outside');
        checkGeometry(await page.evaluate(geometryInPage), 'default');
        await math.screenshot({ path: join(output, `${engine}-390-low-scores-16-14.png`), animations: 'disabled' });
        await math.getByRole('button', { name: 'Next models', exact: true }).click(); await delay(450);
        checkGeometry(await page.evaluate(geometryInPage), 'default');
        await math.screenshot({ path: join(output, `${engine}-390-low-scores-11.png`), animations: 'disabled' });
        await page.locator('#topic-search').focus();
        await page.screenshot({ path: join(output, `${engine}-390-search-morph.png`), animations: 'disabled' });
        await page.locator('#topic-search').press('Escape');
        assert.equal(await page.locator('body').getAttribute('data-collection'), 'popular');
        await page.getByRole('tab', { name: 'Popular', exact: true }).focus(); await page.keyboard.press('ArrowRight');
        assert.equal(await page.locator('body').getAttribute('data-collection'), 'recent');
        await page.keyboard.press('Home');
        await page.locator('[data-topic-id="54"]').scrollIntoViewIfNeeded(); await waitLoaded(page);
        browserPeaks.push(await page.evaluate(() => window.__thPreviewFlight.max));
        const link = page.locator('[data-topic-id="54"] a.th-model').first();
        await link.focus(); await page.keyboard.press('Enter');
        await page.waitForURL(url => url.pathname === '/community-priorities' && url.searchParams.has('focusModel'));
        assert.equal(await page.title(), 'Topic target fixture');
        assert.ok(browserPeaks.every(peak => peak <= 2), `uncancelled browser preview concurrency ${browserPeaks}`);
        report.interactions.push({ engine, directoryAccountScopedRecentMineConfigured: true, publicAndPrivateCreateActions: true,
            reservedAndExistingNameInlineDraftRetention: true, nativePublicAndPersonalModelTargets: { publicTarget, privateTarget }, comparisonIntent: true,
            fixedPalettePixels: themePixels, obsoleteAppearancePreferencesIgnored: true, reducedMotionGlass: true,
            neutralSurface: 'outline', lowScoresWhiteCentered: lowScores, searchMorphKeyboardAndNativeEnter: true,
            rapidCollectionChangesRecoverPreviews: true,
            browserPreviewPeaks: browserPeaks, serverPeakIncludingCanceledRequests: app.state.maxActive });
        console.log(`PASS directory, themes, low scores and public/private targets ${engine}`);
    } catch (error) {
        report.directoryFailure = { engine, page: await page.evaluate(() => ({ collection: document.body.dataset.collection, y: scrollY,
            cards: [...document.querySelectorAll('.th-card')].slice(0, 5).map(card => ({ id: card.dataset.topicId, state: card.dataset.previewState,
                hidden: card.hidden, top: card.getBoundingClientRect().top, models: card.querySelectorAll('.th-model').length })) })),
        requests: app.state.requests.filter(request => request.path === '/api/get_topic_preview').slice(-15) };
        await page.screenshot({ path: join(output, `${engine}-directory-failure.png`), animations: 'disabled' });
        throw error;
    } finally { await context.close(); await app.close(); }

    const guestApp = await startApp({ authenticated: false });
    const guest = await newPage(browser, guestApp, 320, { initScript: () => {
        localStorage.setItem('benchpoll-sidebar-recent-v1:guest', JSON.stringify([
            { categoryID: 3, visitedAt: 20, isPrivate: false, contextValues: {} }, { categoryID: 15, visitedAt: 10, isPrivate: false, contextValues: {} }]));
        localStorage.setItem('benchpoll-sidebar-recent-v1:user:42', JSON.stringify([{ categoryID: 5, visitedAt: 50, isPrivate: false, contextValues: {} }]));
    } });
    try {
        await waitLoaded(guest.page);
        assert.equal(await guest.page.locator('[data-topic-id="15"]').count(), 0);
        await guest.page.getByRole('tab', { name: 'Recent', exact: true }).click();
        assert.deepEqual(await guest.page.locator('.th-card:visible').evaluateAll(nodes => nodes.map(node => Number(node.dataset.topicId))), [3]);
        await guest.page.getByRole('tab', { name: 'Mine', exact: true }).click();
        await guest.page.locator('#topics-status a[href="/login"]').waitFor();
        await guest.page.getByRole('button', { name: 'New private topic', exact: true }).click();
        assert.equal(await guest.page.locator('#create-topic-dialog input[type="checkbox"]').count(), 0);
        await guest.page.locator('#create-topic-status a[href="/login"]').waitFor();
        await guest.page.getByRole('button', { name: 'Close new topic', exact: true }).click();
        await guest.page.getByRole('tab', { name: 'Mine', exact: true }).click();
        assert.equal(await guest.page.locator('.th-card:visible').count(), 0);
        report.interactions.push({ engine, guestRecentDoesNotLeakOtherAccountOrPrivateMetadata: true, guestMineConfiguredRequireSignIn: true });
    } finally { await guest.context.close(); await guestApp.close(); }
}

async function interactions(browser, engine) {
    const app = await startApp({ previewDelay: 200 });
    const { page, context } = await newPage(browser, app, 390);
    try {
        await page.waitForSelector('.th-card');
        assert.equal(await page.locator('.th-card').count(), 16);
        assert.equal(await page.locator('[data-preview-state="loaded"]').count(), 0, 'metadata waited for previews');
        await waitLoaded(page);
        const featured = page.locator('[data-topic-id="54"]');
        const scroller = featured.locator('.th-model-scroll');
        await scroller.focus(); await scroller.press('ArrowRight'); await delay(250);
        assert.ok(await scroller.evaluate(node => node.scrollLeft > 0), 'keyboard scroll did not move');
        await scroller.press('Home'); await delay(200);
        await scroller.hover(); await page.mouse.wheel(350, 0); await delay(600);
        assert.ok(await scroller.evaluate(node => node.scrollLeft > 0), 'native horizontal wheel did not move');
        checkGeometry(await page.evaluate(geometryInPage), 'default');
        if (engine === 'chrome') {
            await scroller.evaluate(node => { node.scrollLeft = 0; }); await delay(220);
            const box = await scroller.boundingBox();
            const session = await context.newCDPSession(page);
            await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * .8, y: box.y + box.height / 2 }] });
            for (let step = 1; step <= 12; step++) {
                await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * .8 - step * 15, y: box.y + box.height / 2 }] });
                await delay(18);
            }
            await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await delay(450);
            assert.ok(await scroller.evaluate(node => node.scrollLeft > 0), 'native touch pan did not move');
            await session.detach();
        } else {
            await page.getByRole('button', { name: 'Next models', exact: true }).first().tap(); await delay(450);
            assert.ok(await scroller.evaluate(node => node.scrollLeft > 0), 'touch model navigation did not move');
        }
        checkGeometry(await page.evaluate(geometryInPage), 'default');
        const weightsBefore = await featured.locator('.th-treemap').getAttribute('data-total-weight');
        const columnsBefore = await featured.locator('.th-model').count(); assert.equal(columnsBefore, 25);
        app.state.failures.set(54, 1);
        await scroller.focus(); await scroller.press('End');
        await featured.getByRole('button', { name: 'Retry more models', exact: true }).waitFor({ state: 'visible' });
        const offsetBefore = await scroller.evaluate(node => node.scrollLeft);
        await featured.getByRole('button', { name: 'Retry more models', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-topic-id="54"]')?.querySelectorAll('.th-model').length === 37);
        await delay(220);
        assert.equal(await featured.locator('.th-treemap').getAttribute('data-total-weight'), weightsBefore);
        const offsetAfter = await scroller.evaluate(node => node.scrollLeft);
        assert.ok(Math.abs(offsetAfter - offsetBefore) < 1, `pagination reset horizontal position: ${offsetBefore} -> ${offsetAfter}`);
        const pageRequests = app.state.requests.filter(request => request.path.endsWith('get_topic_preview') && request.body.categoryID === 54 && request.body.snapshotID);
        assert.ok(pageRequests.length >= 2);
        assert.ok(pageRequests.every(request => request.body.offset === 25 && request.body.snapshotID === 'snapshot:54:available:false:false:4'));
        checkGeometry(await page.evaluate(geometryInPage), 'default');
        await revealFilters(page);
        await page.getByRole('button', { name: 'Benchmark weights', exact: true }).click();
        await page.getByRole('button', { name: 'Default view', exact: true }).click();
        assert.ok(Math.abs(await scroller.evaluate(node => node.scrollLeft) - offsetBefore) < 1, 'view switch reset horizontal position');
        await page.setViewportSize({ width: 768, height: 1000 }); await delay(200);
        checkGeometry(await page.evaluate(geometryInPage), 'default');
        await page.setViewportSize({ width: 390, height: 1000 }); await delay(200);
        await page.locator('#topic-search-toggle').click();
        await page.locator('#topic-search').fill('Science');
        await page.locator('[data-topic-id="2"]').scrollIntoViewIfNeeded(); await waitLoaded(page, 2);
        assert.equal(await page.locator('.th-card:visible').count(), 1);
        assert.ok(await page.locator('[data-topic-id="2"] .th-model-score.is-outside').count() >= 2);
        await page.locator('#topic-search').fill('nothing matches this topic');
        await page.locator('#topics-status').getByRole('button', { name: 'Clear search', exact: true }).click();
        assert.equal(await page.locator('.th-card:visible').count(), 16);
        await page.locator('#topic-search').press('Escape');
        await page.locator('[data-topic-id="8"]').scrollIntoViewIfNeeded(); await waitLoaded(page, 8);
        assert.match(await page.locator('[data-topic-id="8"] .th-visual').textContent(), /No community weights/);
        await page.locator('[data-topic-id="9"]').scrollIntoViewIfNeeded(); await waitLoaded(page, 9);
        assert.match(await page.locator('[data-topic-id="9"] .th-visual').textContent(), /No model results/);
        await page.evaluate(() => scrollTo(0, 0));
        await page.getByRole('tab', { name: 'Mine', exact: true }).click();
        await page.getByRole('button', { name: 'New private topic', exact: true }).click();
        await inputHasNoFrame(page.locator('#new-topic-name'));
        await inputHasNoFrame(page.locator('#new-topic-description'));
        await page.locator('#new-topic-name').focus();
        await page.screenshot({ path: join(output, `${engine}-390-create-focus.png`), animations: 'disabled' });
        await page.locator('#new-topic-name').fill('Reliable coding');
        await page.locator('#new-topic-description').fill('A focused community topic.');
        app.state.createError = { status: 403, error: 'legal_acceptance_required' };
        await page.getByRole('button', { name: 'Create private topic', exact: true }).click();
        await page.locator('#create-topic-status a[href="/account/privacy"]').waitFor();
        assert.equal(await page.locator('#new-topic-name').inputValue(), 'Reliable coding');
        app.state.createError = null;
        await page.getByRole('button', { name: 'Create private topic', exact: true }).click();
        await page.locator('[data-topic-id="200"]').waitFor();
        assert.equal(await page.locator('#create-topic-dialog').evaluate(node => node.open), false);
        const created = app.state.requests.filter(request => request.path === '/api/create_topic');
        assert.ok(created.length === 2 && created.every(request => request.body.expectedUserID === '42' && !Object.hasOwn(request.body, 'accountUserID')));
        assert.equal(created[1].body.isPrivate, true);
        await page.getByRole('tab', { name: 'Popular', exact: true }).click();
        assert.equal(await page.locator('.th-card').first().getAttribute('data-topic-id'), '54');
        await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('.th-card')].map(node => Number(node.dataset.topicId))) === JSON.stringify(expected),
            [54, ...app.state.topics.filter(topic => topic.ID !== 54).map(topic => topic.ID)]);
        assert.equal(await page.locator('#topics-account').getAttribute('href'), '/me');
        await page.route('**/me', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Profile route fixture</title>' }));
        await page.locator('#topics-account').click();
        await page.waitForURL('**/me');
        assert.equal(await page.title(), 'Profile route fixture');
        report.interactions.push({ engine, keyboard: true, nativeHorizontalScroll: true, touch: engine === 'chrome' ? 'native pan' : 'native tap/navigation',
            paginationRetryPreservesMetadataAndScroll: true, resizeSnap: true, localSearch: true, emptyStates: true, expectedUserID: true, legalDraftRetention: true,
            inputFocusNoExternalFrame: true, serverHeatOrderPreservedAfterCreation: true, profilePageNavigation: true });
        console.log(`PASS interactions ${engine}`);
    } finally { await context.close(); await app.close(); }

    const staleApp = await startApp({ previewDelay: body => body.scoreMode === 'available' ? 700 : 80 });
    const staleContext = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const stalePage = await staleContext.newPage();
    stalePage.on('pageerror', error => report.errors.push(error.message));
    try {
        await stalePage.addInitScript(() => {
            const original = window.fetch;
            window.fetch = (url, options) => original(url, String(url).includes('get_topic_preview') ? { ...options, signal: undefined } : options);
        });
        await stalePage.goto(staleApp.url);
        await stalePage.waitForSelector('[data-preview-state="loading"]');
        await revealFilters(stalePage);
        await stalePage.getByRole('button', { name: 'Score range', exact: true }).click();
        await stalePage.getByRole('button', { name: 'Compare reasoning effort separately', exact: true }).click();
        await stalePage.getByRole('button', { name: 'Compare harnesses separately', exact: true }).click();
        await waitLoaded(stalePage);
        await delay(850);
        assert.equal(await stalePage.locator('[data-topic-id="54"]').getAttribute('data-snapshot-id'), 'snapshot:54:range:true:true:4');
        assert.equal(await stalePage.locator('[data-topic-id="54"] .th-model-score').first().textContent(), '95');
        assert.ok(await stalePage.locator('[data-topic-id="54"] .bp-model-display-parameter').count() > 0);
        const rangeGeometry = await stalePage.evaluate(geometryInPage);
        checkGeometry(rangeGeometry, 'default');
        const rangeBuffer = await stalePage.locator('[data-topic-id="54"]').screenshot({ path: join(output, `${engine}-1280-range-neutral.png`), animations: 'disabled' });
        const neutralRangePixels = rangePixelChecks(rangeBuffer, rangeGeometry.cards.find(card => card.id === '54'));
        await stalePage.screenshot({ path: join(output, `${engine}-1280-parameters.png`), animations: 'disabled' });
        await stalePage.setViewportSize({ width: 320, height: 1000 }); await delay(300);
        const fieldScroller = stalePage.locator('[data-topic-id="54"] .th-model-scroll');
        await fieldScroller.focus();
        await fieldScroller.press('ArrowRight'); await delay(300);
        const narrowFields = await stalePage.evaluate(geometryInPage);
        checkGeometry(narrowFields, 'default');
        const fieldCard = narrowFields.cards.find(card => card.id === '54');
        assert.ok(fieldCard.models.length >= 2, 'bounded diagonal parameters should retain multiple mobile columns');
        const longHarness = fieldCard.models.flatMap(model => model.parameters).find(part => part.value.text === 'Mini-SWE-Agent 2026.10 long harness name');
        assert.ok(longHarness, 'the real long Claude harness must be visible in the 320px screenshot');
        assert.equal(parseFloat(longHarness.value.font), 11);
        assert.equal(longHarness.lines, 2);
        await stalePage.screenshot({ path: join(output, `${engine}-320-parameters.png`), animations: 'disabled' });
        report.interactions.push({ engine, staleResponsesIgnoredEvenWithoutTransportAbort: true, wholeParameterIconAndValueFit: true,
            longHarness320: { text: longHarness.value.text, font: longHarness.value.font, visibleColumns: fieldCard.models.length, slot: fieldCard.models[0].width }, neutralRangePixels });
        console.log(`PASS stale filters ${engine}`);
    } finally { await staleContext.close(); await staleApp.close(); }

    const errorApp = await startApp({ authenticated: false });
    errorApp.state.topicsFailures = 1; errorApp.state.failures.set(54, 1);
    const guest = await newPage(browser, errorApp, 320);
    try {
        await guest.page.getByRole('button', { name: 'Retry topics', exact: true }).click();
        await guest.page.getByRole('button', { name: 'Retry preview', exact: true }).first().click();
        await waitLoaded(guest.page);
        await guest.page.getByRole('tab', { name: 'Mine', exact: true }).click();
        await guest.page.getByRole('button', { name: 'New private topic', exact: true }).click();
        await guest.page.locator('#new-topic-name').fill('Guest draft');
        await guest.page.locator('#new-topic-description').fill('A private draft kept through sign-in.');
        await guest.page.getByRole('button', { name: 'Create private topic', exact: true }).click();
        assert.equal(await guest.page.locator('#create-topic-status a').getAttribute('href'), '/login');
        assert.equal(errorApp.state.created.length, 0);
        assert.equal(await guest.page.locator('#new-topic-name').inputValue(), 'Guest draft');
        await guest.page.getByRole('button', { name: 'Close new topic', exact: true }).click();
        assert.equal(await guest.page.locator('#topics-account').getAttribute('href'), '/login');
        report.interactions.push({ engine, metadataRetry: true, previewRetry: true, guestCreateSignIn: true });
        console.log(`PASS errors/guest ${engine}`);
    } finally { await guest.context.close(); await errorApp.close(); }

    for (const pageSize of [25, 3]) {
        const pagingApp = await startApp({ pageSize, previewDelay: 20 });
        const paging = await newPage(browser, pagingApp, 1280);
        try {
            await waitLoaded(paging.page);
            const card = paging.page.locator('[data-topic-id="54"]');
            if (pageSize === 3) await paging.page.waitForFunction(() => {
                const scroll = document.querySelector('[data-topic-id="54"] .th-model-scroll');
                return scroll && scroll.scrollWidth > scroll.clientWidth;
            });
            const scroll = card.locator('.th-model-scroll');
            const originalScroller = await scroll.elementHandle();
            const initialLoaded = await card.locator('.th-model').count();
            await card.getByRole('button', { name: 'Next models', exact: true }).click();
            const expected = pageSize === 25 ? 37 : initialLoaded + pageSize;
            await paging.page.waitForFunction(count => document.querySelector('[data-topic-id="54"]')?.querySelectorAll('.th-model').length >= count, expected);
            await delay(600);
            assert.ok(await originalScroller.evaluate(node => node.isConnected), 'pagination replaced the scrolling node');
            assert.ok(await scroll.evaluate(node => node.scrollLeft > 0), 'pagination interrupted next-button scrolling');
            assert.equal(await card.locator('.th-treemap').getAttribute('data-total-weight'), '10000');
            checkGeometry(await paging.page.evaluate(geometryInPage), 'default');
            assert.ok(pagingApp.state.maxActive <= 2);
            report.interactions.push({ engine, initialPageSize: pageSize, autoFillExactFit: true, smoothNextScrollSurvivesPagination: true, scrollingNodePreserved: true });
            console.log(`PASS paginated smooth scroll ${engine}, initial ${pageSize}`);
        } finally { await paging.context.close(); await pagingApp.close(); }
    }
    await expiredSnapshotRun(browser, engine);
}

async function cardRun(browser, engine, width) {
    const app = await startApp();
    const { page, context } = await newPage(browser, app, width);
    try {
        await waitLoaded(page);
        const card = page.locator('[data-topic-id="54"]');
        const href = await card.locator('.th-topic-link').getAttribute('href');
        const target = new URL(href, app.url).pathname;
        let box = await card.boundingBox();
        await page.mouse.click(box.x + 8, box.y + 8);
        await page.waitForURL(url => url.pathname === target);
        await page.goBack(); await waitLoaded(page);
        await card.locator('.th-creator').click();
        await page.waitForURL(url => url.pathname === target);
        await page.goBack(); await waitLoaded(page);
        box = await card.boundingBox();
        await page.mouse.move(box.x + 8, box.y + 8); await page.mouse.down();
        await page.mouse.move(box.x + 40, box.y + 8, { steps: 5 }); await page.mouse.up();
        assert.equal(new URL(page.url()).pathname, '/', 'dragging must not activate the card');
        await page.evaluate(() => getSelection().removeAllRanges());
        const popupWait = context.waitForEvent('page');
        await card.locator('.th-creator').click({ modifiers: ['Control'] });
        const popup = await popupWait; await popup.waitForURL(url => url.pathname === target); await popup.close();
        assert.equal(new URL(page.url()).pathname, '/');
        await revealFilters(page);
        await page.getByRole('button', { name: 'Benchmark weights', exact: true }).click();
        await card.locator('.th-tile').first().click();
        await page.waitForURL(url => url.pathname === target);
        await page.goBack(); await waitLoaded(page);
        await card.locator('.th-topic-link').focus(); await card.locator('.th-topic-link').press('Enter');
        await page.waitForURL(url => url.pathname === target);
        report.interactions.push({ engine, width, cardBackground: true, creatorNavigation: true,
            weightsNavigation: true, modifiedClick: true, dragDoesNotNavigate: true, keyboardLink: true });
        console.log(`PASS whole-card navigation ${engine} ${width}`);
    } finally { await context.close(); await app.close(); }
}

async function pageLifecycleRun(browser, engine) {
    const app = await startApp({ previewDelay: 180 });
    const { page, context } = await newPage(browser, app, 1440);
    try {
        const count = () => app.state.requests.filter(request => request.path === '/api/get_topic_preview').length;
        for (let attempt = 0; count() < 2 && attempt < 100; attempt++) await delay(5);
        assert.equal(count(), 2);
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
        const hiddenCount = count();
        await delay(450);
        assert.equal(count(), hiddenCount, 'preview completions must not launch more requests after leaving the page');
        assert.equal(await page.evaluate(() => window.__thPreviewFlight.active), 0);
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
        await waitLoaded(page);
        assert.ok(count() > hiddenCount, 'returning from the back/forward cache must resume pending previews');
        report.interactions.push({ engine, pageHideStopsPreviews: true, cachedPageReturnResumesPreviews: true });
        console.log(`PASS preview page lifecycle ${engine}`);
    } finally { await context.close(); await app.close(); }
}

async function islandMotionRun(browser, engine, width) {
    const app = await startApp();
    const { page, context } = await newPage(browser, app, width);
    try {
        await waitLoaded(page);
        const result = await page.evaluate(async () => {
            const root = document.querySelector('.th-topic-tabs');
            const read = () => {
                const style = getComputedStyle(root, '::before');
                return { x: new DOMMatrix(style.transform).m41, width: parseFloat(style.width), duration: style.transitionDuration };
            };
            await new Promise(resolve => requestAnimationFrame(resolve));
            const before = read(), target = root.querySelector('[data-topics-view="configured"]');
            const end = { x: target.offsetLeft, width: target.offsetWidth };
            target.click();
            const samples = [], start = performance.now();
            while (performance.now() - start < 350) {
                await new Promise(resolve => requestAnimationFrame(resolve)); samples.push(read());
            }
            return { before, end, after: read(), samples };
        });
        assert.ok(result.samples.some(sample => sample.x > result.before.x + 1 && sample.x < result.end.x - 1), 'selection must slide through intermediate positions');
        assert.ok(Math.abs(result.after.x - result.end.x) < 1 && Math.abs(result.after.width - result.end.width) < 1);
        report.interactions.push({ engine, width, islandSlides: true, samples: result.samples });
        console.log(`PASS island selection motion ${engine} ${width}`);
    } finally { await context.close(); await app.close(); }
}

async function chartDetailRun(browser, engine, width) {
    const app = await startApp();
    app.state.previewOverrides.set(54, { weights: [
        { conditionID: 1, name: 'A very long benchmark title that stays available even in a narrow rectangle without losing its original text', conditionName: '2026', weightBasisPoints: 5000 },
        { conditionID: 2, name: 'Math', conditionName: 'Validated accuracy across multiple languages and operating systems, October 2026', weightBasisPoints: 3000 },
        { conditionID: 3, name: 'Code', conditionName: 'Default', weightBasisPoints: 1500 },
        { conditionID: 4, name: 'Tools', conditionName: 'v2', weightBasisPoints: 500 }
    ] });
    const { page, context } = await newPage(browser, app, width);
    try {
        await waitLoaded(page);
        await delay(250);
        checkGeometry(await page.evaluate(geometryInPage), 'default');
        const card = page.locator('[data-topic-id="54"]');
        const names = await card.locator('.th-tile-name, .th-tile-version').evaluateAll(nodes => nodes.map(node => ({
            kind: node.className, text: node.textContent, overflow: node.dataset.overflow,
            align: getComputedStyle(node).textAlign, mask: getComputedStyle(node).maskImage || getComputedStyle(node).webkitMaskImage,
            font: parseFloat(getComputedStyle(node).fontSize)
        })));
        assert.ok(names.some(name => name.kind === 'th-tile-name' && name.overflow === 'true' && name.align === 'left'));
        assert.ok(names.some(name => name.text === 'Math' && name.overflow === 'false' && name.align === 'center'));
        assert.ok(names.some(name => name.kind === 'th-tile-version' && name.overflow === 'true' && name.align === 'left'));
        const fadingName = card.locator('.th-tile-name[data-overflow="true"]').first();
        const faded = PNG.sync.read(await fadingName.screenshot({ path: join(output, `${engine}-${width}-text-fade.png`) }));
        await fadingName.evaluate(node => { node.style.maskImage = 'none'; node.style.webkitMaskImage = 'none'; });
        const unmasked = PNG.sync.read(await fadingName.screenshot());
        await fadingName.evaluate(node => { node.style.removeProperty('mask-image'); node.style.removeProperty('-webkit-mask-image'); });
        let fadedPixels = 0;
        for (let y = 0; y < faded.height; y++) for (let x = Math.max(0, faded.width - 24); x < faded.width; x++) {
            const index = (y * faded.width + x) * 4;
            if (faded.data[index] + faded.data[index + 1] + faded.data[index + 2]
                > unmasked.data[index] + unmasked.data[index + 1] + unmasked.data[index + 2] + 12) fadedPixels++;
        }
        assert.ok(fadedPixels > 4, 'right-edge mask must visibly fade the text pixels, not merely set a CSS property');
        await card.screenshot({ path: join(output, `${engine}-${width}-labels.png`), animations: 'disabled' });
        const samples = await card.locator('.th-model-scroll').evaluate(async scroll => {
            const track = scroll.firstElementChild, slot = parseFloat(track.style.getPropertyValue('--th-slot'));
            const inset = parseFloat(getComputedStyle(scroll).getPropertyValue('--th-label-inset'));
            const visible = Math.round((scroll.clientWidth - inset * 2) / slot);
            const read = (node, fraction) => ({ fraction, opacity: Number(getComputedStyle(node).opacity),
                visibility: getComputedStyle(node).visibility, inert: node.inert, hidden: node.getAttribute('aria-hidden') });
            scroll.style.scrollSnapType = 'none';
            const samples = [];
            for (const fraction of [0, .01, .1, .25, .5, .75, .9, .99, 1]) {
                scroll.scrollLeft = fraction * slot;
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                samples.push({ fraction, outgoing: read(track.children[0], fraction), incoming: read(track.children[visible], fraction) });
            }
            scroll.style.removeProperty('scroll-snap-type');
            return samples;
        });
        assert.equal(samples[0].outgoing.opacity, 1); assert.equal(samples[0].incoming.opacity, 0);
        assert.equal(samples.at(-1).outgoing.opacity, 0); assert.equal(samples.at(-1).incoming.opacity, 1);
        assert.ok(samples[0].incoming.inert); assert.ok(samples.at(-1).outgoing.inert);
        for (const sample of samples) {
            assert.equal(sample.outgoing.visibility, 'visible'); assert.equal(sample.incoming.visibility, 'visible');
            if (sample.fraction >= .1 && sample.fraction <= .9) {
                assert.ok(sample.outgoing.opacity > 0 && sample.outgoing.opacity < 1, 'outgoing column must fade across intermediate positions');
                assert.ok(sample.incoming.opacity > 0 && sample.incoming.opacity < 1, 'incoming column must fade across intermediate positions');
            }
        }
        for (let index = 1; index < samples.length; index++) {
            assert.ok(samples[index].outgoing.opacity <= samples[index - 1].outgoing.opacity);
            assert.ok(samples[index].incoming.opacity >= samples[index - 1].incoming.opacity);
        }
        await card.screenshot({ path: join(output, `${engine}-${width}-scrolled.png`), animations: 'disabled' });
        report.interactions.push({ engine, width, enlargedCenteredLabels: true, longNamesFade: true, longVersionsFade: true,
            fadedPixels, continuousModelEdges: true, samples });
        console.log(`PASS chart text and edge fades ${engine} ${width}`);
    } finally { await context.close(); await app.close(); }
}

try {
    if (built) await prepareBuiltFixture();
    for (const [engine, launcher, launchOptions] of [['chrome', chromium, {}], ['webkit', webkit, {}]]) {
        if (engineOnly && engine !== engineOnly) continue;
        const browser = await launcher.launch({ headless: true, env, ...launchOptions });
        report.browsers[engine] = { name: engine === 'chrome' ? 'Chrome Headless Shell' : 'WebKit', version: browser.version() };
        try {
            if (process.argv.includes('--chart-only')) for (const width of [1440, 390]) await chartDetailRun(browser, engine, width);
            else if (process.argv.includes('--island-only')) for (const width of [1440, 390]) await islandMotionRun(browser, engine, width);
            else if (process.argv.includes('--cards-only')) {
                for (const width of [1440, 390]) await cardRun(browser, engine, width);
                await pageLifecycleRun(browser, engine);
            }
            else if (process.argv.includes('--directory-only')) await directoryRun(browser, engine);
            else {
                for (const width of widths) await layoutRun(browser, engine, width);
                if (!process.argv.includes('--layout-only')) {
                    for (const width of [1440, 390]) await chartDetailRun(browser, engine, width);
                    for (const width of [1440, 390, 320]) await relativeBarsRun(browser, engine, width);
                    for (const width of [1440, 390]) await cardRun(browser, engine, width);
                    await pageLifecycleRun(browser, engine);
                    for (const width of [1440, 390]) await islandMotionRun(browser, engine, width);
                    await hoverRun(browser, engine); await directoryRun(browser, engine); await interactions(browser, engine);
                }
            }
        } finally { await browser.close(); }
    }
    assert.deepEqual(report.errors, []);
    report.passed = true;
} catch (error) {
    report.failure = error.stack;
    throw error;
} finally {
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (buildRoot) {
        assert.equal(dirname(resolve(buildRoot)), resolve(tmpdir()));
        assert.ok(basename(buildRoot).startsWith('benchpoll-topics-build-'));
        await rm(buildRoot, { recursive: true, force: true });
    }
}
console.log(`Topics home acceptance report: ${join(output, 'report.json')}`);
