import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionNavigationDiagnostics } from '../scripts/frontend/browser-diagnostics.mjs';

const event = { name: 'webkit', width: 1440, phase: 'open model', receivedAt: 1000,
    domEvents: [], url: 'https://benchpoll.com/',
    stack: 'Fetch API cannot load https://benchpoll.com/api/get_topic_preview due to access control checks.\n at fetch' };
const failure = { name: 'webkit', width: 1440, phase: 'open model', receivedAt: 996,
    endpoint: '/api/get_topic_preview', failure: 'Load request cancelled' };

test('only correlated, same-origin WebKit navigation cancellations become diagnostics', () => {
    const result = partitionNavigationDiagnostics([event], [failure]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.diagnostics[0].cancellation, failure);
    for (const changed of [{ name: 'chromium' }, { phase: 'initial home' }, { domEvents: null },
        { domEvents: [{ type: 'unhandledrejection' }] }, { receivedAt: undefined },
        { stack: event.stack.replace('benchpoll.com/api', 'other.example/api') }]) {
        assert.equal(partitionNavigationDiagnostics([{ ...event, ...changed }], [failure]).errors.length, 1);
    }
});

test('real access failures, missing evidence and unrelated cancellations remain failures', () => {
    for (const failures of [[], [{ ...failure, failure: 'Blocked by access control' }],
        [{ ...failure, receivedAt: 4000 }], [{ ...failure, endpoint: '/api/other' }],
        [{ ...failure, width: 390 }], [{ ...failure, phase: 'context cleanup' }]]) {
        assert.equal(partitionNavigationDiagnostics([event], failures).errors.length, 1);
    }
});
