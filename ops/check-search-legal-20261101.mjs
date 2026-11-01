import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const candidate = process.argv[2];
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/search-legal-20261101\/search-legal-20261101-\d+\/candidate$/.test(candidate)) {
    throw new Error('Expected the prepared search/legal candidate');
}
const require = createRequire(candidate + '/package.json');
const mysql = require('mysql2/promise');
const pool = mysql.createPool({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'benchmarks',
    connectionLimit: 3, supportBigNumbers: true });
const db = {
    async getConnection() {
        const connection = await pool.getConnection();
        await connection.query('SET SESSION TRANSACTION READ ONLY');
        return connection;
    },
    async execute(sql, parameters) {
        const connection = await this.getConnection();
        try { return await connection.execute(sql, parameters); } finally { connection.release(); }
    }
};
const load = path => import(pathToFileURL(candidate + '/' + path));
try {
    const { listTopics } = await load('topic-service.js');
    const { createTopicHomeService } = await load('topic-home-service.js');
    const { createRankingReadCache } = await load('ranking-read-cache.js');
    const { createSearchPresentation, renderPublicTopic, discoverySitemap, discoveryText, renderTopicDirectory } = await load('search-presentation.js');
    const preview = createTopicHomeService({ db, rankingCache: createRankingReadCache() });
    const service = createSearchPresentation({ origin: 'https://benchpoll.com', loadTopics: () => listTopics(db, null),
        loadPreview: body => preview.preview(null, body), snapshotWaitMs: 30000 });
    const topics = await service.topics();
    assert.ok(topics.length > 20); assert.ok(topics.every(topic => topic.isPrivate === false));
    const featured = topics.find(topic => topic.ID === 54);
    assert.ok(featured?.hasWeights);
    const start = Date.now(), snapshot = await service.snapshot(featured, featured.scenes.find(scene => scene.isDefault));
    assert.ok(snapshot?.models.length, 'The real public ranking must be available');
    const html = await readFile(candidate + '/private/home-built.html', 'utf8');
    const page = renderPublicTopic(html, featured, featured.scenes.find(scene => scene.isDefault), snapshot, 'https://benchpoll.com');
    assert.match(page, /Measured coverage/); assert.match(page, /Evaluation items/);
    assert.ok(snapshot.models.every(model => model.coverage >= 0 && model.coverage <= 100));
    const xml = discoverySitemap(topics, 'https://benchpoll.com');
    const scenes = topics.reduce((sum, topic) => sum + topic.scenes.filter(scene => !scene.isDefault).length, 0);
    assert.equal([...xml.matchAll(/<url>/g)].length, topics.length + scenes + 6);
    assert.doesNotMatch(xml, /personal\//);
    assert.doesNotMatch(discoveryText(topics, 'https://benchpoll.com'), /\/personal\//);
    assert.ok(renderTopicDirectory(topics).includes(featured.name));
    const withScenes = topics.find(topic => topic.scenes.some(scene => !scene.isDefault));
    const scene = withScenes.scenes.find(scene => !scene.isDefault);
    const scenePage = renderPublicTopic(html, withScenes, scene, null, 'https://benchpoll.com');
    assert.ok(scenePage.includes(`href="https://benchpoll.com${withScenes.url}?scene=${scene.ID}"`));
    console.log(JSON.stringify({ passed: true, publicTopics: topics.length, nonDefaultScenes: scenes, sitemapURLs: topics.length + scenes + 6,
        snapshotModels: snapshot.models.length, snapshotWeights: snapshot.weights.length, previewMs: Date.now() - start,
        sceneURL: withScenes.url + '?scene=' + scene.ID, readOnlyDatabase: true }));
} finally { await pool.end(); }
