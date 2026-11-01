import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesDocumentTelemetry, observeDocumentTelemetry } from '../scripts/frontend/cloudflare-telemetry.mjs';

const url = 'https://example.test/privacy';
function response({ pathname = '/cdn-cgi/rum', resourceType = 'xhr', location = url, status = 204, finishedError = null } = {}) {
    return { url: () => `https://example.test${pathname}`, status: () => status, finished: async () => finishedError,
        request: () => ({ resourceType: () => resourceType, postDataJSON: () => ({ location }) }) };
}
test('telemetry matcher excludes another document, sendBeacon and unrelated requests', () => {
    assert.equal(matchesDocumentTelemetry(response(), url), true);
    for (const options of [{ pathname: '/api/get_user_profile' }, { resourceType: 'ping' }, { location: 'https://example.test/terms' }]) {
        assert.equal(matchesDocumentTelemetry(response(options), url), false);
    }
});
test('telemetry observer retains wait, response and completion failures rather than filtering errors', async () => {
    for (const result of [response({ status: 403 }), response({ finishedError: new Error('cancelled') }), new Error('response timeout')]) {
        const page = { waitForResponse: async () => { if (result instanceof Error) throw result; return result; } };
        const observed = await observeDocumentTelemetry(page, url, 100);
        assert.equal(observed.completed, false); assert.ok(observed.error);
    }
    assert.equal((await observeDocumentTelemetry({ waitForResponse: async () => response() }, url)).completed, true);
});
test('telemetry response completion cannot hang the settled smoke', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const item = response(); item.finished = () => new Promise(() => {});
    const pending = observeDocumentTelemetry({ waitForResponse: async () => item }, url, 50);
    await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(50);
    assert.equal((await pending).completed, false);
});
