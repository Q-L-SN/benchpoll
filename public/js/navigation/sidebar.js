import { setLoading } from '../shared/loading.js';
import { navigationChannel } from '../shared/navigation-channel.js';
import { configuredRows, contextKey, entryFromContext, locationURL, popularTopics, validateNavigationPayload } from './model.js?v=comparison-experiment-20261007';
import { readSidebarPreferences, writeSidebarPreferences, readRecentTopics, writeRecentTopics, addRecentTopic, RECENT_TOPICS_PREFIX } from './preferences.js';
import { postJSON } from '../shared/http.js';
import { isAccountWriteError, accountWriteError, pageAccountWriteScope } from '../shared/account-identity.js';
import { animateContent, setVisible } from '../shared/motion.js';
import { normalizeTopicSummary, sceneSummary } from '../shared/topics.js';
import { sceneURL, searchTopicGroups, sceneMatchSummary } from './scenes.js';

export function createSidebarNavigation({ onNavigate, onLogin, onSessionChange, onCreatePrivate }) {
    const tree = document.getElementById('tree-content');
    const list = document.getElementById('configured-content');
    const viewport = document.querySelector('.bp-taxonomy');
    const tools = document.getElementById('configured-search-wrap');
    const search = document.getElementById('configured-search');
    const searchToggle = document.getElementById('navigation-search-toggle');
    const searchClose = document.getElementById('navigation-search-close');
    const searchResults = document.getElementById('category-search-results');
    const retry = document.getElementById('navigation-retry');
    const feedback = document.getElementById('navigation-feedback');
    const empty = document.getElementById('configured-empty');
    const browse = document.getElementById('configured-browse');
    const login = document.getElementById('configured-login');
    const createButtons = [...document.querySelectorAll('[data-create-topic]')];
    const createForm = document.getElementById('topic-create-form');
    const createName = document.getElementById('topic-create-name');
    const createDescription = document.getElementById('topic-create-description');
    const createError = document.getElementById('topic-create-error');
    const buttons = [...document.querySelectorAll('[data-navigation-view]')];
    const preferences = readSidebarPreferences();
    let account = null, current = null, confirmed = null, items = [], rowEntries = new Map();
    let request = 0, controller = null, failed = false, loaded = false;
    let restoring = false, confirmedVersion = 0, scrollFrame = null;
    const scrollReady = { popular: false, recent: false, configured: false, search: false };
    let categories = [], categoryRequest = 0, categoryLoading = false, categoryError = false;
    let categoriesLoaded = false;
    let accountKnown = false, recentRecords = [], recentDisplayKeys = [], lastVisited = null;
    let privateValidation = 0, actionDepth = 0, recentDirty = false;
    const accessiblePrivateTopics = new Map();
    let catalog = [], catalogLoaded = false, catalogLoading = false, catalogError = false, catalogRequest = 0;
    let searchReturnView = 'popular', creating = false;

    const keyFor = entry => contextKey(entry.categoryID, entry.contextValues);

    function recentEntries() {
        const publicTopics = new Map(categories.map(topic => [topic.categoryID, topic]));
        const saved = new Map(items.map(item => [keyFor(item), item]));
        return recentRecords.flatMap(record => {
            const topic = record.isPrivate ? account !== null && accessiblePrivateTopics.get(record.categoryID) : publicTopics.get(record.categoryID);
            if (!topic) return [];
            const key = keyFor(record);
            const scene = topic.scenes?.find(item => String(item.ID) === record.contextValues?.scene);
            if (record.contextValues?.scene && Array.isArray(topic.scenes) && !scene) return [];
            const label = saved.get(key)?.contextLabel ?? (current && keyFor(current) === key ? current.contextLabel : null)
                ?? scene?.name
                ?? Object.entries(record.contextValues).map(([name, value]) => `${name}: ${value}`).join(' / ');
            return [{ ...topic, contextValues: record.contextValues, contextLabel: label,
                ...(scene ? { url: scene.url || sceneURL(topic.url, scene), description: sceneSummary(topic, scene) } : {}) }];
        });
    }

    function flushRecentOrder(force = false) {
        if (!recentDirty && !force) return;
        if (!force && preferences.view === 'recent' && (actionDepth > 0 || viewport.matches(':hover')
            || viewport.contains(document.activeElement))) return;
        recentDisplayKeys = recentEntries().map(keyFor);
        recentDirty = false;
        renderTopics();
        renderCategorySearch();
    }

    function recordSuccessfulVisit(snapshot) {
        const visited = entryFromContext(snapshot.context);
        if (!accountKnown || !visited || snapshot.userID !== account) return;
        if (account !== null) {
            try { if (pageAccountWriteScope.capture() !== account) return; } catch { return; }
        } else if (snapshot.authenticated || visited.isPrivate) return;
        if (visited.isPrivate) accessiblePrivateTopics.set(visited.categoryID, visited);
        const identity = `${account ?? 'guest'}:${keyFor(visited)}`;
        if (identity === lastVisited) return;
        lastVisited = identity;
        recentRecords = addRecentTopic(recentRecords, visited, account,
            Math.max(Date.now(), (recentRecords[0]?.visitedAt ?? 0) + 1));
        writeRecentTopics(account, recentRecords);
        recentDirty = true;
        flushRecentOrder();
    }

    async function validatePrivateRecents({ force = false } = {}) {
        const owner = account, sequence = ++privateValidation;
        if (owner === null) return;
        try { if (pageAccountWriteScope.capture() !== owner) return; } catch { return; }
        const records = [...new Map(recentRecords.filter(record => record.isPrivate
            && (force || !accessiblePrivateTopics.has(record.categoryID))).map(record => [record.categoryID, record])).values()];
        await Promise.all(records.map(async record => {
            try {
                const topic = await postJSON('/api/get_private_category', { categoryID: record.categoryID });
                if (sequence !== privateValidation || owner !== account || pageAccountWriteScope.capture() !== owner) return;
                const ID = Number(topic.categoryID ?? topic.ID), name = topic.categoryName ?? topic.name;
                if (ID !== record.categoryID || typeof name !== 'string') return;
                accessiblePrivateTopics.set(ID, entryFromContext({ categoryID: ID, isPrivate: true,
                    description: topic.description, creator: topic.creator, scenes: topic.scenes,
                    lineage: [{ ID, name }], contextValues: {} }));
            } catch {
                if (sequence === privateValidation && owner === account) accessiblePrivateTopics.delete(record.categoryID);
            }
        }));
        if (sequence !== privateValidation || owner !== account) return;
        renderTopics();
        renderCategorySearch();
        recentDirty = true;
        flushRecentOrder();
    }

    async function navigate(entry) {
        ++actionDepth;
        try { return await onNavigate(entry); }
        finally { --actionDepth; flushRecentOrder(); }
    }

    function visibleTopics() {
        if (preferences.view === 'search') return catalogLoaded ? catalog : categories;
        if (preferences.view !== 'recent') return categories;
        const entries = new Map(recentEntries().map(entry => [keyFor(entry), entry]));
        return recentDisplayKeys.flatMap(key => entries.has(key) ? [entries.get(key)] : []);
    }

    function topicLink(entry, className) {
        const link = document.createElement('a');
        link.className = className;
        link.href = locationURL(entry);
        link.dataset.categoryId = String(entry.categoryID);
        link.dataset.key = keyFor(entry);
        if (entry.contextValues?.scene) link.dataset.sceneId = entry.contextValues.scene;
        link.dataset.private = String(entry.isPrivate === true);
        const copy = document.createElement('span'); copy.className = 'bp-topic-copy';
        const name = document.createElement('span'); name.textContent = entry.isScene ? `${entry.categoryName} / ${entry.sceneName}` : entry.categoryName;
        copy.append(name);
        if (entry.description) {
            const summary = document.createElement('small'); summary.className = 'bp-topic-summary';
            summary.textContent = entry.description; copy.append(summary);
        }
        if (preferences.view === 'recent' && entry.contextLabel) {
            const context = document.createElement('small'); context.textContent = entry.contextLabel; copy.append(context);
        }
        if (categories.filter(topic => topic.categoryName === entry.categoryName).length > 1) {
            const identity = document.createElement('small'); identity.textContent = `Topic ${entry.categoryID}`; copy.append(identity);
        }
        link.append(copy);
        if (entry.isPrivate) {
            const lock = document.createElement('i'); lock.className = 'fa-solid fa-lock bp-private-category-mark';
            lock.setAttribute('aria-label', 'Private topic'); link.append(lock);
        }
        link.dataset.tooltip = [entry.categoryName, entry.description, entry.contextLabel].filter(Boolean).join('\n');
        link.dataset.metadata = JSON.stringify([entry.categoryName, entry.description, entry.contextLabel, entry.isPrivate]);
        link.addEventListener('click', async event => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (await navigate(entry) && preferences.view === 'search') setView(searchReturnView);
        });
        return link;
    }

    function topicStatus(host, message, loading = false) {
        const status = document.createElement('p');
        status.className = 'bp-navigation-search-status'; status.setAttribute('role', 'status');
        if (loading) setLoading(status, message);
        else status.textContent = message;
        host.append(status);
        if (categoryError) {
            const retrySearch = document.createElement('button');
            retrySearch.type = 'button'; retrySearch.textContent = 'Try again';
            retrySearch.addEventListener('click', () => void loadCategories()); host.append(retrySearch);
        }
    }

    function renderTopics() {
        const entries = visibleTopics();
        const sameRows = entries.length > 0 && tree.childElementCount === entries.length
            && entries.every((entry, index) => tree.children[index].dataset.key === keyFor(entry)
                && tree.children[index].dataset.metadata === JSON.stringify([entry.categoryName, entry.description, entry.contextLabel, entry.isPrivate]));
        if (!sameRows) {
            const top = viewport.scrollTop;
            const focusedKey = tree.contains(document.activeElement) ? document.activeElement.closest('[data-key]')?.dataset.key : null;
            tree.replaceChildren(...entries.map(entry => topicLink(entry, 'bp-topic-row')));
            viewport.scrollTop = top;
            if (focusedKey) [...tree.children].find(row => row.dataset.key === focusedKey)?.focus({ preventScroll: true });
        }
        if (!entries.length) topicStatus(tree, preferences.view === 'recent'
            ? !accountKnown || categoryLoading ? 'Loading recent topics...' : 'No recently viewed topics.'
            : categoryLoading ? 'Loading topics...' : categoryError ? 'Could not load topics.' : 'No topics yet.',
            categoryLoading || preferences.view === 'recent' && !accountKnown);
        updateTreeMarkers();
        if (categoriesLoaded && !scrollReady[preferences.view] && ['popular', 'recent'].includes(preferences.view)) {
            scrollReady[preferences.view] = true;
            restorePosition(preferences.scroll[preferences.view]);
        }
    }

    function renderCategorySearch() {
        const active = preferences.view === 'search';
        searchResults.hidden = !active;
        tree.hidden = ['configured', 'search'].includes(preferences.view);
        searchResults.replaceChildren();
        if (!active) return;
        const matches = searchTopicGroups(visibleTopics(), search.value);
        if (catalogLoading || catalogError || !matches.length) {
            const status = document.createElement('p'); status.className = 'bp-navigation-search-status'; status.setAttribute('role', 'status');
            if (catalogLoading) setLoading(status, 'Searching topics');
            else status.textContent = catalogError ? 'Could not load topics.' : 'No matching topics.';
            searchResults.append(status);
            if (catalogError) appendCatalogRetry(searchResults);
            return;
        }
        const appendResult = entry => {
            const link = topicLink(entry, 'bp-category-search-result');
            link.dataset.searchCategoryId = String(entry.categoryID);
            searchResults.append(link);
            return link;
        };
        for (const group of matches) {
            const link = appendResult({ ...group.topic, contextValues: {}, sceneID: null });
            const summary = sceneMatchSummary(group.scenes);
            if (summary) {
                const matches = document.createElement('small'); matches.className = 'bp-scene-matches'; matches.textContent = summary;
                link.querySelector('.bp-topic-copy').append(matches);
                link.dataset.tooltip += '\n' + summary;
            }
        }
        updateTreeMarkers();
        if (catalogLoaded && !scrollReady.search) {
            scrollReady.search = true;
            restorePosition(preferences.scroll.search);
        }
    }

    function appendCatalogRetry(host) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'bp-quiet-action';
        button.textContent = 'Try again'; button.addEventListener('click', () => void loadCatalog()); host.append(button);
    }

    async function loadCatalog() {
        const owner = account, sequence = ++catalogRequest;
        catalogLoading = true; catalogError = false; render();
        try {
            const payload = await postJSON('/api/get_topics', {});
            if (sequence !== catalogRequest || owner !== account) return;
            if (owner !== null) {
                const profile = payload.userID === undefined ? await postJSON('/api/get_user_profile', {}) : payload;
                if (sequence !== catalogRequest || owner !== account) return;
                if (profile?.userID !== owner || pageAccountWriteScope.capture() !== owner) {
                    setAccount(null); onSessionChange(); return;
                }
            }
            if (!Array.isArray(payload.topics) || payload.topics.some(topic => !Number.isSafeInteger(topic.categoryID ?? topic.ID)
                || (topic.categoryID ?? topic.ID) < 1 || typeof (topic.categoryName ?? topic.name) !== 'string'
                || typeof topic.isMine !== 'boolean' || typeof topic.configured !== 'boolean')) throw new TypeError('Invalid topic catalogue');
            const entries = payload.topics.filter(topic => !topic.isPrivate || owner !== null && topic.isMine === true).map(entryFromContext);
            if (new Set(entries.map(entry => entry.categoryID)).size !== entries.length) throw new TypeError('Duplicate topic identity');
            entries.forEach(entry => locationURL(entry));
            catalog = entries; catalogLoaded = true;
        } catch {
            if (sequence === catalogRequest && owner === account) catalogError = true;
        } finally {
            if (sequence === catalogRequest && owner === account) { catalogLoading = false; render(); }
        }
    }

    async function loadCategories() {
        const sequence = ++categoryRequest;
        categoryLoading = true; categoryError = false; renderTopics(); renderCategorySearch();
        try {
            const payload = await postJSON('/api/get_category_navigation', {});
            const entries = payload.items ?? payload.entries;
            if (!Array.isArray(entries) || entries.some(entry => !Number.isSafeInteger(entry.categoryID) || entry.categoryID < 1
                || typeof entry.categoryName !== 'string' || !Array.isArray(entry.lineage) || entry.lineage.length !== 1
                || entry.lineage.at(-1).ID !== entry.categoryID
                || entry.lineage.some(item => !Number.isSafeInteger(item.ID) || typeof item.name !== 'string')
                || !entry.contextValues || Object.keys(entry.contextValues).some(key => key !== 'scene'))
                || new Set(entries.map(entry => entry.categoryID)).size !== entries.length) throw new Error('Invalid topic navigation response');
            if (sequence === categoryRequest) { categories = popularTopics(entries); categoriesLoaded = true; recentDirty = true; flushRecentOrder(); }
        } catch { if (sequence === categoryRequest) categoryError = true; }
        finally { if (sequence === categoryRequest) { categoryLoading = false; renderTopics(); renderCategorySearch(); } }
    }

    function setSearchOpen(open, focus = false) {
        setVisible(tools, open, { collapse: true });
        searchToggle.setAttribute('aria-expanded', String(open));
        if (!open) { search.value = ''; render(); }
        if (open && preferences.view !== 'configured' && !categoriesLoaded && !categoryLoading) void loadCategories();
        renderCategorySearch();
        if (focus) (open ? search : searchToggle).focus({ preventScroll: true });
    }

    function restorePosition(top) {
        restoring = true;
        viewport.scrollTop = top;
        if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
        scrollFrame = requestAnimationFrame(() => { restoring = false; scrollFrame = null; });
    }

    function revealCurrentTopic() {
        if (!current) return;
        let host = preferences.view === 'configured' ? list : preferences.view === 'search' ? searchResults : tree;
        let selected = host.querySelector('[aria-current="page"]');
        if (!selected) {
            search.value = '';
            setView(current.isPrivate ? 'configured' : 'popular');
            host = current.isPrivate ? list : tree;
            selected = host.querySelector('[aria-current="page"]');
            // The current topic is known even while its directory request is pending.
            if (!selected) {
                selected = topicLink(current, 'bp-topic-row selected');
                selected.setAttribute('aria-current', 'page');
                host.prepend(selected);
            }
        }
        const box = viewport.getBoundingClientRect(), card = selected.getBoundingClientRect();
        const top = Math.max(0, viewport.scrollTop + card.top - box.top - (box.height - card.height) / 2);
        // Set before the drawer becomes visible. Never animate or move page focus.
        restoring = true;
        viewport.scrollTo({ top, behavior: 'instant' });
        preferences.scroll[preferences.view] = viewport.scrollTop;
        scrollReady[preferences.view] = true;
        if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
        scrollFrame = requestAnimationFrame(() => { restoring = false; scrollFrame = null; });
    }
    document.getElementById('config-sidebar')?.addEventListener('sidebar:beforeopen', revealCurrentTopic);

    function mark(configured, label) {
        const icon = document.createElement('span');
        icon.className = 'bp-config-mark';
        icon.classList.toggle('is-configured', configured);
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-label', label);
        icon.dataset.tooltip = label;
        return icon;
    }

    function updateTreeMarkers() {
        const categories = new Set(items.map(item => item.categoryID));
        const configuredContexts = new Set(items.map(keyFor));
        for (const row of [...tree.querySelectorAll('[data-category-id]'), ...searchResults.querySelectorAll('[data-category-id]')]) {
            const configured = row.dataset.sceneId ? configuredContexts.has(row.dataset.key) : categories.has(Number(row.dataset.categoryId));
            const selected = preferences.view === 'recent' ? current && row.dataset.key === keyFor(current)
                : Number(row.dataset.categoryId) === Number(current?.categoryID);
            row.classList.toggle('selected', selected);
            row.setAttribute('aria-current', selected ? 'page' : 'false');
            row.dataset.configured = String(configured);
            const existing = row.querySelector('.bp-config-mark');
            if (!configured) existing?.remove();
            else if (!existing) row.append(mark(true, 'Personal weights configured in this topic'));
        }
    }

    function applyConfirmedWorkspace() {
        if (!confirmed || confirmed.userID !== account) return;
        const entry = entryFromContext(confirmed.context);
        if (!entry) return;
        const key = keyFor(entry);
        items = items.filter(item => contextKey(item.categoryID, item.contextValues) !== key);
        if (confirmed.hasPersonalWeights) items.push({ ...entry, weightCount: Math.max(1, confirmed.weightCount ?? 1) });
    }

    function render() {
        renderTopics();
        renderCategorySearch();
        const oldScroll = viewport.scrollTop;
        const focused = document.activeElement;
        const existing = new Map([...list.children].map(element => [element.dataset.key, element]));
        const anchor = preferences.view === 'configured'
            ? [...list.children].find(element => element.getBoundingClientRect().bottom >= viewport.getBoundingClientRect().top) : null;
        const anchorTop = anchor?.getBoundingClientRect().top;
        const rows = configuredRows(items, current, search.value, account === null ? [] : catalog);
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
                    await navigate(entry);
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
            link.dataset.private = String(row.isPrivate === true);
            link.dataset.groupId = String(row.groupID);
            link.dataset.context = JSON.stringify(row.contextValues);
            link.style.setProperty('--navigation-depth', String(Math.min(row.depth, 3)));
            link.setAttribute('aria-current', row.current ? 'page' : 'false');
            link.setAttribute('aria-disabled', String(!row.available));
            link.tabIndex = 0;
            const fullName = [row.lineage.map(category => category.name).join(' / '), row.contextLabel].filter(Boolean).join(' / ');
            link.dataset.tooltip = row.available ? fullName : `${fullName}\nThis Pie is unavailable because its topic or task options changed.`;
            if (row.available) link.href = locationURL(row);
            else link.removeAttribute('href');
            const copy = document.createElement('span');
            copy.className = 'bp-configured-copy';
            const name = document.createElement('span');
            name.className = 'bp-configured-name';
            name.textContent = row.categoryName;
            copy.append(name);
            if (row.description) {
                const summary = document.createElement('small'); summary.className = 'bp-topic-summary';
                summary.textContent = row.description; copy.append(summary);
            }
            for (const [className, text] of [['bp-configured-path', row.pathLabel], ['bp-configured-context', row.contextLabel]]) {
                if (!text) continue;
                const detail = document.createElement('small');
                detail.className = className;
                detail.textContent = text;
                copy.append(detail);
            }
            const icon = row.isPrivate ? document.createElement('i') : mark(row.configured, !row.available ? 'Pie unavailable'
                : row.configured ? 'You have a Pie here' : 'No personal weights for this task');
            if (row.isPrivate) { icon.className = 'fa-solid fa-lock bp-private-category-mark'; icon.dataset.tooltip = 'Private topic'; icon.setAttribute('aria-label', 'Private topic'); }
            icon.classList.toggle('is-unavailable', !row.available);
            link.replaceChildren(copy, icon);
            fragment.append(link);
        }
        list.replaceChildren(fragment);
        list.setAttribute('aria-label', `Mine: ${rows.length}`);
        const mineFailed = failed || catalogError;
        empty.hidden = !mineFailed && rows.length > 0;
        if (!mineFailed && (!accountKnown || account !== null && (!loaded || !catalogLoaded))) setLoading(empty, 'Loading your topics');
        else empty.textContent = mineFailed ? 'Could not load all your topics.' : !accountKnown ? 'Loading your topics...'
            : account === null ? 'Sign in to see your topics.' : !loaded || !catalogLoaded ? 'Loading your topics...'
                : search.value ? 'No matching topics in Mine.' : 'No topics in Mine yet.';
        login.hidden = account !== null;
        browse.hidden = account === null || rows.length > 0;
        retry.hidden = !mineFailed;
        if (preferences.view === 'configured') {
            const top = !scrollReady.configured ? preferences.scroll.configured
                : anchor?.isConnected ? oldScroll + anchor.getBoundingClientRect().top - anchorTop : oldScroll;
            restorePosition(top);
            if (loaded && current) scrollReady.configured = true;
            // Moving retained anchors through a fragment can blur them in browsers.
            if (focused?.classList.contains('bp-configured-row')) {
                const nextFocus = focused.isConnected ? focused : list.querySelector('[aria-current="page"]');
                if (nextFocus && document.activeElement !== nextFocus) nextFocus.focus({ preventScroll: true });
            }
        }
    }

    function setView(view, { remember = true } = {}) {
        if (remember && scrollReady[preferences.view]) preferences.scroll[preferences.view] = viewport.scrollTop;
        if (view === 'search' && preferences.view !== 'search') searchReturnView = preferences.view;
        preferences.view = ['popular', 'recent', 'configured', 'search'].includes(view) ? view : 'popular';
        if (preferences.view === 'recent') { recentDirty = true; flushRecentOrder(true); void validatePrivateRecents({ force: true }); }
        const configured = preferences.view === 'configured';
        tree.hidden = !['popular', 'recent'].includes(preferences.view);
        document.getElementById('configured-panel').hidden = !configured;
        setSearchOpen(preferences.view === 'search', remember && preferences.view === 'search');
        search.placeholder = 'Search topics...';
        search.setAttribute('aria-label', 'Search topics');
        document.querySelector('.bp-navigation-views').dataset.view = preferences.view;
        buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.navigationView === preferences.view)));
        if (['configured', 'search'].includes(preferences.view) && !catalogLoading && (remember || !catalogLoaded)) void loadCatalog();
        render();
        restorePosition(preferences.scroll[preferences.view]);
        if (configured && loaded && current) scrollReady.configured = true;
        if (remember) writeSidebarPreferences(preferences);
        if (remember) animateContent(configured ? document.getElementById('configured-panel')
            : preferences.view === 'search' ? searchResults : tree);
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
            items = payload.items.filter(item => item.weightCount > 0);
            if (confirmedVersion > versionAtRequest) applyConfirmedWorkspace();
            loaded = true;
            failed = false;
            feedback.textContent = '';
            render();
        } catch (error) {
            if (sequence !== request || error.name === 'AbortError') return;
            failed = true;
            feedback.textContent = 'Could not load your topics. Use Retry.';
            render();
        } finally {
            if (sequence === request) viewport.setAttribute('aria-busy', 'false');
        }
    }

    function setAccount(userID) {
        const next = userID == null ? null : String(userID);
        const changed = !accountKnown || next !== account;
        accountKnown = true;
        if (next === account && loaded) {
            void refresh();
            if (['configured', 'search'].includes(preferences.view)) void loadCatalog();
            return;
        }
        ++request;
        controller?.abort();
        account = next;
        if (changed) {
            ++catalogRequest;
            catalog = []; catalogLoaded = false; catalogLoading = false; catalogError = false;
            scrollReady.search = false;
            createForm.reset(); createError.textContent = ''; void setVisible(createForm, false, { collapse: true });
            createButtons.forEach(button => button.setAttribute('aria-expanded', 'false'));
            ++privateValidation;
            accessiblePrivateTopics.clear();
            recentRecords = readRecentTopics(account);
            recentDisplayKeys = [];
            lastVisited = null;
            recentDirty = true;
            flushRecentOrder(true);
        }
        scrollReady.configured = false;
        items = [];
        failed = false;
        loaded = next === null;
        // A confirmed snapshot from another account can never seed this index.
        applyConfirmedWorkspace();
        if (confirmed) recordSuccessfulVisit(confirmed);
        feedback.textContent = '';
        viewport.setAttribute('aria-busy', 'false');
        render();
        if (account) void refresh();
        if (['configured', 'search'].includes(preferences.view)) void loadCatalog();
        void validatePrivateRecents();
    }

    navigationChannel.subscribe(snapshot => {
        if (account !== null && snapshot.userID !== null && snapshot.userID !== account) return;
        ++confirmedVersion;
        current = entryFromContext(snapshot.context);
        confirmed = snapshot;
        recordSuccessfulVisit(snapshot);
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
    search.addEventListener('input', () => {
        if (preferences.view === 'configured') render();
        else renderCategorySearch();
    });
    const closeSearch = () => { setView(searchReturnView); searchToggle.focus({ preventScroll: true }); };
    searchClose.addEventListener('click', closeSearch);
    tools.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); closeSearch(); }
        if (event.key === 'ArrowDown') {
            const result = preferences.view === 'configured' ? list.querySelector('a') : searchResults.querySelector('a');
            if (result) { event.preventDefault(); result.focus(); }
        }
    });
    searchResults.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); closeSearch(); }
    });
    retry.addEventListener('click', () => { void refresh(); void loadCatalog(); });
    browse.addEventListener('click', () => setView('popular'));
    login.addEventListener('click', onLogin);
    createButtons.forEach(button => button.addEventListener('click', () => {
        if (!account) { onLogin(); return; }
        if (onCreatePrivate) { void onCreatePrivate(button); return; }
        if (creating) return;
        createForm.elements.visibility.value = 'private';
        document.getElementById('topic-create-title').textContent = 'New private topic';
        document.getElementById('topic-visibility-notice').textContent = 'Private topics and their weights stay private and do not affect public rankings.';
        createForm.querySelector('[type="submit"] span').textContent = 'Create private topic';
        createButtons.forEach(item => item.setAttribute('aria-expanded', String(item === button)));
        void setVisible(createForm, true, { collapse: true });
        createError.textContent = ''; createName.focus({ preventScroll: true });
    }));
    createForm.querySelector('[data-cancel]').addEventListener('click', () => {
        if (creating) return;
        createButtons.forEach(button => button.setAttribute('aria-expanded', 'false'));
        void setVisible(createForm, false, { collapse: true });
        createButtons[0].focus({ preventScroll: true });
    });
    createForm.addEventListener('submit', async event => {
        event.preventDefault();
        const owner = account;
        const submit = createForm.querySelector('[type="submit"]');
        if (!owner || creating) return;
        const name = createName.value.trim().normalize('NFC');
        if (!name || [...name].length > 128 || /[\p{Cc}\p{Cf}]/u.test(name)) {
            createError.textContent = 'Use 1 to 128 characters without control characters.'; createName.focus(); return;
        }
        let description;
        try { description = normalizeTopicSummary(createDescription.value); }
        catch { createError.textContent = 'Write one sentence of up to 180 characters.'; createDescription.focus(); return; }
        creating = true;
        createForm.setAttribute('aria-busy', 'true');
        submit.querySelector('i').className = 'bp-spinner';
        submit.disabled = true; createName.disabled = true; createError.textContent = '';
        const isPrivate = true;
        [...createForm.elements].forEach(control => { control.disabled = true; });
        try {
            if (pageAccountWriteScope.capture() !== owner) throw accountWriteError();
            const response = await pageAccountWriteScope.write(postJSON, '/api/create_topic', { name, description, isPrivate });
            if (owner !== account) return;
            const entry = entryFromContext(response?.topic ?? response);
            if (!Number.isSafeInteger(entry?.categoryID) || entry.categoryID < 1 || entry.isPrivate !== isPrivate) throw new TypeError('Invalid new topic');
            locationURL(entry);
            catalog = [...catalog.filter(topic => topic.categoryID !== entry.categoryID), { ...entry, isMine: true }];
            catalogLoaded = true;
            await loadCatalog();
            if (owner !== account || pageAccountWriteScope.capture() !== owner) return;
            if (await navigate(entry)) {
                createButtons.forEach(button => button.setAttribute('aria-expanded', 'false'));
                void setVisible(createForm, false, { collapse: true });
                createName.value = '';
                createDescription.value = '';
            } else createError.textContent = 'Created. Open it from Home.';
        } catch (error) {
            if (owner !== account) return;
            const code = error.payload?.error;
            createError.textContent = isAccountWriteError(error) ? accountWriteError().message
                : code === 'reserved_topic_name' ? 'This topic name is reserved. Choose another name.'
                : ['topic_name_exists', 'private_category_name_exists'].includes(code) ? 'A topic with this name already exists. Choose another name.'
                : code === 'legal_acceptance_required' ? error.message
                : code === 'invalid_topic_name' ? 'Use 1 to 128 characters without control characters.'
                : code === 'invalid_topic_description' ? 'Write one sentence of up to 180 characters.'
                : code === 'verified_email_required' ? 'Sign in with GitHub again to confirm your email, then retry. Your draft is kept.'
                : error.status === 429 ? 'You have reached the daily topic creation limit. Try again later.'
                : error.status === 401 ? 'Sign in to create a topic. Your draft is kept.' : 'Could not create this topic. Your draft is kept; try again.';
        } finally {
            creating = false; createForm.setAttribute('aria-busy', 'false');
            submit.querySelector('i').className = 'fa-solid fa-plus';
            [...createForm.elements].forEach(control => { control.disabled = false; });
        }
    });
    viewport.addEventListener('scroll', () => {
        if (restoring || !scrollReady[preferences.view]) return;
        preferences.scroll[preferences.view] = viewport.scrollTop;
        writeSidebarPreferences(preferences);
    }, { passive: true });
    viewport.addEventListener('pointerleave', () => flushRecentOrder());
    viewport.addEventListener('focusout', () => window.setTimeout(() => flushRecentOrder(), 0));
    window.addEventListener('storage', event => {
        if (!accountKnown || event.key !== null && !event.key.startsWith(RECENT_TOPICS_PREFIX)) return;
        recentRecords = readRecentTopics(account);
        accessiblePrivateTopics.clear();
        recentDirty = true;
        flushRecentOrder();
        void validatePrivateRecents();
    });
    window.addEventListener('pagehide', () => writeSidebarPreferences(preferences));
    const initialView = preferences.view;
    setView(initialView, { remember: false });
    render();
    void loadCategories();
    return {
        setAccount, refresh, updateTreeMarkers,
        setCurrentTopic(topic) { current = entryFromContext(topic); render(); },
        restoreScroll() {
            scrollReady[preferences.view] = true;
            restorePosition(preferences.scroll[preferences.view]);
        }
    };
}
