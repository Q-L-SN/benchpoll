import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { FEATURED_TOPIC_ID, OTHER_THRESHOLD, MAX_BAR_RATIO, TREEMAP_FADE, HOME_WEIGHT_THEME,
    topicCollection, modelTargetURL, scoreLabelLayout, orderTopics,
    weightEntries, weightLayout, weightChainLength, modelLabelLayout, MODEL_IDENTITY_HEIGHT, WEIGHT_LABEL_METRICS, fitWeightLabel, columnLayout, modelColumnOpacity, modelBarScale, barGeometry, mergePreview } from '../public/js/topics-home/layout.js';
import { fixtureWeights } from '../scripts/frontend/topics-home-fixtures.mjs';
import { readHomeModelFocusIntent } from '../public/js/workspace/model-focus.js';

test('54 stays first, without regrouping other flat topics', () => {
    assert.equal(FEATURED_TOPIC_ID, 54);
    assert.deepEqual(orderTopics([{ ID: 8 }, { ID: '54' }, { ID: 1 }]).map(topic => topic.ID), ['54', 8, 1]);
    const serverOrder = [{ ID: 9, heat: 1 }, { ID: 2, heat: 50 }, { ID: 54 }, { ID: 99, isNew: true }, { ID: 1, heat: 200 }];
    assert.deepEqual(orderTopics(serverOrder).map(topic => topic.ID), [54, 9, 2, 99, 1], 'heat/exploration order belongs to the server');
});

test('Other uses a strict deterministic 1% threshold and retains every basis point/member', () => {
    assert.equal(OTHER_THRESHOLD, .01);
    const result = weightEntries(fixtureWeights);
    const other = result.entries.find(entry => entry.isOther);
    assert.equal(result.total, 10000);
    assert.equal(other.name, 'Other');
    assert.equal(other.weightBasisPoints, 200);
    assert.equal(other.members.length, 4);
    assert.equal(result.entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
    assert.deepEqual(weightEntries([...fixtureWeights].reverse()), result);
    const boundary = weightEntries([{ conditionID: 1, name: 'Large', weightBasisPoints: 9900 }, { conditionID: 2, name: 'Exactly 1%', weightBasisPoints: 100 }]);
    assert.equal(boundary.entries.some(entry => entry.isOther), false);
    assert.deepEqual(weightEntries([{ name: 'Zero', weightBasisPoints: 0 }, { name: 'Invalid', weightBasisPoints: NaN }]), { total: 0, entries: [] });
});

for (const [width, height] of [[240, 142], [330, 142], [390, 182], [1260, 182], [240, 218], [1260, 258]]) {
    test(`D3 sorted row groups preserve area, non-overlap and top order at ${width}x${height}`, () => {
        const tiles = weightLayout(fixtureWeights, width, height);
        assert.deepEqual(tiles, weightLayout(fixtureWeights, width, height));
        assert.equal(tiles[0].name, 'GPQA Diamond');
        assert.equal(tiles[0].y, 0);
        assert.equal(tiles[0].x, 0);
        assert.ok(tiles[0].height >= height * .25);
        assert.ok(Math.abs(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0) - width * height) < 1e-6);
        for (let index = 0; index < tiles.length; index++) {
            const tile = tiles[index];
            assert.ok(Math.abs(tile.width * tile.height / (width * height) - tile.share) < 1e-9, tile.name);
            assert.ok(tile.x >= -1e-7 && tile.y >= -1e-7 && tile.x + tile.width <= width + 1e-7 && tile.y + tile.height <= height + 1e-7);
            if (index) {
                assert.ok(tiles[index - 1].weightBasisPoints >= tile.weightBasisPoints);
            }
            for (const other of tiles.slice(index + 1)) {
                const overlapX = Math.min(tile.x + tile.width, other.x + other.width) - Math.max(tile.x, other.x);
                const overlapY = Math.min(tile.y + tile.height, other.y + other.height) - Math.max(tile.y, other.y);
                assert.ok(overlapX <= 1e-7 || overlapY <= 1e-7, `${tile.name} overlaps ${other.name}`);
            }
        }
    });
}

