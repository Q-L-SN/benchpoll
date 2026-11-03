import { setLoading } from './shared/loading.js';
import { postJSON } from './shared/http.js';
import { normalizePrivacyStatus, safeGitHubAuthorizationURL } from './account-privacy.js';
import { enhanceUI } from './shared/ui-components.js';

const OPTIONS = Object.freeze({ requireJSON: true, timeoutMs: 15000 });

export function createSignInUI({ root = document, request = postJSON,
    navigate = url => window.location.assign(url) } = {}) {
    const form = root.getElementById('sign-in-form');
    const submit = root.getElementById('sign-in-submit');
    const status = root.getElementById('sign-in-status');
    const retry = root.getElementById('sign-in-retry');
    let privacy = null, loading = false, pending = false;
    function message(text, error = false, busy = false) {
        if (busy) setLoading(status, text);
        else status.textContent = text;
        status.dataset.error = String(error);
        status.setAttribute('aria-live', error ? 'assertive' : 'polite');
    }
    function render() {
        submit.disabled = !privacy || loading || pending;
        retry.disabled = loading || pending;
        form.setAttribute('aria-busy', String(loading || pending));
    }
    async function refreshStatus() {
        if (loading || pending) return;
        loading = true; privacy = null; retry.hidden = true;
        message('Getting sign-in ready', false, true); render();
        try {
            privacy = normalizePrivacyStatus(await request('/api/get_privacy_status', {}, OPTIONS));
            message('');
        } catch {
            retry.hidden = false;
            message('Sign-in could not be loaded. Please try again.', true);
        } finally { loading = false; render(); }
    }
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!privacy || loading || pending) return;
        pending = true; retry.hidden = true; message('Opening GitHub', false, true); render();
        try {
            const result = await request('/api/prepare_github_login', {
                csrfToken: privacy.csrfToken, termsVersion: privacy.versions.terms,
                privacyVersion: privacy.versions.privacy, acceptedTerms: true, eligibleAge: true
            }, OPTIONS);
            navigate(safeGitHubAuthorizationURL(result?.url));
        } catch (error) {
            pending = false;
            if (error.status === 403 || error.status === 409) {
                await refreshStatus();
                if (privacy) message('Sign-in was refreshed. Review the notice, then continue again.', true);
            } else {
                message('GitHub sign-in could not be opened. Please try again.', true);
            }
            render();
        }
    });
    retry.addEventListener('click', () => { void refreshStatus(); });
    root.defaultView?.addEventListener('pageshow', event => {
        if (event.persisted) { pending = false; void refreshStatus(); }
    });
    enhanceUI(root);
    const ready = refreshStatus();
    return { ready, refreshStatus };
}

if (typeof document !== 'undefined' && document.querySelector('[data-sign-in]')) createSignInUI();
