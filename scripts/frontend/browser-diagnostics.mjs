const navigationPhases = new Set(['open model', 'back to topics', 'guide navigation', 'context cleanup']);
const reads = new Set(['/api/get_topic_preview', '/api/get_weighted_workspace']);

export function partitionNavigationDiagnostics(events, failures) {
    const errors = [], diagnostics = [];
    for (const event of events) {
        let request;
        try {
            const address = event.stack?.match(/^Fetch API cannot load (https:\/\/\S+) due to access control checks\./)?.[1];
            const url = new URL(address);
            if (event.name === 'webkit' && Array.isArray(event.domEvents) && !event.domEvents.length
                && navigationPhases.has(event.phase) && reads.has(url.pathname)
                && url.origin === new URL(event.url).origin && Number.isFinite(event.receivedAt)) {
                request = failures.find(failure => failure.name === event.name && failure.width === event.width
                    && failure.phase === event.phase && failure.endpoint === url.pathname
                    && failure.failure === 'Load request cancelled' && Number.isFinite(failure.receivedAt)
                    && Math.abs(failure.receivedAt - event.receivedAt) <= 500);
            }
        } catch { /* Missing or unrelated evidence remains a test failure. */ }
        if (request) diagnostics.push({ ...event, reason: 'cancelled-read-during-navigation', cancellation: request });
        else errors.push(event);
    }
    return { errors, diagnostics };
}