test('name and version lines center when fitting and retain full text for a left-aligned fade when too wide', () => {
    const base = { name: 'GPQA Diamond', conditionName: '2026', share: .284 };
    const measure = text => text.length * 6.5;
    assert.deepEqual(fitWeightLabel({ ...base, width: 180, height: 100 }, measure), { kind: 'full', height: 34, lines: [
        { text: 'GPQA Diamond', kind: 'name', overflow: false }, { text: '2026', kind: 'version', overflow: false }] });
    assert.deepEqual(fitWeightLabel({ ...base, width: 180, height: 40 }, measure).lines,
        [{ text: 'GPQA Diamond', kind: 'name', overflow: false }]);
    assert.deepEqual(fitWeightLabel({ ...base, width: 44, height: 30 }, measure).lines,
        [{ text: 'GPQA Diamond', kind: 'name', overflow: true }]);
    assert.equal(fitWeightLabel({ ...base, width: 15, height: 10 }, measure).kind, 'none');
    assert.deepEqual(fitWeightLabel({ name: 'Other', isOther: true, share: .02, width: 100, height: 28 }, measure).lines,
        [{ text: 'Other', kind: 'name', overflow: false }]);
    for (const width of [44, 70, 120, 350]) for (const height of [10, 26, 40, 100]) {
        const fit = fitWeightLabel({ ...base, width, height }, measure);
        for (const line of fit.lines) assert.equal(line.overflow, measure(line.text) > width - 16);
        assert.equal(fit.height, fit.lines.reduce((sum, line) => sum + WEIGHT_LABEL_METRICS[line.kind].lineHeight, 0));
        assert.ok(fit.height <= Math.max(0, height - 10));
    }
});

test('label overflow uses exact width boundaries, handles long tokens and fades the version independently', () => {
    const base = { name: 'Name', conditionName: 'A-very-long-unbroken-version', width: 48, height: 44 };
    const measure = text => text.length * 8;
    const fit = fitWeightLabel(base, measure);
    assert.deepEqual(fit.lines.map(line => line.overflow), [false, true]);
    assert.equal(fit.height, 34);
    assert.deepEqual(fitWeightLabel({ ...base, width: 47 }, measure).lines.map(line => line.overflow), [true, true]);
    assert.equal(fitWeightLabel({ ...base, height: 43 }, measure).lines.length, 1);
    assert.equal(fitWeightLabel({ ...base, conditionName: ' Default ' }, measure).lines.length, 1);
    assert.equal(fitWeightLabel({ ...base, name: ' ' }, measure).lines.length, 0);
});

test('scrolling columns fade continuously at both edges and remain whole and opaque at rest', () => {
    const geometry = { slot: 48, visible: 5 };
    for (let index = 0; index < 5; index++) assert.equal(modelColumnOpacity(index, 0, geometry), 1);
    assert.equal(modelColumnOpacity(5, 0, geometry), 0);
    assert.equal(modelColumnOpacity(0, -5, geometry), 1, 'native start overscroll must not dim a whole column');
    const outgoing = [], incoming = [];
    for (let offset = 0; offset <= 48; offset += .25) {
        outgoing.push(modelColumnOpacity(0, offset, geometry));
        incoming.push(modelColumnOpacity(5, offset, geometry));
    }
    assert.equal(outgoing.at(-1), 0); assert.equal(incoming.at(-1), 1);
    assert.equal(modelColumnOpacity(0, 24, geometry), .5);
    for (let index = 1; index < outgoing.length; index++) {
        assert.ok(outgoing[index] <= outgoing[index - 1]);
        assert.ok(incoming[index] >= incoming[index - 1]);
        assert.ok(Math.abs(outgoing[index] - outgoing[index - 1]) < .008, 'edge must not pop at a column boundary');
        assert.ok(Math.abs(incoming[index] + outgoing[index] - 1) < 1e-9);
    }
    for (let index = 1; index <= 5; index++) assert.equal(modelColumnOpacity(index, 48, geometry), 1);
    assert.equal(modelColumnOpacity(0, 0, { slot: 0, visible: 0 }), 0);
});

test('priority layouts keep an uninterrupted exposed prefix and parallel upper blocks', () => {
    const entries = weightEntries(fixtureWeights).entries;
    for (const [width, height, columns] of [[240, 218, 2], [330, 218, 2], [390, 258, 2],
        [720, 160, 4], [1000, 180, 5], [1280, 180, 6], [1320, 180, 7], [1800, 260, 8]]) {
        const tiles = weightLayout(fixtureWeights, width, height);
        const top = tiles.filter(tile => tile.y === 0).sort((a, b) => a.x - b.x);
        assert.ok(top.length >= 2, `${width}: top blocks should use horizontal space`);
        assert.ok(weightChainLength(tiles, height) >= Math.min(columns, 7), `${width}: priority chain regressed`);
        assert.deepEqual(tiles.map(tile => tile.key), entries.map(entry => entry.key));
        assert.equal(tiles[0].x, 0); assert.equal(tiles[0].y, 0);
        assert.equal(top[1].name, 'SWE-bench Verified');
        assert.equal(top[1].weightBasisPoints, 2100, 'second-largest weight must remain exposed at the top');
        assert.deepEqual(weightLayout([...fixtureWeights].reverse(), width, height), tiles);
    }
});

