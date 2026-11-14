import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FEATURED_TOPIC_ID, orderTopics, topicCollection, columnLayout, barGeometry } from '../public/js/topics-home/layout.js';
import { modelBarColor, modelBarTextColor } from '../public/js/workspace/score-colors.js';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('the actual root introduces the directory directly, without the retired presentation entry', async () => {
    const html = await read('private/index.html');
    assert.match(html, /<h1 id="home-title"><span class="th-headline-phrase">Define <span class="th-headline-nowrap">Super Intelligence,<\/span><\/span> <span class="th-headline-phrase th-headline-accent">democratically\.<\/span><\/h1>/);
    assert.match(await read('public/css/topics-home.css'), /\.th-headline-nowrap \{ white-space: nowrap; \}/);
    assert.match(html, /<title>BenchPoll - Define Super Intelligence, democratically<\/title>/);
    assert.match(html, /<p class="th-intro-copy">Choose what matters\. Shape the weights together\.<\/p>/);
    assert.doesNotMatch(html, /Create a topic\. Choose the benchmarks\./);
    assert.match(html, /src="\/assets\/benchpoll-logo\.svg"[^>]*width="330"/);
    assert.match(html, /id="topics-grid"/);
    assert.doesNotMatch(html, /<aside\b|showcase-trigger|showcase\.css|home-workspace\.js/);
    assert.doesNotMatch(await read('private/home.html'), /id="showcase-trigger"|bp-showcase-stage/);
});

test('Estimated score is the default and score and view modes use separate toggles', async () => {
    const html = await read('private/index.html');
    assert.match(html, /id="topics-score-toggle"[^>]*aria-pressed="false"[^>]*><i class="fa-solid fa-arrow-right-arrow-left"[^>]*><\/i><span>Estimated score<\/span>/);
    assert.match(html, /data-comparison="reasoning"[^>]*aria-pressed="false"[^>]*><i class="fa-solid fa-brain"/);
    assert.match(html, /data-comparison="harness"[^>]*aria-pressed="false"[^>]*><i class="fa-solid fa-puzzle-piece"/);
    assert.match(html, /id="topics-view-toggle"[^>]*aria-pressed="false"[^>]*><i class="fa-solid fa-arrow-right-arrow-left"/);
});

test('Intelligence is featured only in Popular while server popularity and recent ordering stay intact', async () => {
    assert.equal(FEATURED_TOPIC_ID, 1);
    const topics = [{ ID: 4, heat: 20 }, { ID: 9, heat: 500 }, { ID: 54, publicID: 1 }, { ID: 99, isNew: true }, { ID: 2, heat: 1000 }];
    const before = structuredClone(topics);
    const ordered = orderTopics(topics);
    assert.notEqual(ordered, topics);
    assert.deepEqual(ordered.map(topic => topic.ID), [4, 9, 54, 99, 2]);
    assert.deepEqual(topicCollection(topics, 'popular').map(topic => topic.ID), [4, 9, 54, 99, 2]);
    assert.deepEqual(topicCollection(topics, 'recent', [{ categoryID: 2 }, { categoryID: 54 }, { categoryID: 4 }]).map(topic => topic.ID), [2, 54, 4]);
    assert.deepEqual(topics, before);
    const source = await read('public/js/topics-home.js');
    for (const topic of ['topic', 'state.topic']) {
        const condition = `directoryView === 'popular' && Number(${topic}.ID) === featuredTopicID && ${topic}.sceneID == null`;
        assert.ok(source.includes(`classList.toggle('is-featured', ${condition})`));
    }
});

test('fixed-height directory cards leave room above the score bars for weights', async () => {
    const css = await read('public/css/topics-home.css');
    assert.match(css, /\.th-card\s*\{[^}]*height: 416px;[^}]*border-radius: 8px/);
    assert.match(css, /\.th-card\.is-featured\s*\{[^}]*grid-column: 1 \/ -1; height: 456px/);
    for (const height of [141, 181, 185]) {
        const bars = barGeometry({ lower: 100, upper: 100 }, { min: 0, max: 100 }, height);
        assert.equal(bars.known, height * .65);
        assert.ok(Math.abs(height - bars.upper - height * .35) < 1e-10);
    }
});

test('few models get thicker bounded bars without partial columns or overflowing their frame', () => {
    assert.ok(columnLayout(330, 3, 3).barWidth > columnLayout(330, 25, 37).barWidth);
    for (const width of [240, 330, 720, 960, 1280]) {
        const columns = columnLayout(width, 25, 37);
        assert.equal(columns.width, columns.visible * columns.slot);
        assert.ok(columns.width <= width);
        assert.ok(columns.barWidth >= 24 && columns.barWidth <= 44);
    }
});

test('vendor-color contrast calculations are retained and actual root scores use white inside/dark outside', async () => {
    for (const vendorSlug of ['openai', 'anthropic', 'google', 'meta', 'deepseek', 'mistral', 'alibaba', 'zhipu', 'xai', 'unknown']) {
        assert.equal(modelBarTextColor(modelBarColor({ vendorSlug })), '#ffffff', vendorSlug);
    }
    const css = await read('public/css/topics-home.css');
    assert.match(css, /\.th-model-score\s*\{[^}]*color: #fff/);
    assert.match(css, /\.th-model-score\.is-outside\s*\{[^}]*color: #28313e/);
    const source = await read('public/js/topics-home.js');
    assert.match(source, /rankingNumber\(model\.lower\)/);
    assert.match(source, /createOrganizationMark\(model, 'th-vendor-mark'\)/);
    assert.match(source, /renderComparisonName\(name, model, preview\.comparison, \{ fitParameters: false \}\)/);
});
