import { postJSON } from './http.js';
import { canonicalAccountID, pageAccountWriteScope, createAccountWriteScope, accountWriteError, isAccountWriteError } from './account-identity.js';

const OPTIONS = Object.freeze({ requireJSON: true, timeoutMs: 15000 });
const installed = new WeakMap();
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function legalAcceptanceStatus(value) {
    if (!value || typeof value.authenticated !== 'boolean' || typeof value.accepted !== 'boolean'
        || typeof value.csrfToken !== 'string' || !value.csrfToken.trim()
        || !['terms', 'privacy'].every(key => typeof value.versions?.[key] === 'string' && versionPattern.test(value.versions[key]))
        || (value.authenticated ? typeof value.userID !== 'string' || canonicalAccountID(value.userID) !== value.userID
            : value.userID !== null || value.accepted)) throw new Error('Invalid legal status.');
    return { authenticated: value.authenticated, accepted: value.accepted, userID: value.userID,
        csrfToken: value.csrfToken, versions: { terms: value.versions.terms, privacy: value.versions.privacy } };
}

export function legalAcceptancePayload(status) {
    const current = legalAcceptanceStatus(status);
    if (!current.authenticated) throw new Error('Sign-in is required to accept updates.');
    return { csrfToken: current.csrfToken, termsVersion: current.versions.terms,
        privacyVersion: current.versions.privacy, acceptedTerms: true, eligibleAge: true };
}