test('the exposed band retains a complete name and optional version with independent overflow states', () => {
    const tile = { name: 'SWE-bench Verified', conditionName: 'Agent v2', share: .21, width: 120, height: 200 };
    const measure = text => text.length * 6.5;
    const exposed = fitWeightLabel({ ...tile, height: 53 }, measure);
    assert.deepEqual(exposed.lines.map(line => line.text), ['SWE-bench Verified', 'Agent v2']);
    assert.deepEqual(exposed.lines.map(line => line.overflow), [true, false]);
    assert.ok(fitWeightLabel(tile, measure).lines.some(line => line.kind === 'version'));
});

test('the fixed treemap combines Frost colors with Hatch texture', () => {
    assert.equal(HOME_WEIGHT_THEME.id, 'frost-hatch');
    assert.equal(HOME_WEIGHT_THEME.texture, 'hatch');
    assert.deepEqual(HOME_WEIGHT_THEME.colors, ['#e4eaf1', '#cbd5e2', '#eef1f5', '#d5dfe6', '#e2e4eb', '#cbdcde', '#d8e0ee', '#edf0f4']);
});

test('whole-column frames are centered-capable, bounded and use thicker slots for fewer models', () => {
    for (const width of [240, 292, 330, 480, 760, 1260]) for (const count of [1, 3, 8, 25, 100]) {
        const geometry = columnLayout(width, count, count);
        assert.ok(geometry.slot >= 48 && geometry.slot <= 96);
        assert.ok(geometry.width <= width);
        assert.equal(geometry.width / geometry.slot, geometry.visible);
        assert.ok(geometry.visible <= count);
        assert.ok(geometry.barWidth >= 28 && geometry.barWidth <= 36);
    }
    assert.ok(columnLayout(330, 3).barWidth > columnLayout(330, 37).barWidth);
    for (const width of [258, 330, 380, 1260]) {
        assert.ok(columnLayout(width, 25, 100).visible > Math.floor(width / 78), `${width}: expected more whole columns`);
        assert.ok(columnLayout(width, 25, 100).barWidth <= 36, `${width}: bounded thicker bars`);
    }
    assert.ok(columnLayout(17, 25, 100).width <= 17, 'an unusually narrow frame must still be bounded');
});

test('normal home columns show more complete models at phone, card and wide chart widths', () => {
    for (const [width, visible] of [[258, 5], [320, 6], [400, 8], [1320, 27]]) {
        const columns = columnLayout(width, 100, 100);
        assert.equal(columns.visible, visible);
        assert.ok(columns.visible > Math.floor(width / 60), 'density must improve over the previous 60px spacing');
        assert.ok(columns.slot >= 48, 'keep a usable full-column touch target');
        assert.ok(columns.width <= width);
        assert.ok(width - columns.width < columns.visible);
        assert.ok(columns.barWidth >= 28 && columns.barWidth <= 36);
        assert.equal(scoreLabelLayout(23, columns.barWidth, 120).outside, false, '100 must still fit inside a tall dense bar');
    }
    assert.equal(columnLayout(240, 3, 3).visible, 3, 'few models should use the available space before paging');
    assert.equal(columnLayout(1320, 25, 100).visible, 25, 'never create unloaded blank columns');
});

