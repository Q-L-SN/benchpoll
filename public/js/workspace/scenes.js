import { orderedScenes } from '../navigation/scenes.js';
import { createAction, mountSegmentedControl } from '../shared/ui-components.js';
import { normalizeTopicSummary } from '../shared/topics.js';

const element = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

export function createSceneControls({ host, getState, onSelect, beforeWrite, write, onChanged }) {
    const tabs = element('div', 'bp-scene-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Scenes');
    const actions = element('div', 'bp-scene-actions');
    const create = createAction({ label: 'Add scene', icon: 'fa-solid fa-plus', variant: 'quiet' });
    const edit = createAction({ label: 'Edit scene', icon: 'fa-regular fa-pen-to-square', variant: 'quiet' });
    const makeDefault = createAction({ label: 'Set as default', icon: 'fa-regular fa-star', variant: 'quiet' });
    actions.append(makeDefault, edit, create); host.replaceChildren(tabs, actions);
    const segmented = mountSegmentedControl(tabs, { presentation: false });
    const tabNodes = new Map();
    let tabScope = null, selectedScene = null;
    function syncOverflow() {
        const end = tabs.scrollWidth - tabs.clientWidth;
        tabs.classList.toggle('has-overflow-start', tabs.scrollLeft > 1);
        tabs.classList.toggle('has-overflow-end', end > 1 && tabs.scrollLeft < end - 1);
    }
    function resetMarker() {
        delete tabs.dataset.sceneAnimated;
        delete tabs.dataset.uiReady;
    }
    function refreshTabs() {
        segmented.refresh();
        syncOverflow();
    }
    const tabResize = new ResizeObserver(refreshTabs);
    tabResize.observe(tabs);
    tabs.addEventListener('scroll', syncOverflow, { passive: true });
    document.fonts?.ready.then(refreshTabs);
    const dialog = element('dialog', 'bp-scene-dialog'); dialog.id = 'scene-editor';
    dialog.setAttribute('aria-labelledby', 'scene-editor-title');
    const heading = element('header', 'bp-reference-header');
    const title = element('h2', '', 'Add private scene'); title.id = 'scene-editor-title';
    const close = createAction({ label: 'Close scene editor', icon: 'fa-solid fa-xmark', iconOnly: true });
    heading.append(title, close);
    const form = element('form', 'bp-scene-form');
    const nameLabel = element('label', '', 'Name'), name = element('input', 'bp-ui-input');
    name.type = 'text'; name.required = true; name.maxLength = 128; name.autocomplete = 'off'; name.id = 'scene-name'; nameLabel.htmlFor = name.id;
    const descriptionLabel = element('label', '', 'One-sentence summary'), description = element('textarea', 'bp-ui-input');
    description.required = true; description.maxLength = 180; description.rows = 3;
    description.id = 'scene-description'; descriptionLabel.htmlFor = description.id;
    const message = element('p', 'bp-reference-status'); message.setAttribute('role', 'alert');
    const submit = createAction({ label: 'Create scene', icon: 'fa-solid fa-plus', variant: 'primary' }); submit.type = 'submit';
    form.append(nameLabel, name, descriptionLabel, description, message, submit); dialog.append(heading, form); document.body.append(dialog);
    const status = element('p', 'bp-scene-status'); status.setAttribute('role', 'status'); status.hidden = true; host.append(status);
    let busy = false, scope = null, draftScope = null, switching = false, editingID = null, returnFocus = create;
    const identity = () => `${getState().categoryID}:${getState().userID}`;
    const canManage = state => state.authenticated && state.contextIsPrivate && !state.accountWriteBlocked;
    close.addEventListener('click', () => { if (!busy) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { returnFocus.focus({ preventScroll: true }); });
    function openEditor(scene = null) {
        if (!canManage(getState()) || busy || getState().loading) return;
        scope = identity();
        const key = `${scope}:${scene?.ID ?? 'new'}`;
        if (draftScope !== key) { form.reset(); name.value = scene?.name ?? ''; description.value = scene?.description ?? ''; }
        editingID = scene?.ID ?? null;
        returnFocus = scene ? edit : create;
        title.textContent = scene ? 'Edit private scene' : 'Add private scene';
        submit.querySelector('span').textContent = scene ? 'Save scene' : 'Create scene';
        submit.querySelector('i').className = scene ? 'fa-regular fa-floppy-disk' : 'fa-solid fa-plus';
        draftScope = key; message.textContent = ''; dialog.showModal(); name.focus();
    }
    create.addEventListener('click', () => openEditor());
    edit.addEventListener('click', () => {
        const state = getState(), scene = state.scenes.find(scene => Number(scene.ID) === Number(state.sceneID));
        if (scene) openEditor(scene);
    });

    async function changeDefault() {
        const state = getState(), current = identity();
        if (busy || !canManage(state) || !state.sceneID || state.loading) return;
        busy = true; status.hidden = true; render();
        try {
            if (!await beforeWrite() || current !== identity()) return;
            await write('/api/set_default_topic_scene', { categoryID: state.categoryID, sceneID: state.sceneID });
            if (current === identity()) await onChanged(state.sceneID);
        } catch (error) {
            if (current === identity()) { status.textContent = error.message || 'Could not set the default scene.'; status.hidden = false; }
        } finally { busy = false; render(); }
    }
    makeDefault.addEventListener('click', () => void changeDefault());
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || !canManage(getState()) || scope !== identity()) return;
        const value = name.value.trim().normalize('NFC');
        if (!value || /[\p{Cc}\p{Cf}]/u.test(value) || [...value].length > 128) { name.focus(); return; }
        let summary;
        try { summary = normalizeTopicSummary(description.value); }
        catch { message.textContent = 'Write one sentence of up to 180 characters.'; description.focus(); return; }
        busy = true; submit.disabled = true; close.disabled = true; name.disabled = true; description.disabled = true;
        message.textContent = ''; render();
        try {
            if (!await beforeWrite() || scope !== identity()) return;
            const response = await write(editingID ? '/api/update_topic_scene' : '/api/create_topic_scene', {
                categoryID: getState().categoryID, ...(editingID ? { sceneID: editingID } : {}), name: value, description: summary });
            if (scope !== identity()) return;
            const id = response.scene?.ID ?? response.sceneID ?? response.ID ?? editingID;
            if (!Number.isSafeInteger(id) || id < 1) throw new Error('The new scene could not be confirmed. Refresh before retrying.');
            form.reset(); draftScope = null; dialog.close(); await onChanged(id);
        } catch (error) {
            if (scope === identity()) message.textContent = ['scene_name_exists', 'topic_scene_name_exists'].includes(error.payload?.error)
                ? 'A scene with this name already exists.' : error.message || 'Could not save this scene. Your draft is kept.';
        } finally {
            busy = false; submit.disabled = false; close.disabled = false; name.disabled = false; description.disabled = false; render();
        }
    });

    async function select(id) {
        if (switching || busy || getState().loading || Number(getState().sceneID) === id) return;
        const category = getState().categoryID;
        switching = true;
        try {
            await onSelect(id);
            if (getState().categoryID === category) {
                const active = tabs.querySelector(`[data-scene-id="${getState().sceneID}"]`);
                active?.focus({ preventScroll: true }); active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
        } finally { switching = false; }
    }
    tabs.addEventListener('keydown', event => {
        const buttons = [...tabs.querySelectorAll('[role="tab"]')], index = buttons.indexOf(event.target);
        if (index < 0) return;
        const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length : event.key === 'ArrowLeft'
            ? (index - 1 + buttons.length) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
        if (next === null) return;
        event.preventDefault(); buttons[next].focus({ preventScroll: true }); buttons[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
        // Manual activation avoids issuing ranking requests while traversing long tab rows.
        buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1; });
    });
    function render() {
        const state = getState(), scenes = orderedScenes(state.scenes);
        const focused = tabs.contains(document.activeElement) ? document.activeElement?.dataset.sceneId : null;
        const scroll = tabs.scrollLeft;
        const focusedTab = scenes.some(scene => String(scene.ID) === focused) ? focused : String(state.sceneID);
        const nextScope = identity();
        const sceneIDs = new Set(scenes.map(scene => String(scene.ID)));
        const nextSelected = sceneIDs.has(String(state.sceneID)) ? String(state.sceneID) : null;
        if (tabScope !== nextScope || !nextSelected) resetMarker();
        else if (selectedScene && selectedScene !== nextSelected) tabs.dataset.sceneAnimated = 'true';
        tabScope = nextScope; selectedScene = nextSelected;
        for (const [id, tab] of tabNodes) if (!sceneIDs.has(id)) {
            tabResize.unobserve(tab); tab.remove(); tabNodes.delete(id);
        }
        scenes.forEach((scene, index) => {
            const id = String(scene.ID);
            let tab = tabNodes.get(id);
            if (!tab) {
                tab = element('button', 'bp-scene-tab'); tab.type = 'button'; tab.dataset.sceneId = id;
                tab.id = `scene-tab-${id}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', 'workspace-scene-panel');
                tab.append(element('span', '', scene.name));
                tab.addEventListener('click', () => void select(Number(id)));
                tabNodes.set(id, tab); tabResize.observe(tab);
            }
            if (tabs.children[index] !== tab) tabs.insertBefore(tab, tabs.children[index] ?? null);
            tab.setAttribute('aria-selected', String(Number(scene.ID) === Number(state.sceneID)));
            tab.tabIndex = id === focusedTab ? 0 : -1;
            tab.disabled = state.loading || busy;
            if (tab.firstChild.textContent !== scene.name) tab.firstChild.textContent = scene.name;
        });
        tabs.scrollLeft = scroll;
        if (focused) tabs.querySelector(`[data-scene-id="${focused}"]`)?.focus({ preventScroll: true });
        const panel = document.getElementById('workspace-scene-panel');
        if (panel && scenes.length) { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `scene-tab-${state.sceneID}`); }
        else if (panel) { panel.removeAttribute('role'); panel.removeAttribute('aria-labelledby'); }
        host.hidden = state.categoryID === null || (!scenes.length && !canManage(state) && status.hidden);
        tabs.hidden = !scenes.length;
        actions.hidden = !canManage(state);
        create.hidden = !canManage(state); create.disabled = busy || state.loading;
        edit.hidden = !canManage(state) || !state.sceneID; edit.disabled = busy || state.loading;
        makeDefault.hidden = !canManage(state) || !scenes.some(scene => Number(scene.ID) === Number(state.sceneID) && !scene.isDefault);
        makeDefault.disabled = busy || state.loading;
        if (scenes.length) refreshTabs();
        else syncOverflow();
        document.body.classList.toggle('bp-no-template-context', !scenes.length);
        if (dialog.open && scope !== identity() && !busy) dialog.close();
    }
    return { render };
}
