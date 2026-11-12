import { postJSON } from './shared/http.js';
import { pageAccountWriteScope } from './shared/account-identity.js';
import { element, link, initializeProfileHeader, showFailure } from './shared/profile-page.js';
import { listenAccountChange } from './shared/sign-in.js';

initializeProfileHeader();
const status = document.getElementById('history-status'), list = document.getElementById('history-list');
const more = document.getElementById('history-more');
const clear = document.getElementById('history-clear');
let offset = 0, busy = false, blocked = false;
async function load() {
    if (busy || blocked) return;
    busy = true; more.disabled = true;
    try {
        const result = await postJSON('/api/get_profile_history', { offset }, { timeoutMs: 15000, requireJSON: true });
        if (blocked) return;
        pageAccountWriteScope.bind(result.userID);
        if (!Array.isArray(result.entries)) throw new Error('Invalid history.');
        for (const entry of result.entries) {
            const row = element('li');
            const date = new Date(entry.visitedAt);
            const time = element('time', '', date.toLocaleString());
            if (Number.isFinite(date.getTime())) time.dateTime = date.toISOString();
            const title = [entry.name, entry.sceneName].filter(Boolean).join(' / ');
            const target = typeof entry.url === 'string' && /^\/(?!\/)[^\\\s]*$/.test(entry.url)
                ? link(entry.url, title, null, '') : element('strong', '', title);
            row.append(target, time);
            if (entry.isPrivate) row.append(element('small', '', 'Private topic'));
            list.append(row);
        }
        offset = result.nextOffset;
        more.hidden = offset === null;
        clear.hidden = list.children.length === 0;
        status.textContent = list.children.length ? '' : 'Your history is empty.';
    } catch (error) { showFailure(status, error, 'History could not be loaded. Please try again.'); more.hidden = false; }
    finally { busy = false; more.disabled = blocked; }
}
more.addEventListener('click', load);
clear.addEventListener('click', async () => {
    if (busy || blocked) return;
    busy = true; clear.disabled = true;
    try {
        const result = await pageAccountWriteScope.write((url, body) => postJSON(url, body, { timeoutMs: 15000, requireJSON: true }), '/api/clear_profile_history', {});
        if (result?.cleared !== true || result.userID !== pageAccountWriteScope.capture()) throw new Error('Clearing history could not be confirmed.');
        list.replaceChildren(); more.hidden = clear.hidden = true; offset = 0; status.textContent = 'Browsing history cleared.';
    } catch (error) { showFailure(status, error, 'History could not be cleared. Try again.'); }
    finally { busy = false; clear.disabled = blocked; }
});
listenAccountChange(() => { blocked = true; list.replaceChildren(); more.hidden = clear.hidden = true; status.textContent = 'Your account changed. Refresh to view your history.'; });
void load();