test('diagonal model identities keep short names unbroken and bound longer names', async () => {
    const css = await readFile(new URL('../public/css/topics-home.css', import.meta.url), 'utf8');
    assert.match(css, /transform-origin: top left/);
    assert.match(css, /\[data-lines="1"\]\s*\{ white-space: nowrap;/);
    assert.match(css, /\.th-label-word\s*\{ white-space: nowrap;/);
    assert.doesNotMatch(css.match(/\.th-model-name[\s\S]*?\.th-visual\[data-view="weights"\]/)[0], /overflow-wrap: anywhere/);
    for (const text of ['GPT-5', 'a'.repeat(14), 'a'.repeat(40), 'Claude Opus Thinking Extra Long']) {
        const layout = modelLabelLayout([{ kind: 'model', text }]);
        assert.equal(layout.rows[0].lines, text.length * 6 > 88 && text.includes(' ') ? 2 : 1);
        assert.ok(layout.projectedHeight + 38 <= MODEL_IDENTITY_HEIGHT.normal);
        const angle = 66 * Math.PI / 180;
        assert.ok(Math.abs(layout.anchorX - layout.width * Math.cos(angle) - layout.height / 2 * Math.sin(angle)) < 1e-9);
    }
    const compared = modelLabelLayout([{ kind: 'model', text: 'a'.repeat(40) },
        { kind: 'parameter', text: 'a'.repeat(100) }, { kind: 'parameter', text: 'a'.repeat(100) }]);
    assert.ok(compared.projectedHeight + 38 <= MODEL_IDENTITY_HEIGHT.compared);
    for (const width of [240, 324, 400, 1320]) {
        const columns = columnLayout(width, 100, 100, 0, 32);
        assert.ok(columns.frameWidth <= width);
        assert.equal(columns.frameWidth, columns.width + columns.inset * 2);
        assert.equal(columns.visible, Math.floor((width - 64) / 48));
    }
});

test('measured parameter slots reduce whole-column count, capped by available width without changing default density', () => {
    for (const width of [258, 330, 760, 1260]) {
        const defaults = columnLayout(width, 25, 37);
        assert.deepEqual(columnLayout(width, 25, 37, 0), defaults);
        const fields = columnLayout(width, 25, 37, 280);
        assert.ok(fields.slot > 112 && fields.slot <= width);
        assert.ok(fields.visible < defaults.visible);
        assert.equal(fields.slot, Math.min(width, 280));
        assert.equal(fields.width, fields.slot * fields.visible);
        assert.ok(fields.width <= width);
        assert.ok(fields.barWidth <= 52, 'readable identities must not create oversized bars');
    }
    assert.equal(columnLayout(258, 25, 37, 280).visible, 1, 'narrow fields view should use one centered whole column');
    assert.deepEqual(columnLayout(330, 25, 37, Infinity), columnLayout(330, 25, 37));
    assert.deepEqual(columnLayout(330, 25, 37, -1), columnLayout(330, 25, 37));
});

test('both range and known bar endpoints stay below 65%, sharing a finite baseline', () => {
    assert.equal(MAX_BAR_RATIO, .65);
    for (const height of [142, 182]) for (const score of [-10, 0, 3, 50, 100, 120]) {
        const geometry = barGeometry({ lower: score, upper: score + 25 }, { min: 0, max: 100 }, height);
        assert.ok(geometry.known >= 0 && geometry.known <= height * .65);
        assert.ok(geometry.upper >= geometry.known && geometry.upper <= height * .65);
    }
    assert.equal(barGeometry({ lower: 20, upper: 50, comparable: false }, null, 100).upper, 0);
    assert.ok(Number.isFinite(barGeometry({ lower: 20, upper: 50 }, { min: NaN, max: NaN }, 100).known));
});

test('pagination preserves absent metadata, deduplicates models and keeps model order', () => {
    const previous = { topicID: 54, weights: fixtureWeights, contextValues: { budget: 'standard' },
        comparison: { keys: ['model'] }, scoreScale: { min: 0, max: 100 },
        models: [{ modelID: 1, name: 'One' }, { modelID: 2, name: 'Two' }], pagination: { snapshotID: 'a', nextOffset: 2 } };
    const merged = mergePreview(previous, { topicID: 54, models: [{ modelID: 2, name: 'Two updated' }, { modelID: 3, name: 'Three' }],
        pagination: { snapshotID: 'a', nextOffset: 3, hasMore: false } }, true);
    for (const key of ['weights', 'comparison', 'contextValues', 'scoreScale']) assert.equal(merged[key], previous[key]);
    assert.deepEqual(merged.models.map(model => model.name), ['One', 'Two updated', 'Three']);
    assert.throws(() => mergePreview(previous, { topicID: 1, models: [] }, true));
    assert.throws(() => mergePreview(previous, {}, true));
});

test('available bars use the leader as 100% of the 65% chart envelope, without changing scores', () => {
    for (const leader of [71, 40, .001, Number.MIN_VALUE, Number.MAX_VALUE]) {
        const models = [leader, leader / 2, 0].map((lower, index) => ({ modelID: index + 1, lower, upper: lower }));
        const preview = { models, scoreScale: { min: -10, max: 200 } };
        const original = structuredClone(models);
        const scale = modelBarScale(preview, 'available');
        assert.deepEqual(scale, { min: 0, max: leader });
        assert.equal(barGeometry(models[0], scale, 200).known, 130);
        if (leader / 2 > 0) assert.equal(barGeometry(models[1], scale, 200).known, 65);
        assert.equal(barGeometry(models[2], scale, 200).known, 0);
        assert.deepEqual(models, original, 'display scaling must not change actual model scores');
        assert.equal(modelBarScale(preview, 'range'), preview.scoreScale, 'range keeps its absolute scale');
    }
    const model = { lower: 71, upper: 85 };
    assert.deepEqual(barGeometry(model, modelBarScale({ models: [model], scoreScale: { min: 0, max: 100 } }, 'range'), 200),
        { known: 92.3, upper: 110.5, comparable: true });
});

test('relative bar scaling handles absent, invalid, zero and nonpositive leaders without inventing scores', () => {
    const unavailable = [{ lower: 99, upper: 99, comparable: false }, { lower: NaN, upper: 90 }, { lower: 80, upper: Infinity }];
    for (const models of [[], unavailable, [{ lower: 0, upper: 0 }], [{ lower: -10, upper: -10 }]]) {
        const scale = modelBarScale({ models }, 'available');
        assert.deepEqual(scale, { min: 0, max: 1 });
        for (const model of models) assert.equal(barGeometry(model, scale, 200).known, 0);
    }
    const models = [...unavailable, { lower: 40, upper: 40 }];
    assert.equal(barGeometry(models.at(-1), modelBarScale({ models }, 'available'), 200).known, 130);
});

test('relative bar scaling stays anchored to the ranking leader across paging and resets with a fresh snapshot', () => {
    const previous = { topicID: 54, models: [{ modelID: 1, lower: 40, upper: 40 }], scoreScale: { min: 0, max: 100 } };
    const merged = mergePreview(previous, { topicID: 54, models: [{ modelID: 2, lower: 20, upper: 20 }] }, true);
    assert.deepEqual(modelBarScale(merged, 'available'), modelBarScale(previous, 'available'));
    assert.equal(barGeometry(merged.models[1], modelBarScale(merged, 'available'), 200).known, 65);
    const fresh = mergePreview(merged, { topicID: 54, models: [{ modelID: 2, lower: 20, upper: 20 }] });
    assert.equal(barGeometry(fresh.models[0], modelBarScale(fresh, 'available'), 200).known, 130);
});

test('selectable tile theme, top exposure/fade and full unmasked weights are explicit', async () => {
    const css = await readFile(new URL('../public/css/topics-home.css', import.meta.url), 'utf8');
    assert.deepEqual(TREEMAP_FADE, { start: .32, end: .76 });
    assert.match(css, /#000 32%, transparent 76%/);
    assert.match(css, /\[data-view="weights"\] \.th-treemap[^}]*mask-image: none/s);
    assert.match(css, /\.th-tile-label > span[^}]*color: var\(--th-tile-ink/s);
    assert.match(css, /\.th-tile-label > span[^}]*font-size: 14px;[^}]*text-align: center/s);
    assert.match(css, /\.th-tile-version[^}]*font-size: 12px;[^}]*line-height: 16px/s);
    assert.match(css, /\[data-overflow="true"\][^}]*text-align: left;[^}]*mask-image: linear-gradient\(to right/s);
    assert.doesNotMatch(css, /border-(?:left|right|top):[^;]*(?:accent|fill|purple)/);
    const html = await readFile(new URL('../private/index.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /sidebar|home-workspace\.js|src="\/js\/home\.js/);
    assert.match(html, /<span class="th-headline-phrase">Define Super Intelligence,<\/span> <span class="th-headline-phrase th-headline-accent">democratically\.<\/span>/);
    assert.match(html, /<p class="th-intro-copy">Choose what matters\. Shape the weights together\.<\/p>/);
    assert.match(html, /<meta name="description" content="Define Super Intelligence, democratically\. Compare AI models with community-weighted benchmarks, explore public rankings, and build your own AI index\.">/);
    assert.match(html, /<script src="\/js\/topics-home\.js" type="module"><\/script>/);
    assert.match(html, /id="new-topic-name"[^>]*maxlength="128"/);
    assert.match(html, /id="new-topic-description"[^>]*required maxlength="180"/);
    assert.doesNotMatch(html, /th-eyebrow|th-intro-actions|data-open-mine|Explore topics|Our weights\./);
});