export function createLegalAcceptanceUI({ root = document, request = postJSON, scope = pageAccountWriteScope } = {}) {
    const view = root.defaultView;
    let dialog, title, documents, notice, message, accept, refresh, close, signIn;
    let status = null, phase = 'idle', loading = null, controller = null, generation = 0;
    let requested = false, pending = false, writeScope = null;

    function ensureDialog() {
        if (dialog) return;
        if (!root.querySelector('link[data-legal-acceptance-style]')) {
            const style = root.createElement('link');
            style.rel = 'stylesheet';
            style.href = '/css/ui/legal-acceptance.css';
            style.dataset.legalAcceptanceStyle = '';
            root.head.append(style);
        }
        const element = (tag, text, className) => {
            const node = root.createElement(tag);
            if (text) node.textContent = text;
            if (className) node.className = className;
            return node;
        };
        dialog = element('global-dialog');
        dialog.id = 'legal-acceptance-notice';
        dialog.hidden = true;
        title = element('div', 'Updated Terms & Privacy Policy');
        title.slot = 'title';
        const body = element('div', '', 'bp-legal-acceptance-body');
        body.slot = 'body';
        documents = element('div', '', 'bp-legal-acceptance-documents');
        notice = element('p', 'By selecting Accept updates, you agree to the Terms of Use, acknowledge the Privacy Policy, and confirm you are at least 16 and legally eligible to use BenchPoll.');
        const draft = element('p', 'Your draft stays on this page. Optional privacy choices are unchanged.', 'bp-legal-acceptance-note');
        message = element('p', '', 'bp-legal-acceptance-status');
        message.id = 'legal-acceptance-status';
        message.setAttribute('role', 'status');
        body.append(documents, notice, draft, message);
        const actions = element('div');
        actions.slot = 'actions';
        close = element('button', 'Not now', 'bp-ui-action');
        close.type = 'button';
        close.id = 'legal-acceptance-close';
        close.addEventListener('click', dismiss);
        refresh = element('button', 'Check again', 'bp-ui-action');
        refresh.type = 'button';
        refresh.id = 'legal-acceptance-refresh';
        refresh.addEventListener('click', () => { requested = true; void load(); });
        signIn = element('a', 'Sign in again', 'bp-ui-action');
        signIn.href = '/github_login';
        signIn.target = '_blank';
        signIn.rel = 'noopener';
        signIn.id = 'legal-acceptance-sign-in';
        accept = element('button', 'Accept updates', 'bp-ui-action');
        accept.type = 'button';
        accept.dataset.uiVariant = 'primary';
        accept.id = 'legal-acceptance-submit';
        accept.addEventListener('click', () => { void save(); });
        actions.append(close, refresh, signIn, accept);
        dialog.append(title, body, actions);
        dialog.addEventListener('dialog-cancel', event => { event.preventDefault(); dismiss(); });
        root.body.append(dialog);
    }

    function render(text = '') {
        if (!dialog) return;
        const ready = phase === 'ready' || phase === 'saving';
        title.textContent = phase === 'success' ? 'You are up to date' : 'Updated Terms & Privacy Policy';
        documents.hidden = !ready;
        notice.hidden = !ready;
        message.textContent = text;
        message.hidden = !text;
        message.dataset.error = String(phase === 'error' || phase === 'session');
        accept.hidden = !ready;
        accept.disabled = phase !== 'ready';
        refresh.hidden = phase !== 'error' && phase !== 'session';
        signIn.hidden = phase !== 'session';
        close.textContent = phase === 'success' ? 'Done' : 'Not now';
        close.disabled = pending;
        dialog.setAttribute('aria-busy', String(phase === 'loading' || pending));
    }

    function show() {
        ensureDialog();
        dialog.hidden = false;
    }

    function dismiss() {
        if (pending) return;
        ++generation;
        controller?.abort();
        controller = null;
        loading = null;
        requested = false;
        status = null;
        writeScope = null;
        phase = 'idle';
        if (dialog) dialog.hidden = true;
    }

    function sessionFailure() {
        phase = 'session';
        status = null;
        show();
        render('Your sign-in changed or expired. No acceptance was confirmed. Sign in again in a new tab; keep this page open to preserve your draft.');
    }

    function renderDocuments() {
        documents.replaceChildren();
        for (const [key, label] of [['terms', 'Terms of Use'], ['privacy', 'Privacy Policy']]) {
            const link = root.createElement('a');
            link.href = `/${key}`;
            link.target = '_blank';
            link.rel = 'noopener';
            const name = root.createElement('span');
            name.textContent = label;
            const version = root.createElement('span');
            version.className = 'bp-legal-acceptance-version';
            version.textContent = `Version ${status.versions[key]}`;
            link.append(name, version);
            documents.append(link);
        }
    }

    function load(text = '') {
        if (loading || pending) return loading;
        const turn = ++generation;
        controller = new globalThis.AbortController();
        status = null;
        phase = 'loading';
        if (requested || dialog && !dialog.hidden) { show(); render('Checking the current versions...'); }
        loading = (async () => {
            try {
                const current = legalAcceptanceStatus(await request('/api/get_privacy_status', {}, {
                    ...OPTIONS, signal: controller.signal
                }));
                if (turn !== generation) return;
                if (!current.authenticated) {
                    if (requested) sessionFailure();
                    else phase = 'idle';
                    return;
                }
                if (!requested && current.accepted) { phase = 'idle'; return; }
                scope.bind(current.userID);
                // An expired consent request can recover, but may never adopt a different page owner.
                writeScope = createAccountWriteScope();
                writeScope.bind(scope.capture());
                status = current;
                show();
                if (current.accepted) {
                    phase = 'success';
                    render('The current Terms are accepted and the Privacy Policy is acknowledged. Your draft is unchanged; retry your action when ready.');
                } else {
                    phase = 'ready';
                    renderDocuments();
                    render(text);
                }
            } catch (error) {
                if (turn !== generation) return;
                if ((isAccountWriteError(error) || error.status === 401) && (requested || dialog && !dialog.hidden)) sessionFailure();
                else if (requested || dialog && !dialog.hidden) {
                    phase = 'error';
                    show();
                    render('The current versions could not be loaded. Your draft is unchanged. Check again when ready.');
                } else phase = 'idle';
            } finally {
                if (turn === generation) { loading = null; controller = null; }
            }
        })();
        return loading;
    }

    function open({ expectedUserID } = {}) {
        requested = true;
        if (expectedUserID !== undefined) {
            try { scope.bind(expectedUserID); }
            catch { sessionFailure(); return Promise.resolve(); }
        }
        if (pending || phase === 'ready' || phase === 'success' || phase === 'session') return Promise.resolve();
        if (loading) { show(); render('Checking the current versions...'); return loading; }
        return load();
    }

    async function save() {
        if (phase !== 'ready' || pending || !status) return;
        const submitted = status;
        pending = true;
        phase = 'saving';
        render('Recording your acceptance...');
        try {
            const owner = scope.capture();
            if (owner !== submitted.userID) throw accountWriteError();
            const result = legalAcceptanceStatus(await writeScope.write((path, body) => request(path, body, OPTIONS),
                '/api/accept_legal_terms', legalAcceptancePayload(submitted)));
            if (scope.capture() !== owner) throw accountWriteError();
            if (!result.authenticated || result.userID !== submitted.userID) {
                sessionFailure();
                return;
            }
            if (!result.accepted || result.versions.terms !== submitted.versions.terms
                || result.versions.privacy !== submitted.versions.privacy) throw new Error('Acceptance was not confirmed.');
            status = result;
            phase = 'success';
            pending = false;
            render('Terms accepted and Privacy Policy acknowledged. Your draft is unchanged; retry your action when ready.');
            view.dispatchEvent(new view.CustomEvent('benchpoll:legal-acceptance-complete', {
                detail: { userID: result.userID, versions: { ...result.versions } }
            }));
            close.focus({ preventScroll: true });
        } catch (error) {
            pending = false;
            if (isAccountWriteError(error) || error.status === 401) sessionFailure();
            else if (error.payload?.error === 'legal_version_changed' || error.payload?.error === 'privacy_form_expired') {
                // Only refresh the read: new documents or a new CSRF token need another explicit click.
                await load(error.payload.error === 'legal_version_changed'
                    ? 'The documents changed again. Review these versions before accepting.'
                    : 'The security check was refreshed. Review the notice and accept again when ready.');
            } else {
                phase = 'error';
                render('Acceptance could not be confirmed. Your draft is unchanged. Check the current status before trying again.');
            }
        } finally {
            pending = false;
            if (dialog) { close.disabled = false; dialog.setAttribute('aria-busy', 'false'); }
        }
    }

    return { open, check: () => load(), dismiss };
}

export function installLegalAcceptance(root = document) {
    if (installed.has(root)) return installed.get(root);
    const ui = createLegalAcceptanceUI({ root });
    installed.set(root, ui);
    root.defaultView.addEventListener('benchpoll:legal-acceptance-required', event => { void ui.open(event.detail ?? {}); });
    const checkReturningAccount = () => {
        if (root.querySelector('[data-account-privacy], [data-sign-in]')
            || /^\/(terms|privacy|cookies|community-guidelines)\/?$/.test(root.defaultView.location.pathname)) return;
        void ui.check();
    };
    if (root.readyState === 'loading') root.addEventListener('DOMContentLoaded', checkReturningAccount, { once: true });
    else checkReturningAccount();
    root.defaultView.addEventListener('pageshow', event => { if (event.persisted) checkReturningAccount(); });
    return ui;
}
