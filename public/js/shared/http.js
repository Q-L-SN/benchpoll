async function postJSON(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    let payload = null;
    if (response.status !== 204) {
        const contentType = response.headers.get('content-type') ?? '';
        payload = contentType.includes('application/json') ? await response.json() : null;
    }
    if (!response.ok) {
        const error = new Error(payload?.error || `Request failed with status ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }
    return payload;
}

export { postJSON };
