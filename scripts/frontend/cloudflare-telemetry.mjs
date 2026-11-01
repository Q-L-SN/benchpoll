import assert from 'node:assert/strict';

export function matchesDocumentTelemetry(response, documentURL) {
    if (new URL(response.url()).pathname !== '/cdn-cgi/rum' || response.request().resourceType() !== 'xhr') return false;
    try { return response.request().postDataJSON()?.location === documentURL; } catch { return false; }
}

export function observeDocumentTelemetry(page, documentURL, timeoutMs = 12000) {
    // Observe before navigating; do not remove any pageerror/HTTP failure assertions.
    return page.waitForResponse(response => matchesDocumentTelemetry(response, documentURL), { timeout: timeoutMs })
        .then(async response => {
            let timer;
            try {
                const failure = await Promise.race([response.finished(), new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Telemetry completion timed out')), timeoutMs);
                })]);
                assert.equal(response.status(), 204, 'Current document telemetry must return 204');
                assert.equal(failure, null, 'Current document telemetry must finish successfully');
                return { documentURL, status: response.status(), completed: true };
            } finally { clearTimeout(timer); }
        }).catch(error => ({ documentURL, completed: false, error: error.message }));
}
