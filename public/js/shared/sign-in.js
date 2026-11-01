let signInPopup = null;
const installed = new WeakSet();

export function openSignIn(view = window) {
    const width = 480, height = 620;
    const left = (view.screenLeft ?? view.screenX ?? 0) + (view.innerWidth - width) / 2;
    const top = (view.screenTop ?? view.screenY ?? 0) + (view.innerHeight - height) / 2;
    try {
        signInPopup = view.open('/github_login', 'BenchPoll sign in',
            `width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`);
    } catch { signInPopup = null; }
    if (signInPopup) signInPopup.focus();
    else view.location.assign('/github_login');
}

export function installSignInLinks(root = document) {
    if (installed.has(root)) return;
    installed.add(root);
    root.addEventListener('click', event => {
        if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        const link = event.target.closest?.('a[href="/login"], a[href="/github_login"]');
        if (!link || link.hasAttribute('download') || link.target && link.target !== '_self') return;
        event.preventDefault();
        openSignIn(root.defaultView);
    });
}

export function listenAccountChange(callback, view = window) {
    let lastSignal;
    const receive = signal => {
        if (typeof signal !== 'string' && signal !== null || signal === lastSignal) return;
        let value;
        try { value = signal === null ? null : JSON.parse(signal); } catch { return; }
        if (value !== null && (!value || typeof value !== 'object' || typeof value.date !== 'string'
            || !Number.isFinite(Date.parse(value.date)))) return;
        lastSignal = signal;
        callback(value);
    };
    view.addEventListener('storage', event => { if (event.key === 'user-profile-update') receive(event.newValue); });
    view.addEventListener('message', event => {
        if (event.origin === view.location.origin && signInPopup && event.source === signInPopup
            && event.data?.type === 'benchpoll:sign-in-complete') receive(event.data.signal);
    });
}

export function completeSignIn(view = window) {
    const signal = JSON.stringify({ date: new Date().toISOString() });
    try { view.localStorage.setItem('user-profile-update', signal); } catch { /* Opener messaging also works without storage. */ }
    if (view.opener && !view.opener.closed) {
        try { view.opener.postMessage({ type: 'benchpoll:sign-in-complete', signal }, view.location.origin); }
        catch { /* The visible continuation link also works if the opener has navigated away. */ }
        view.close();
    } else view.location.replace('/');
}
