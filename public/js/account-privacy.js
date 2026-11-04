import { setLoading } from './shared/loading.js';
import { postJSON } from './shared/http.js';
import { pageAccountWriteScope, canonicalAccountID, accountWriteError, isAccountWriteError } from './shared/account-identity.js';
import { enhanceUI } from './shared/ui-components.js';
import { LEGAL_VERSIONS } from './shared/legal-versions.js';

export { LEGAL_VERSIONS };
export const REQUEST_TYPES = Object.freeze({ access: 'Access', correction: 'Correction', erasure: 'Erasure', objection: 'Objection', other: 'Other' });
const HANDLING_STATUSES = Object.freeze({ open: 'Open', in_review: 'In review', closed: 'Closed' });
const REQUEST_OPTIONS = Object.freeze({ requireJSON: true, timeoutMs: 15000 });
const own = (object, key) => Object.hasOwn(object, key);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const failure = (code, field) => Object.assign(new Error(code), { code, field });

export function validPrivacyEmail(value) {
    return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

export function normalizePrivacyStatus(value) {
    if (!value || typeof value.authenticated !== 'boolean' || typeof value.isSenior !== 'boolean'
        || typeof value.accepted !== 'boolean' || value.privateCategoryResearch !== false
        || !nonempty(value.csrfToken)
        || (value.authenticated ? typeof value.userID !== 'string' || canonicalAccountID(value.userID) !== value.userID
            : value.userID !== null || value.isSenior)) throw failure('invalid_privacy_status');
    if (!['terms', 'privacy', 'research'].every(key => value.versions?.[key] === LEGAL_VERSIONS[key])) {
        throw failure('unsupported_legal_version');
    }
    const displayName = typeof value.operator?.displayName === 'string' ? value.operator.displayName.trim() : '';
    const email = typeof value.operator?.email === 'string' ? value.operator.email.trim() : '';
    return { userID: value.userID, authenticated: value.authenticated, isSenior: value.isSenior,
        versions: { ...value.versions }, accepted: value.accepted, privateCategoryResearch: value.privateCategoryResearch,
        csrfToken: value.csrfToken, operator: { displayName, email: validPrivacyEmail(email) ? email : null,
            identityPending: value.operator?.identityPending !== false } };
}

export function consentPayload(status, choices) {
    if (choices.acceptedTerms !== true) throw failure('terms_confirmation_required', 'accepted-terms-check');
    if (choices.eligibleAge !== true) throw failure('age_confirmation_required', 'eligible-age');
    return { csrfToken: status.csrfToken, termsVersion: status.versions.terms, privacyVersion: status.versions.privacy,
        acceptedTerms: true, eligibleAge: true };
}

export function safeGitHubAuthorizationURL(value) {
    let url;
    try { url = new URL(value); } catch { throw failure('unsafe_provider_redirect'); }
    if (typeof value !== 'string' || url.protocol !== 'https:' || url.hostname !== 'github.com'
        || url.port || url.username || url.password || url.hash || url.pathname !== '/login/oauth/authorize') {
        throw failure('unsafe_provider_redirect');
    }
    return url.href;
}

export function privacyRequestPayload(csrfToken, values) {
    const email = typeof values.email === 'string' ? values.email.trim() : '';
    if (!validPrivacyEmail(email)) throw failure('invalid_contact_email', 'request-email');
    if (!own(REQUEST_TYPES, values.requestType)) throw failure('request_type_required', 'request-type');
    const message = typeof values.message === 'string' ? values.message.trim() : '';
    if (!message || message.length > 4000 || message.includes('\0')) throw failure('invalid_request_message', 'request-message');
    return { csrfToken, email, requestType: values.requestType, message };
}

export function normalizePrivacyQueue(value) {
    if (!value || !Array.isArray(value.requests) || !(value.nextCursor === null || nonempty(value.nextCursor))) {
        throw failure('invalid_queue_response');
    }
    const requests = value.requests.map(item => {
        if (!item || !nonempty(item.reference) || !validPrivacyEmail(item.email) || !own(REQUEST_TYPES, item.requestType)
            || !own(HANDLING_STATUSES, item.status) || typeof item.message !== 'string'
            || typeof item.resolution !== 'string' || item.resolution.length > 2000
            || !(item.userID === null || typeof item.userID === 'string' && canonicalAccountID(item.userID) === item.userID)
            || ![item.createdAt, item.dueAt].every(date => typeof date === 'string' && Number.isFinite(Date.parse(date)))) {
            throw failure('invalid_queue_response');
        }
        return { reference: item.reference, userID: item.userID, email: item.email, requestType: item.requestType,
            message: item.message, status: item.status, createdAt: item.createdAt, dueAt: item.dueAt, resolution: item.resolution };
    });
    return { requests, nextCursor: value.nextCursor };
}

export function privacyRequestUpdatePayload(csrfToken, reference, status, resolution) {
    if (!nonempty(reference) || !own(HANDLING_STATUSES, status)) throw failure('invalid_handling_status');
    if (typeof resolution !== 'string' || resolution.length > 2000 || resolution.includes('\0')) throw failure('invalid_resolution', 'queue-resolution');
    if (status === 'closed' && !resolution.trim()) throw failure('resolution_required_when_closed', 'queue-resolution');
    return { csrfToken, reference, status, resolution };
}

const validationMessages = Object.freeze({
    terms_confirmation_required: 'Confirm that you agree to the Terms of Use and acknowledge the Privacy Policy.',
    age_confirmation_required: 'Confirm that you are at least 16 and legally eligible to use BenchPoll.',
    invalid_contact_email: 'Enter a contact email address in the form name@example.com.',
    request_type_required: 'Choose a privacy request type.',
    invalid_request_message: 'Describe your request in 1 to 4,000 characters, using only necessary details.',
    invalid_resolution: 'Keep the handling record within 2,000 characters.',
    resolution_required_when_closed: 'Enter a handling record before closing this request.',
    unsafe_provider_redirect: 'GitHub sign-in was not opened because the server returned an unsafe address. Refresh status and try again.'
});

export function createAccountPrivacyUI({ root = document, request = postJSON, scope = pageAccountWriteScope,
    navigate = url => window.location.assign(url) } = {}) {
    const get = id => root.getElementById(id);
    const send = (path, body) => request(path, body, REQUEST_OPTIONS);
    const state = { status: null, ready: false, loading: false, pending: null, blocked: false,
        submittedRequest: null, queue: { loaded: false, items: [], nextCursor: null, selected: null, drafts: new Map() } };
    const senior = () => state.ready && !state.blocked && state.status?.authenticated && state.status.isSenior;
    const setResult = (id, text = '', tone = '') => {
        const element = get(id);
        if (tone === 'loading') setLoading(element, text);
        else element.textContent = text;
        element.hidden = !text;
        element.dataset.tone = tone;
        element.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
    };
    const requestValues = () => ({ email: get('request-email').value,
        requestType: root.querySelector('input[name="requestType"]:checked')?.value, message: get('request-message').value });
    const requestKey = () => JSON.stringify(requestValues());
    const clearQueue = () => {
        state.queue = { loaded: false, items: [], nextCursor: null, selected: null, drafts: new Map() };
        get('privacy-queue').open = false;
        get('queue-list').replaceChildren();
        get('queue-detail').hidden = true;
        for (const id of ['queue-reference', 'queue-account', 'queue-email', 'queue-type', 'queue-created', 'queue-due', 'queue-message', 'queue-count']) get(id).textContent = '';
        get('queue-resolution').value = '';
        setResult('queue-result');
        setResult('queue-update-result');
    };

    function render() {
        const status = state.status;
        const locked = !state.ready || state.loading || Boolean(state.pending) || state.blocked;
        const accepted = status?.authenticated && status.accepted;
        get('account-heading').textContent = status?.authenticated ? 'Terms & eligibility' : 'Sign in';
        get('account-explanation').textContent = status?.authenticated
            ? 'Confirm the current Terms and your eligibility to use account features.'
            : 'GitHub is needed to save account settings, not to send a privacy request.';
        get('consent-form').hidden = Boolean(accepted);
        get('accepted-terms').hidden = !accepted;
        get('consent-fields').disabled = locked;
        get('request-fields').disabled = Boolean(state.pending);
        get('submit-request').disabled = !state.ready || state.loading || Boolean(state.pending) || state.submittedRequest === requestKey();
        get('refresh-status').disabled = state.loading || Boolean(state.pending);
        get('consent-label').textContent = status?.authenticated ? 'Accept Terms' : 'Continue with GitHub';
        get('consent-icon').className = status?.authenticated ? 'fa-solid fa-check' : 'fa-brands fa-github';
        const canReview = Boolean(senior());
        get('senior-queue-section').hidden = !canReview;
        get('queue-update-fields').disabled = locked || !canReview;
        for (const id of ['refresh-queue', 'more-requests']) get(id).disabled = locked || !canReview;
        root.querySelectorAll('.ap-queue-entry').forEach(button => { button.disabled = locked || !canReview; });
        for (const [id, action] of [['consent-form', 'consent'], ['request-form', 'request'], ['queue-update-form', 'queue-update']]) {
            get(id).setAttribute('aria-busy', String(state.pending === action));
        }
        if (state.blocked) setResult('privacy-status', 'Your sign-in changed or expired. Reload this page before changing account settings. Privacy requests remain available after refreshing status.', 'error');
    }

    function recordStatus(status) {
        try { scope.bind(status.userID); }
        catch (error) { if (!isAccountWriteError(error)) throw error; state.blocked = true; }
        state.status = status;
        state.ready = true;
        get('operator-name').textContent = status.operator.identityPending
            ? 'The operator has not published a legal name or postal address.'
            : `Operator: ${status.operator.displayName || 'identity not provided'}.`;
        get('operator-email').hidden = !status.operator.email;
        if (status.operator.email) {
            get('operator-email').textContent = status.operator.email;
            get('operator-email').href = `mailto:${encodeURIComponent(status.operator.email)}`;
        } else {
            get('operator-email').textContent = '';
            get('operator-email').removeAttribute('href');
        }
        get('operator-contact-note').textContent = status.operator.email
            ? 'The privacy request form is also available without signing in.'
            : 'A direct contact email has not been provided. The privacy request form is available without signing in.';
        const supportLink = root.createElement('a');
        supportLink.href = 'mailto:support@benchpoll.com';
        supportLink.textContent = 'support@benchpoll.com';
        get('operator-contact-note').append(' General questions: ', supportLink, '.');
        if (!status.authenticated || !status.isSenior || state.blocked) clearQueue();
        if (!state.blocked) setResult('privacy-status', status.authenticated
            ? `Signed in as account ${status.userID}.` : 'Not signed in. Privacy requests are available without GitHub.');
        render();
    }

    async function refreshStatus() {
        if (state.loading) return false;
        state.loading = true;
        setResult('privacy-status', 'Loading account status', 'loading');
        render();
        try {
            recordStatus(normalizePrivacyStatus(await send('/api/get_privacy_status', {})));
            return true;
        } catch (error) {
            state.ready = false;
            setResult('privacy-status', error.code === 'unsupported_legal_version'
                ? 'The legal notices have changed. Reload this page to review the current versions before submitting.'
                : 'Account and security status could not be loaded. Your text is unchanged. Refresh status to retry.', 'error');
            get('operator-contact-note').textContent = 'Operator contact details could not be refreshed. See the Privacy Policy for available contact information.';
            return false;
        } finally { state.loading = false; render(); }
    }

    async function showFailure(error, target, { account = false, requestOutcome = false } = {}) {
        if (account && (isAccountWriteError(error) || error.status === 401)) {
            state.blocked = true;
            scope.invalidate();
            clearQueue();
            setResult(target, 'Your sign-in changed or expired. No change was confirmed. Reload before changing account settings; privacy requests do not require sign-in.', 'error');
        } else if (error.status === 403) {
            setResult(target, 'The security or permission check failed. Refreshing status; your text and choices are unchanged.', 'error');
            const refreshed = await refreshStatus();
            setResult(target, refreshed
                ? 'Status refreshed. Review your access and retry when ready. Nothing was automatically resubmitted.'
                : 'The security check failed and status could not be refreshed. Your text is unchanged. Refresh status before retrying.', 'error');
        } else {
            const text = validationMessages[error.code] ?? (error.status === 429
                ? 'Too many requests. Please wait before retrying. Your text and choices are unchanged.'
                : requestOutcome ? 'We could not confirm whether the request was recorded. Your text is unchanged. Retry when ready; a lost response may mean it was already recorded.'
                    : 'The server did not confirm this action. Your text and choices are unchanged. Refresh status or try again.');
            setResult(target, text, 'error');
            if (error.field) {
                const field = get(error.field);
                field.setAttribute('aria-invalid', 'true');
                (field.matches('fieldset') ? field.querySelector('input') : field).focus();
            }
        }
        render();
    }

    async function run(action, target, task, options = {}) {
        if (!state.ready || state.loading || state.pending || options.account && state.blocked) return;
        state.pending = action;
        setResult(target, action === 'queue' ? 'Loading requests' : 'Submitting', 'loading');
        render();
        try { await task(); }
        catch (error) { state.pending = null; render(); await showFailure(error, target, options); }
        finally { state.pending = null; render(); }
    }

    function confirmAccountStatus(value, expected) {
        const next = normalizePrivacyStatus(value);
        if (!next.authenticated || next.userID !== state.status.userID) throw accountWriteError();
        if (own(expected, 'accepted') && next.accepted !== expected.accepted) throw failure('unconfirmed_account_change');
        recordStatus(next);
        if (state.blocked) throw accountWriteError();
    }

    get('consent-form').addEventListener('submit', event => {
        event.preventDefault();
        void run('consent', 'consent-result', async () => {
            const body = consentPayload(state.status, { acceptedTerms: get('accepted-terms-check').checked,
                eligibleAge: get('eligible-age').checked });
            if (state.status.authenticated) {
                confirmAccountStatus(await scope.write(send, '/api/accept_legal_terms', body), { accepted: true });
                setResult('consent-result', 'Current Terms accepted and Privacy Policy acknowledged.', 'success');
            } else {
                const result = await send('/api/prepare_github_login', body);
                const url = safeGitHubAuthorizationURL(result?.url);
                setResult('consent-result', 'Opening GitHub sign-in', 'loading');
                navigate(url);
            }
        }, { account: true });
    });
    get('request-form').addEventListener('submit', event => {
        event.preventDefault();
        void run('request', 'request-result', async () => {
            const body = privacyRequestPayload(state.status.csrfToken, requestValues());
            const result = await send('/api/submit_privacy_request', body);
            if (!nonempty(result?.reference)) throw failure('unconfirmed_privacy_request');
            state.submittedRequest = requestKey();
            setResult('request-result', `Request recorded. Reference: ${result.reference}. Keep this reference for follow-up. A reviewer will verify your request and arrange the next steps.`, 'success');
        }, { requestOutcome: true });
    });

    const formatDate = value => new Date(value).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
    function renderQueueList() {
        const list = get('queue-list');
        list.replaceChildren();
        for (const item of state.queue.items) {
            const row = root.createElement('li');
            const button = root.createElement('button');
            button.type = 'button';
            button.className = 'ap-queue-entry';
            button.setAttribute('aria-pressed', String(state.queue.selected?.reference === item.reference));
            for (const [tag, text, className] of [
                ['strong', item.reference, ''], ['span', HANDLING_STATUSES[item.status], ''],
                ['span', `${REQUEST_TYPES[item.requestType]} - ${item.email} - Review by ${formatDate(item.dueAt)} (internal target)`, 'ap-secondary']
            ]) {
                const node = root.createElement(tag);
                node.textContent = text;
                node.className = className;
                button.append(node);
            }
            button.addEventListener('click', () => selectRequest(item));
            row.append(button);
            list.append(row);
        }
        get('more-requests').hidden = !state.queue.nextCursor;
        get('queue-count').textContent = state.queue.items.length ? `${state.queue.items.length} loaded` : 'No requests in this queue.';
        render();
    }

    function selectRequest(item, { focus = true } = {}) {
        if (!senior() || state.pending) return;
        state.queue.selected = item;
        const draft = state.queue.drafts.get(item.reference) ?? item;
        for (const [id, text] of [['queue-reference', item.reference], ['queue-account', item.userID ?? 'No linked account'],
            ['queue-email', item.email], ['queue-type', REQUEST_TYPES[item.requestType]], ['queue-created', formatDate(item.createdAt)],
            ['queue-due', formatDate(item.dueAt)], ['queue-message', item.message]]) get(id).textContent = text;
        root.querySelectorAll('input[name="handlingStatus"]').forEach(radio => { radio.checked = radio.value === draft.status; });
        get('queue-resolution').value = draft.resolution;
        get('queue-resolution').required = draft.status === 'closed';
        get('queue-detail').hidden = false;
        setResult('queue-update-result');
        renderQueueList();
        if (focus) get('queue-reference').focus();
    }

    async function loadQueue(more = false) {
        if (!senior()) return;
        await run('queue', 'queue-result', async () => {
            const before = more ? state.queue.nextCursor : null;
            if (more && !before) return;
            const body = { csrfToken: state.status.csrfToken, ...(before ? { before } : {}) };
            const result = normalizePrivacyQueue(await scope.write(send, '/api/list_privacy_requests', body));
            const items = new Map((more ? state.queue.items : []).map(item => [item.reference, item]));
            result.requests.forEach(item => items.set(item.reference, item));
            if (more && result.nextCursor === before) throw failure('invalid_queue_response');
            state.queue.items = [...items.values()];
            state.queue.nextCursor = result.nextCursor;
            state.queue.loaded = true;
            renderQueueList();
            setResult('queue-result', state.queue.items.length ? 'Queue loaded.' : 'No requests in this queue.');
        }, { account: true });
    }
    get('privacy-queue').addEventListener('toggle', () => {
        if (get('privacy-queue').open && !state.queue.loaded) void loadQueue();
    });
    get('refresh-queue').addEventListener('click', () => { void loadQueue(); });
    get('more-requests').addEventListener('click', () => { void loadQueue(true); });
    get('queue-update-form').addEventListener('input', () => {
        if (!state.queue.selected) return;
        const status = root.querySelector('input[name="handlingStatus"]:checked')?.value;
        get('queue-resolution').required = status === 'closed';
        get('queue-resolution').removeAttribute('aria-invalid');
        state.queue.drafts.set(state.queue.selected.reference, { status,
            resolution: get('queue-resolution').value });
        setResult('queue-update-result');
    });
    get('queue-update-form').addEventListener('submit', event => {
        event.preventDefault();
        if (!senior() || !state.queue.selected) return;
        void run('queue-update', 'queue-update-result', async () => {
            const item = state.queue.selected;
            const body = privacyRequestUpdatePayload(state.status.csrfToken, item.reference,
                root.querySelector('input[name="handlingStatus"]:checked')?.value, get('queue-resolution').value);
            const result = await scope.write(send, '/api/update_privacy_request', body);
            if (result?.updated !== true) throw failure('unconfirmed_queue_update');
            item.status = body.status;
            item.resolution = body.resolution;
            state.queue.drafts.delete(item.reference);
            const listed = state.queue.items.find(entry => entry.reference === item.reference);
            if (listed) Object.assign(listed, { status: body.status, resolution: body.resolution });
            renderQueueList();
            setResult('queue-update-result', 'Handling record saved. Send any reply and carry out any approved data changes separately.', 'success');
        }, { account: true });
    });

    get('refresh-status').addEventListener('click', () => { void refreshStatus(); });
    for (const form of ['consent-form', 'request-form']) get(form).addEventListener('input', event => {
        event.target.removeAttribute('aria-invalid');
        event.target.closest('fieldset')?.removeAttribute('aria-invalid');
        if (form === 'request-form') {
            if (state.submittedRequest !== requestKey()) setResult('request-result');
        } else setResult('consent-result');
        render();
    });
    get('accepted-terms-check').checked = false;
    get('eligible-age').checked = false;
    enhanceUI(root);
    root.defaultView?.addEventListener('pageshow', event => {
        if (event.persisted) {
            get('accepted-terms-check').checked = false;
            get('eligible-age').checked = false;
            void refreshStatus();
        }
    });
    const ready = refreshStatus();
    return { ready, refreshStatus };
}

if (typeof document !== 'undefined' && document.querySelector('[data-account-privacy]')) {
    import('./shared/site-header.js').then(({ mountSiteActions }) => mountSiteActions(document.getElementById('privacy-site-links'), { manageAccount: true }));
    createAccountPrivacyUI();
}
