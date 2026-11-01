import { createRetryableWrite } from './write-intent.js?v=write-replay-20261008';
import { rankingReadBody } from './available-score.js?v=coverage-factor-20261019';

async function requestJSON(url, body, options = {}) {
    body = rankingReadBody(url, body);
    const response = await (globalThis.__benchpollInitialReads?.take(url, body, options) ?? fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...options.headers },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {})
    }));
    let payload = null;
    if (response.status !== 204) {
        const contentType = response.headers.get('content-type') ?? '';
        if (options.requireJSON && response.ok && !contentType.includes('application/json')) {
            throw new Error('The server response could not be confirmed. Your draft is kept; try again.');
        }
        payload = contentType.includes('application/json') ? await response.json() : null;
    }
    if (!response.ok) {
        const acceptanceRequired = payload?.error === 'legal_acceptance_required';
        if (acceptanceRequired && typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('benchpoll:legal-acceptance-required', {
                detail: { expectedUserID: body?.expectedUserID }
            }));
        }
        const error = new Error(acceptanceRequired
            ? 'Review and accept the updated terms in the notice, then try again. Your draft is kept.'
            : payload?.error || `Request failed with status ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }
    return payload;
}

async function postJSON(url, body, options = {}) {
    if (options.timeoutMs === undefined) return requestJSON(url, body, options);
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2147483647) {
        throw new TypeError('Invalid request timeout.');
    }
    const controller = new globalThis.AbortController();
    let timer, onAbort;
    const cancelled = new Promise((_, reject) => {
        const stop = error => { controller.abort(error); reject(error); };
        timer = setTimeout(() => stop(Object.assign(new Error('The request took too long. Please retry.'),
            { name: 'TimeoutError', code: 'request_timeout' })), options.timeoutMs);
        if (options.signal) {
            onAbort = () => stop(options.signal.reason ?? new globalThis.DOMException('The request was cancelled.', 'AbortError'));
            if (options.signal.aborted) onAbort();
            else options.signal.addEventListener('abort', onAbort, { once: true });
        }
    });
    try {
        // Include the body read, and settle even if a transport ignores the abort signal.
        return await Promise.race([cancelled, requestJSON(url, body, { ...options, signal: controller.signal })]);
    } finally {
        clearTimeout(timer);
        if (onAbort) options.signal.removeEventListener('abort', onAbort);
    }
}

const postWriteJSON = createRetryableWrite(postJSON);

export { postJSON, postWriteJSON };
