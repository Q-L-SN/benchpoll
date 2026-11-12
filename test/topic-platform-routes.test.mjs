import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createTopicPageHandler } from '../topic-routes.js';
import { platformFixture, makeTopic } from './helpers/topic-platform-fixture.mjs';

test('HTTP canonical routes redirect default scenes and published aliases, with strict private authorization', async t => {
    const scene = { context_ID: 801, scene_number: 1, name: 'General', slug: 'general', is_default: 1, is_active: 1 };
    const db = platformFixture([makeTopic(1, '1', true, { scenes: [scene] }), makeTopic(2)]);
    const app = express();
    app.get('/*path', createTopicPageHandler({ db, publicOrigin: 'http://benchpoll.invalid',
        activeSessionUserID: async req => req.get('x-fixture-user') ?? null,
        searchPresentation: { snapshot: async () => null },
        renderHome: async (res, options) => res.json({ categoryID: options.categoryID, guest: options.guest }) }));
    app.use((error, _req, res, _next) => res.status(error.status ?? 500).json(error.body ?? {}));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const read = (path, owner = null) => fetch(origin + path, { redirect: 'manual', headers: owner ? { 'x-fixture-user': owner } : {} });
    for (const path of ['/1', '/private/' + db.state().topics[0].private_ID]) {
        const response = await read(path); assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/1/1');
    }
    assert.equal((await read('/1/1')).status, 200);
    const privatePath = '/private/' + db.state().topics[1].private_ID;
    assert.equal((await read(privatePath)).status, 404);
    assert.equal((await read(privatePath, '2')).status, 404);
    const own = await read(privatePath, '1'); assert.equal(own.status, 200);
    assert.match(own.headers.get('x-robots-tag'), /noindex/);
    assert.equal((await read('/2', '1')).status, 404);
    for (const path of ['/coding', '/topics/1', '/personal/2', '/1/general', '/1/801', '/1?scene=801', '/1?context_scene=801', '/topic-proposals']) {
        assert.equal((await read(path, '1')).status, 404, path);
    }
    db.state().topics[0].owner_user_ID = '1';
    assert.equal((await read('/1/1', '1')).status, 404);
    assert.equal((await read('/private/' + db.state().topics[0].private_ID + '/1', '1')).status, 200);
});