test('the integrated header has four collections, Mine private creation and a proposal link', async () => {
    const html = await readFile(new URL('../private/index.html', import.meta.url), 'utf8');
    const source = await readFile(new URL('../public/js/topics-home.js', import.meta.url), 'utf8');
    const shared = await readFile(new URL('../public/js/shared/site-header.js', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /id="topic-count"|id="topics-title"|th-collection-heading|<h2[^>]*>Topics/);
    assert.doesNotMatch(source, /\$\('#topic-count'\)/);
    assert.match(html, /class="th-header-inner th-container"/);
    assert.deepEqual([...html.matchAll(/data-topics-view="([^"]+)"/g)].map(match => match[1]), ['popular', 'recent', 'configured', 'search']);
    assert.match(html, /id="topic-search-toggle"[^>]*aria-expanded="false"/);
    assert.match(shared, /<a id="new-topic" class="th-quiet"[^>]*href="\/topic-proposals"/);
    assert.match(shared, /aria-label="Proposal hall"/);
    assert.match(html, /id="mine-actions"[^>]*hidden><button id="new-private-topic"/);
    assert.match(source, /\$\('#mine-actions'\)\.hidden = next !== 'configured'/);
    assert.match(html, /<button id="new-private-topic"[^>]*aria-label="New private topic"/);
    assert.doesNotMatch(source, /\$\('#new-topic'\)\.addEventListener/);
    assert.match(source, /createPrivateTopicEditor/);
    assert.doesNotMatch(source, /th-pagination-status|th-card-meta|benchmarks \/|\$\{total\} model/);
    assert.ok(html.indexOf('class="th-brand"') < html.indexOf('<main'));
});

test('the frosted header appears after the introductory header scrolls away', async () => {
    const html = await readFile(new URL('../private/index.html', import.meta.url), 'utf8');
    const css = await readFile(new URL('../public/css/topics-home.css', import.meta.url), 'utf8');
    const source = await readFile(new URL('../public/js/topics-home.js', import.meta.url), 'utf8');
    assert.match(html, /id="topics-filters" class="th-filter-bar"[^>]*hidden/);
    const header = html.match(/<header class="th-header">[\s\S]*?<\/header>/)?.[0];
    assert.match(header, /id="topics-navigation"[\s\S]*class="th-header-links"/);
    assert.ok(html.indexOf('id="topics-filters"') > html.indexOf('</header>'));
    assert.doesNotMatch(html, /th-island|th-directory-dock/);
    assert.match(css, /\.th-header \{[^}]*position: relative;/);
    assert.match(css, /\.is-scrolled \.th-header \{[^}]*position: fixed;/);
    assert.match(css, /\.th-home:not\(\.is-scrolled\) \.th-directory-nav \{ display: none; \}/);
    assert.match(css, /backdrop-filter: blur\(20px\)/);
    assert.doesNotMatch(css.match(/\.th-card \{[^}]+\}/)?.[0], /(?:row-)?gap:/);
    assert.match(source, /filterBar\.hidden = !visible/);
    assert.match(source, /setHeaderVisible\(passed\)/);
    assert.match(source, /Promise\.all\(headerMotion\.map\(animation => animation\.finished\)\)\.then\(finish/);
    assert.match(source, /headerResize\.observe\(header\)/);
    assert.match(source, /filterBar\.contains\(active\)/);
});

test('collections intersect authorized metadata, account flags and account-scoped recent IDs', () => {
    const topics = [{ ID: 4, isMine: false, configured: true }, { ID: 54, isMine: true, configured: false },
        { ID: 8, isMine: true, isPrivate: true, configured: false }, { ID: 9, isPrivate: true, isMine: false }, { ID: 5, isMine: true }];
    const recent = [{ categoryID: 5 }, { categoryID: 8 }, { categoryID: 4 }, { categoryID: 4 }, { categoryID: 9 }, { categoryID: 777 }];
    assert.deepEqual(topicCollection(topics, 'popular', recent, '42').map(topic => topic.ID), [54, 4, 8, 5]);
    assert.deepEqual(topicCollection(topics, 'mine', recent, '42').map(topic => topic.ID), [4, 8]);
    assert.deepEqual(topicCollection(topics, 'configured', recent, '42').map(topic => topic.ID), [4, 8]);
    assert.deepEqual(topicCollection(topics, 'recent', recent, '42').map(topic => topic.ID), [5, 8, 4]);
    assert.deepEqual(topicCollection(topics, 'recent', recent, null).map(topic => topic.ID), [5, 4]);
    assert.deepEqual(topicCollection(topics, 'mine', recent, null), []);
    assert.deepEqual(topicCollection(topics, 'configured', recent, null), []);
    assert.deepEqual(topicCollection(topics, 'search', recent, null).map(topic => topic.ID), [54, 4, 5]);
});

test('model links preserve canonical slug/query/hash and carry the exact ranking focus contract', () => {
    const identity = JSON.stringify([['model', true, 12], ['field:2', true, 'A & B / test']]);
    const href = modelTargetURL('/server-canonical?source=home&mode=personal#results', { modelID: 12, comparisonIdentity: identity },
        { scoreMode: 'range', reasoning: true, harness: false });
    const url = new URL(href, 'https://fixture.local');
    assert.equal(url.pathname, '/server-canonical'); assert.equal(url.hash, '#results');
    assert.deepEqual(Object.fromEntries(url.searchParams), { source: 'home', mode: 'public', focusModel: identity,
        scoreMode: 'range', compareReasoning: '1', compareHarness: '0' });
    const fallback = new URL(modelTargetURL('/personal/8', { modelID: '34' }, { scoreMode: 'available', reasoning: false, harness: true }, true), url);
    assert.equal(fallback.searchParams.get('focusModel'), '34'); assert.equal(fallback.searchParams.get('compareHarness'), '1');
    assert.equal(fallback.searchParams.get('mode'), 'personal');
    assert.deepEqual(readHomeModelFocusIntent(fallback.href), { valid: true, targetModel: '34', scoreMode: 'available', mode: 'personal',
        comparison: { reasoning: false, harness: true }, keys: ['model'] });
    assert.equal(modelTargetURL('/topic', {}, {}), null);
    assert.equal(modelTargetURL('/topic', { modelID: Number.MAX_SAFE_INTEGER + 1 }, {}), null);
});

test('normal low score labels fit inside actual bars; only physical impossibility moves them outside', () => {
    for (const score of [16, 14, 11]) {
        const bar = barGeometry({ lower: score, upper: score }, { min: 0, max: 100 }, 190);
        const fit = scoreLabelLayout(15, 32, bar.known);
        assert.equal(fit.outside, false, `score ${score} was rejected by an arbitrary threshold`);
        assert.ok(fit.fontSize >= 9 && fit.fontSize <= 12);
        assert.ok(fit.lineHeight <= bar.known - 2 + 1e-6);
    }
    for (const height of [0, 3, 8, 12]) assert.equal(scoreLabelLayout(15, 32, height).outside, true);
    assert.equal(scoreLabelLayout(80, 20, 100).outside, true);
    assert.equal(scoreLabelLayout(12, 32, 100, false).outside, true);
});

test('fixed Frost colors keep readable black benchmark labels', () => {
    for (const theme of [HOME_WEIGHT_THEME]) {
        assert.equal(theme.ink, '#111111');
        assert.ok(theme.colors.length >= 6);
        const luminance = color => {
            const channels = color.slice(1).match(/../g).map(channel => {
                const value = parseInt(channel, 16) / 255;
                return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
            });
            return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
        };
        for (const color of theme.colors) {
            const values = [luminance(color), luminance(theme.ink)].sort((a, b) => b - a);
            assert.ok((values[0] + .05) / (values[1] + .05) >= 4.5, `${theme.id} ${color}`);
        }
    }
});

test('percentage symbols are smaller and numbers may crop within their tile rather than shrinking too far', async () => {
    const css = await readFile(new URL('../public/css/topics-home.css', import.meta.url), 'utf8');
    const source = await readFile(new URL('../public/js/topics-home.js', import.meta.url), 'utf8');
    assert.match(css, /\.th-tile-share-symbol \{ font-size: \.5em; \}/);
    assert.match(css, /\.th-tile \{[^}]*overflow: hidden/);
    assert.match(css, /\.th-tile-label \.th-tile-share \{[^}]*overflow: visible/);
    assert.match(source, /Math\.max\(32, Math\.min\(tile\.width \* \.72/);
});

test('Outline remains fixed and pagination belongs to the plot', async () => {
    const source = await readFile(new URL('../public/js/topics-home.js', import.meta.url), 'utf8');
    assert.match(source, /frame\.append\(state\.pagination\)/);
    assert.match(source, /card\.append\(heading, visual, meta, referenceNotice, sceneToggle\)/);
    assert.match(source, /createTopicCreator\(topic\.creator, 'th-creator'\)/);
    const identity = await readFile(new URL('../public/js/shared/topic-identity.js', import.meta.url), 'utf8');
    assert.match(identity, /bp-topic-byline-prefix', 'by'/);
    assert.doesNotMatch(source, /th-card-footer/);
    const html = await readFile(new URL('../private/index.html', import.meta.url), 'utf8');
    assert.match(html, /class="th-header-inner th-container"/);
    assert.match(html, /data-weight-theme="frost-hatch" data-card-style="outline"/);
    assert.doesNotMatch(html, /treemap-theme-picker|card-style-picker/);
    assert.doesNotMatch(source, /appearancePicker|applyWeightTheme|applyCardStyle|benchpoll-topics-home-theme|benchpoll-topic-card-style/);
    assert.doesNotMatch(html, /Created by me|Configured by me|fa-pen-to-square|id="topics-mine"/);
    assert.match(html, /aria-label="Mine"[^>]*>[\s\S]*?fa-user/);
});

test('home integrates the shared account center and handles canonical-name errors without touching shared modules', async () => {
    const source = await readFile(new URL('../public/js/topics-home.js', import.meta.url), 'utf8');
    assert.match(source, /import\('\.\/shared\/account-center\.js'\)/);
    assert.match(source, /openAccountCenter\(\{ profile, onProfileSaved:/);
    assert.match(source, /onSignedOut: accountSignedOut/);
    const editor = await readFile(new URL('../public/js/shared/private-topic-editor.js', import.meta.url), 'utf8');
    assert.match(editor, /reserved_topic_name/); assert.match(editor, /topic_name_exists/);
    assert.match(source, /readRecentTopics\(profile\?\.userID \?\? null\)/);
    assert.doesNotMatch(source, /openProfileEditor|bar\.known < 25/);
    const html = await readFile(new URL('../private/index.html', import.meta.url), 'utf8');
    assert.match(html, /href="\/css\/ui\/account-center\.css" data-bp-account-center/);
});

test('the official D3 distribution remains executable in an esbuild browser ESM bundle', async () => {
    const result = await build({ entryPoints: [fileURLToPath(new URL('../public/js/topics-home/layout.js', import.meta.url))],
        bundle: true, format: 'esm', platform: 'browser', minify: true, write: false });
    const previous = globalThis.d3;
    try {
        delete globalThis.d3;
        const bundled = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
        assert.equal(bundled.weightLayout([{ conditionID: 1, name: 'Benchmark', weightBasisPoints: 100 }], 100, 100)[0].width, 100);
    } finally { globalThis.d3 = previous; }
});

test('root weights naming is distinct from retired Public composition and policies remain reachable', async () => {
    const html = await readFile(new URL('../private/index.html', import.meta.url), 'utf8');
    const shared = await readFile(new URL('../public/js/shared/site-header.js', import.meta.url), 'utf8');
    assert.match(html, /aria-label="Switch to benchmark weights" aria-pressed="false" data-tooltip="Switch to benchmark weights"/);
    assert.doesNotMatch(html, /Composition only|Public composition/);
    for (const [url, label] of [['/terms', 'Terms'], ['/privacy', 'Privacy'], ['/cookies', 'Cookies'], ['/community-guidelines', 'Community guidelines']]) {
        assert.ok(shared.includes(`href="${url}">${label}</a>`));
    }
});

test('home input focus uses complete surfaces and does not suppress action-button focus', async () => {
    const css = await readFile(new URL('../public/css/topics-home.css', import.meta.url), 'utf8');
    assert.match(css, /body\.th-home :is\(input, textarea, select\):is\(:focus, :focus-visible\)\s*\{[^}]*outline: none; box-shadow: none/s);
    assert.match(css, /\.th-search:focus-within\s*\{[^}]*background:/s);
    assert.match(css, /\.th-search input\s*\{[^}]*border: 0; background: transparent;/s);
    assert.match(css, /\.th-search input::-webkit-search-cancel-button[^}]*display: none;/s);
    assert.match(css, /\.th-search:focus-within\s*\{[^}]*outline: none; box-shadow: none/s);
    assert.match(css, /\.th-field input:focus, \.th-field textarea:focus\s*\{[^}]*border-color:[^}]*background:/s);
    assert.doesNotMatch(css, /button[^{}]*:focus[^{}]*\{[^}]*outline:\s*(?:0|none)/s);
});

test('diagonal parameters use fixed readable type and bounded long-value rows', async () => {
    const css = await readFile(new URL('../public/css/topics-home.css', import.meta.url), 'utf8');
    const rule = css.match(/\.th-model-name \.bp-model-display-parameter > span\s*\{([^}]+)\}/)?.[1];
    assert.match(rule, /font-size: 11px/);
    assert.match(rule, /-webkit-line-clamp: var\(--th-label-lines, 1\)/);
    assert.doesNotMatch(rule, /font-size: min|--bp-parameter-font-size/);
});

test('inside scores center on their colored bar; short/outside labels retain independent positioning', async () => {
    const css = await readFile(new URL('../public/css/topics-home.css', import.meta.url), 'utf8');
    assert.match(css, /\.th-model-score\s*\{[^}]*top: 50%;[^}]*width: 100%;[^}]*transform: translateY\(-50%\)/s);
    assert.match(css, /\.th-model-score\.is-outside\s*\{[^}]*top: auto;[^}]*transform: none;[^}]*color: #28313e/s);
});

test('model hover changes only the plot background, not the bar or identity', async () => {
    const css = await readFile(new URL('../public/css/topics-home.css', import.meta.url), 'utf8');
    assert.match(css, /@media \(hover: hover\)[\s\S]*\.th-model:hover \.th-model-plot\s*\{ background: #26313d0d; \}/);
    assert.doesNotMatch(css, /\.th-model:hover \.th-(?:model-bar|model-range|model-identity|vendor-mark|model-name)/);
});

test('range is one complete neutral upper column behind the unchanged vendor-color known column', async () => {
    const css = await readFile(new URL('../public/css/topics-home.css', import.meta.url), 'utf8');
    const source = await readFile(new URL('../public/js/topics-home.js', import.meta.url), 'utf8');
    assert.match(css, /\.th-model-range\s*\{[^}]*bottom: 0;[^}]*background: #929eac;/s);
    assert.doesNotMatch(css.match(/\.th-model-range\s*\{([^}]+)\}/)?.[1], /vendor-color|opacity/);
    assert.match(css, /\.th-model-bar\s*\{[^}]*bottom: 0;[^}]*background: var\(--th-vendor-color\)/s);
    assert.ok(source.indexOf('plot.append(range)') < source.indexOf('plot.append(known)'));
    assert.match(source, /height:\$\{bar\.upper\}px/);
});
