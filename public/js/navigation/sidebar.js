import { navigationChannel } from '../shared/navigation-channel.js';
import { configuredRows, contextKey, entryFromContext, locationURL, validateNavigationPayload } from './model.js';
import { readSidebarPreferences, writeSidebarPreferences } from './preferences.js';

export function createSidebarNavigation({ onNavigate, onLogin, onSessionChange }) {
    const tree = document.getElementById('tree-content');
    const list = document.getElementById('configured-content');
    const viewport = document.querySelector('.bp-taxonomy');
    const tools = document.getElementById('configured-search-wrap');
    const search = document.getElementById('configured-search');
    const retry = document.getElementById('navigation-retry');
    const feedback = document.getElementById('navigation-feedback');
    const empty = document.getElementById('configured-empty');
    const browse = document.getElementById('configured-browse');
    const login = document.getElementById('configured-login');
    const buttons = [...document.querySelectorAll('[data-navigation-view]')];
    const preferences = readSidebarPreferences();
    let account = null, current = null, confirmed = null, items = [], rowEntries = new Map();
    let request = 0, controller = null, failed = false, loaded = false;
    let restoring = false, confirmedVersion = 0, scrollFrame = null;
    const scrollReady = { all: false, configured: false };

    function restorePosition(top) {
        restoring = true;
        viewport.scrollTop = top;
        if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
        scrollFrame = requestAnimationFrame(() => { restoring = false; scrollFrame = null; });
    }

    function mark(configured, label) {
        const icon = document.createElement('span');
        icon.className = 'bp-config-mark';
        icon.classList.toggle('is-configured', configured);
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-label', label);
        icon.title = label;
        // One symbol, two fill treatments: no bookmark/favourite semantics.
        icon.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.5"/><path d="M9 2.5v6.5h6.5A6.5 6.5 0 0 0 9 2.5Z"/></svg>';
        return icon;
    }

    function updateTreeMarkers() {
        const categories = new Set(items.map(item => item.categoryID));
        tree.querySelectorAll('[data-category-id]').forEach(row => {
            const configured = categories.has(Number(row.dataset.categoryId));
            row.dataset.configured = String(configured);
            const existing = row.querySelector('.bp-config-mark');
            if (!configured) existing?.remove();
            else if (!existing) row.append(mark(true, 'Personal weights configured in this category'));
        });
    }

    function applyConfirmedWorkspace() {
        if (!confirmed || confirmed.userID !== account || !current) return;
        const key = contextKey(current.categoryID, current.contextValues);
        items = items.filter(item => contextKey(item.categoryID, item.contextValues) !== key);
        if (confirmed.hasPersonalWeights) items.push({ ...current });
    }

    function render() {
        updateTreeMarkers();
        const oldScroll = viewport.scrollTop;
        const focused = document.activeElement;
        const existing = new Map([...list.children].map(element => [element.dataset.key, element]));
        const anchor = preferences.view === 'configured'
            ? [...list.children].find(element => element.getBoundingClientRect().bottom >= viewport.getBoundingClientRect().top) : null;
        const anchorTop = anchor?.getBoundingClientRect().top;
        const rows = configuredRows(items, current, search.value);
        rowEntries = new Map(rows.map(row => [row.key, row]));
        const fragment = document.createDocumentFragment();
        for (const row of rows) {
            let link = existing.get(row.key);
            if (!link) {
                link = document.createElement('a');
                link.className = 'bp-configured-row';
                link.dataset.key = row.key;
                link.addEventListener('click', async event => {
                    const entry = rowEntries.get(link.dataset.key);
                    if (!entry || !entry.available) { event.preventDefault(); return; }
                    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    await onNavigate(entry);
                });
                link.addEventListener('keydown', event => {
                    if (event.key === 'Enter' && link.getAttribute('aria-disabled') === 'true') event.preventDefault();
                });
            }
            link.classList.toggle('selected', row.current);
            link.classList.toggle('is-group-start', row.groupStart);
            link.classList.toggle('is-unavailable', !row.available);
            link.dataset.locationCategoryId = String(row.categoryID);
            link.dataset.configured = String(row.configured);
            link.dataset.groupId = String(row.groupID);
            link.dataset.context = JSON.stringify(row.contextValues);
            link.style.setProperty('--navigation-depth', String(Math.min(row.depth, 3)));
            link.setAttribute('aria-current', row.current ? 'page' : 'false');
            link.setAttribute('aria-disabled', String(!row.available));
            link.tabIndex = 0;
            const fullName = [row.lineage.map(category => category.name).join(' / '), row.contextLabel].filter(Boolean).join(' · ');
            link.title = row.available ? fullName : `${fullName}\nThis configuration is unavailable. Its category or conditions have changed.`;
            if (row.available) link.href = locationURL(row);
            else link.removeAttribute('href');
            const copy = document.createElement('span');
            copy.className = 'bp-configured-copy';
            const name = document.createElement('span');
            name.className = 'bp-configured-name';
            name.textContent = row.categoryName;
            copy.append(name);
            for (const [className, text] of [['bp-configured-path', row.pathLabel], ['bp-configured-context', row.contextLabel]]) {
                if (!text) continue;
                const detail = document.createElement('small');
                detail.className = className;
                detail.textContent = text;
                copy.append(detail);
            }
            const icon = mark(row.configured, !row.available ? 'Configuration unavailable'
                : row.configured ? 'Personal weights configured' : 'No personal weights in this context');
            icon.classList.toggle('is-unavailable', !row.available);
            link.replaceChildren(copy, icon);
            fragment.append(link);
        }
        list.replaceChildren(fragment);
        list.setAttribute('aria-label', `Configured weights: ${items.length} contexts`);
        empty.hidden = failed || !loaded && account !== null || rows.length > 0;
        empty.textContent = search.value ? 'No matching configurations.' : 'No configured weights yet.';
        login.hidden = account !== null;
        browse.hidden = items.length > 0 && rows.length > 0;
        retry.hidden = !failed;
        if (preferences.view === 'configured') {
            const top = !scrollReady.configured ? preferences.scroll.configured
                : anchor?.isConnected ? oldScroll + anchor.getBoundingClientRect().top - anchorTop : oldScroll;
            restorePosition(top);
            if (loaded) scrollReady.configured = true;
            // Moving retained anchors through a fragment can blur them in browsers.
            if (focused?.classList.contains('bp-configured-row')) {
                const nextFocus = focused.isConnected ? focused : list.querySelector('[aria-current="page"]');
                if (nextFocus && document.activeElement !== nextFocus) nextFocus.focus({ preventScroll: true });
            }
        }
    }

    function setView(view, { remember = true } = {}) {
        if (remember && scrollReady[preferences.view]) preferences.scroll[preferences.view] = viewport.scrollTop;
        preferences.view = view === 'configured' ? 'configured' : 'all';
        const configured = preferences.view === 'configured';
        tree.hidden = configured;
        document.getElementById('configured-panel').hidden = !configured;
        tools.hidden = !configured;
        buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.navigationView === preferences.view)));
        restorePosition(preferences.scroll[preferences.view]);
        if (configured && loaded) scrollReady.configured = true;
        if (remember) writeSidebarPreferences(preferences);
    }

    async function refresh() {
        if (!account) return;
        const owner = account, sequence = ++request, versionAtRequest = confirmedVersion;
        controller?.abort();
        controller = new globalThis.AbortController();
        viewport.setAttribute('aria-busy', 'true');
        try {
            const response = await fetch('/api/get_personal_navigation', {
                method: 'POST', credentials: 'same-origin', cache: 'no-store',
                headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal
            });
            if (sequence !== request || owner !== account) return;
            if (response.status === 401) {
                setAccount(null);
                onSessionChange();
                return;
            }
            if (!response.ok) throw new Error('Could not load configurations');
            const payload = validateNavigationPayload(await response.json());
            if (sequence !== request || owner !== account) return;
            if (payload.userID !== owner) {
                setAccount(null);
                onSessionChange();
                return;
            }
            items = payload.items;
            if (confirmedVersion > versionAtRequest) applyConfirmedWorkspace();
            loaded = true;
            failed = false;
            feedback.textContent = '';
            render();
        } catch (error) {
            if (sequence !== request || error.name === 'AbortError') return;
            failed = true;
            feedback.textContent = 'Could not load configured weights. Use Retry.';
            render();
        } finally {
            if (sequence === request) viewport.setAttribute('aria-busy', 'false');
        }
    }

    function setAccount(userID) {
        const next = userID == null ? null : String(userID);
        if (next === account && loaded) { void refresh(); return; }
        ++request;
        controller?.abort();
        account = next;
        scrollReady.configured = false;
        items = [];
        failed = false;
        loaded = next === null;
        // A confirmed snapshot from another account can never seed this index.
        applyConfirmedWorkspace();
        feedback.textContent = '';
        viewport.setAttribute('aria-busy', 'false');
        render();
        if (account) void refresh();
    }

    navigationChannel.subscribe(snapshot => {
        if (account !== null && snapshot.userID !== null && snapshot.userID !== account) return;
        ++confirmedVersion;
        current = entryFromContext(snapshot.context);
        confirmed = snapshot;
        if (!snapshot.authenticated && account) {
            setAccount(null);
            onSessionChange();
        } else {
            applyConfirmedWorkspace();
            render();
            if (snapshot.personalSave && account === snapshot.userID) void refresh();
        }
    });
    buttons.forEach(button => button.addEventListener('click', () => setView(button.dataset.navigationView)));
    search.addEventListener('input', render);
    retry.addEventListener('click', () => void refresh());
    browse.addEventListener('click', () => setView('all'));
    login.addEventListener('click', onLogin);
    viewport.addEventListener('scroll', () => {
        if (restoring || !scrollReady[preferences.view]) return;
        preferences.scroll[preferences.view] = viewport.scrollTop;
        writeSidebarPreferences(preferences);
    }, { passive: true });
    window.addEventListener('pagehide', () => writeSidebarPreferences(preferences));
    const initialView = preferences.view;
    setView(initialView, { remember: false });
    render();
    return {
        setAccount, refresh, updateTreeMarkers,
        expansionFor(ID, fallback) { return preferences.expansion[ID] ?? fallback; },
        rememberExpansion(ID, expanded) {
            preferences.expansion[ID] = Boolean(expanded);
            writeSidebarPreferences(preferences);
        },
        restoreScroll() {
            scrollReady.all = true;
            restorePosition(preferences.scroll[preferences.view]);
        }
    };
}
