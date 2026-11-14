import { setTopicVisibility } from './topic-actions.js';
import { setLoading, setButtonLoading } from './loading.js';
import { postJSON, postWriteJSON } from './http.js';
import { pageAccountWriteScope } from './account-identity.js';
import { createAction } from './ui-components.js';

const element = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};
const messages = {
    public_topic_limit: 'You can have up to three public topics at a time. Make one private before publishing another.',
    private_topic_reference_not_public: 'This topic references another private topic. Publish or remove that reference first.',
    make_topic_private_before_deleting: 'Make this topic private before deleting it.',
    private_topic_changed: 'This topic changed in another tab. Your draft is kept. Close and reopen the editor to review the latest version.',
    private_topic_not_found: 'This private topic is no longer available.',
    topic_name_or_scene_exists: 'A topic or scene with this name already exists. Choose a different name.',
    topic_name_exists: 'A topic with this name already exists. Choose a different name.',
    topic_scene_exists: 'Each scene needs a different name and URL.',
    topic_scene_default_required: 'Choose one default scene.',
    reserved_topic_name: 'This topic name is reserved. Choose another name.',
    topic_creation_limit: 'You have reached the daily topic creation limit. Try again later.',
    authentication_required: 'Sign in before saving a private topic.',
    account_changed: 'Your account changed. Refresh this page before saving.',
    account_identity_required: 'Your account changed. Refresh this page before saving.'
};
let activeEditor;
export function openPrivateTopicEditor(categoryID = null, trigger) {
    return activeEditor?.open(categoryID, trigger);
}

export function createPrivateTopicEditor({ beforeOpen = async () => true, onSaved = async () => {}, onDeleted = async () => {} } = {}) {
    const dialog = document.getElementById('create-topic-dialog') ?? element('dialog', '');
    dialog.id = 'create-topic-dialog'; dialog.className = 'bp-topic-editor';
    dialog.setAttribute('aria-labelledby', 'create-topic-title');
    dialog.innerHTML = `<form id="create-topic-form">
        <header><h2 id="create-topic-title">New private topic</h2><button type="button" data-close-create aria-label="Close topic editor"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></header>
        <p class="bp-topic-editor-hint">Create and publish immediately. No review required.</p>
        <label>Name<input id="new-topic-name" required maxlength="128" autocomplete="off"></label>
        <label>One-sentence summary<input id="new-topic-description" required maxlength="180" autocomplete="off"></label>
        <section class="bp-topic-scenes-editor" aria-labelledby="topic-scenes-title">
            <div class="bp-topic-editor-section-heading"><h3 id="topic-scenes-title">Scenes</h3><button id="topic-editor-add-scene" type="button"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add scene</button></div>
            <p class="bp-topic-editor-hint">Optional. Choose a default scene; it opens when someone visits the topic. Leave a scene summary empty to follow the topic summary.</p>
            <div id="topic-editor-scenes"></div><p id="topic-editor-scene-note" class="bp-topic-editor-hint"></p>
        </section>
        <p id="create-topic-status" role="status" hidden></p>
        <div id="topic-editor-delete-confirmation" hidden><p>Delete this private topic and all its saved scene weights?</p><p id="topic-editor-delete-impact"></p><button id="topic-editor-confirm-delete" type="button">Delete topic</button><button id="topic-editor-cancel-delete" type="button">Keep topic</button></div>
        <footer><button id="topic-editor-delete" type="button" hidden>Delete topic</button><button type="button" id="topic-editor-publish" hidden>Make public</button><span class="bp-topic-editor-spacer"></span><button type="button" data-close-create>Cancel</button><button id="create-topic-submit" class="bp-topic-editor-primary" type="submit">Save topic</button></footer>
    </form>`;
    if (!dialog.isConnected) document.body.append(dialog);
    const $ = selector => dialog.querySelector(selector), form = $('#create-topic-form');
    const name = $('#new-topic-name'), description = $('#new-topic-description'), status = $('#create-topic-status');
    const sceneList = $('#topic-editor-scenes'), submit = $('#create-topic-submit');
    let topic = null, scenes = [], defaultKey = null, busy = false, ready = false, owner = null, sequence = 0, trigger = null, savedDraft = '';
    const payload = () => ({ ...(topic ? { categoryID: topic.ID, expectedRevision: topic.editRevision } : {}),
        name: name.value, description: description.value, scenes: scenes.map(({ key, ID, name }) => ({ key, ID, name })), defaultSceneKey: defaultKey });
    const message = value => { status.textContent = value; status.hidden = !value; };
    const report = error => message(messages[error.payload?.error] ?? error.message ?? 'Could not save this topic. Your draft is kept.');
    function setBusy(value, action = 'save') {
        busy = value; form.setAttribute('aria-busy', String(value));
        form.querySelectorAll('input,button').forEach(node => { node.disabled = value || node.dataset.unavailable === 'true'; });
        submit.disabled = value || !ready;
        setButtonLoading(submit, false);
        submit.textContent = topic ? 'Save changes' : 'Create private topic';
        setButtonLoading(submit, value && ready && action === 'save', 'Saving topic');
        setButtonLoading($('#topic-editor-confirm-delete'), value && action === 'delete', 'Deleting topic');
        $('#topic-editor-add-scene').disabled = value || scenes.length >= 512;
    }
    const action = (label, icon, handler) => {
        const button = createAction({ label, icon: 'fa-solid fa-' + icon, iconOnly: true, variant: 'quiet' });
        button.addEventListener('click', handler); return button;
    };
    function renderScenes(focusKey = null) {
        sceneList.replaceChildren();
        scenes.forEach((scene, index) => {
            const row = element('div', 'bp-topic-scene-row'); row.dataset.sceneKey = scene.key;
            const radio = element('input', ''); radio.type = 'radio'; radio.name = 'default-scene'; radio.checked = scene.key === defaultKey;
            radio.setAttribute('aria-label', 'Default scene: ' + (scene.name || 'Untitled'));
            radio.addEventListener('change', () => { defaultKey = scene.key; });
            const fields = element('div', 'bp-topic-scene-fields');
            const sceneName = element('input', ''); sceneName.required = true; sceneName.maxLength = 128; sceneName.placeholder = 'Scene name'; sceneName.value = scene.name;
            sceneName.setAttribute('aria-label', 'Scene name ' + (index + 1));
            sceneName.addEventListener('input', () => { scene.name = sceneName.value; radio.setAttribute('aria-label', 'Default scene: ' + (scene.name || 'Untitled')); });
            fields.append(sceneName);
            const controls = element('div', 'bp-topic-scene-actions');
            for (const [step, label, icon] of [[-1, 'Move scene up', 'arrow-up'], [1, 'Move scene down', 'arrow-down']]) {
                const button = action(label, icon, () => { [scenes[index], scenes[index + step]] = [scenes[index + step], scenes[index]]; renderScenes(scene.key); });
                button.disabled = index + step < 0 || index + step >= scenes.length;
                button.dataset.unavailable = String(button.disabled); controls.append(button);
            }
            controls.append(action('Remove scene', 'trash-can', () => {
                scenes = scenes.filter(item => item !== scene);
                if (defaultKey === scene.key) defaultKey = scenes[0]?.key ?? null;
                renderScenes(scenes[Math.min(index, scenes.length - 1)]?.key);
            }));
            row.append(radio, fields, controls); sceneList.append(row);
            if (focusKey === scene.key) sceneName.focus();
        });
        $('#topic-editor-add-scene').disabled = scenes.length >= 512;
        const removed = (topic?.scenes ?? []).filter(scene => !scenes.some(item => item.ID === scene.ID));
        $('#topic-editor-scene-note').textContent = !scenes.length
            ? topic?.scenes.length ? 'With no scenes, the current default scene’s saved weights become the topic’s weights. Other removed scenes lose their saved weights.' : 'This topic will have one weight configuration.'
            : !topic?.scenes.length ? 'Existing topic weights will move into the default scene. Other scenes start empty.'
                : removed.length ? 'Removed scenes lose their saved weights when you save. References to them become unavailable.' : '';
    }
    $('#topic-editor-add-scene').addEventListener('click', () => {
        if (busy || scenes.length >= 512) return;
        const scene = { key: 'new-' + globalThis.crypto.randomUUID(), ID: null, name: '' };
        scenes.push(scene); defaultKey ??= scene.key; renderScenes(scene.key);
    });
    for (const close of dialog.querySelectorAll('[data-close-create]')) close.addEventListener('click', () => { if (!busy) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { sequence++; trigger?.focus({ preventScroll: true }); });
    $('#topic-editor-delete').addEventListener('click', () => {
        $('#topic-editor-delete-impact').textContent = 'Other users can no longer open this topic or its scenes.';
        $('#topic-editor-delete-confirmation').hidden = false; $('#topic-editor-cancel-delete').focus();
    });
    $('#topic-editor-cancel-delete').addEventListener('click', () => { $('#topic-editor-delete-confirmation').hidden = true; $('#topic-editor-delete').focus(); });
    $('#topic-editor-publish').addEventListener('click', async () => {
        if (busy || !topic) return;
        if (JSON.stringify(payload()) !== savedDraft) { message('Save your changes before changing visibility.'); return; }
        message(''); setBusy(true, 'publish');
        try {
            const result = await setTopicVisibility(topic, topic.isPrivate);
            topic = result;
            dialog.close(); await onSaved(result);
        } catch (error) { report(error); }
        finally { setBusy(false); }
    });
    async function write(path, body) {
        if (pageAccountWriteScope.capture() !== owner) throw new Error('Your account changed. Refresh before saving.');
        const security = await postJSON('/api/get_privacy_status', {}, { timeoutMs: 15000, requireJSON: true });
        return pageAccountWriteScope.write((url, request) => postWriteJSON(url, request, { timeoutMs: 30000 }), path, { ...body, csrfToken: security.csrfToken });
    }
    form.addEventListener('submit', async event => {
        event.preventDefault(); if (busy || !ready || !form.reportValidity()) return;
        message(''); setBusy(true);
        try {
            const result = await write('/api/save_private_topic', payload());
            if (!Number.isSafeInteger(result?.ID) || typeof result.isPrivate !== 'boolean' || typeof result.editRevision !== 'string') throw new Error('The saved topic could not be confirmed. Retry to check the same request.');
            dialog.close(); await onSaved(result);
        } catch (error) { report(error); }
        finally { setBusy(false); }
    });
    $('#topic-editor-confirm-delete').addEventListener('click', async () => {
        if (busy || !topic) return;
        message(''); setBusy(true, 'delete');
        try {
            const result = await write('/api/delete_private_topic', { categoryID: topic.ID, expectedRevision: topic.editRevision });
            if (!result?.deleted || result.categoryID !== topic.ID) throw new Error('Deletion could not be confirmed. Retry to check the same request.');
            dialog.close(); await onDeleted(result);
        } catch (error) { report(error); }
        finally { setBusy(false); }
    });
    async function open(categoryID = null, source = document.activeElement) {
        if (busy || !await beforeOpen()) return;
        trigger = source; const request = ++sequence;
        message(''); $('#topic-editor-delete-confirmation').hidden = true;
        try { owner = pageAccountWriteScope.capture(); }
        catch { message('Sign in to manage private topics.'); owner = null; }
        topic = null; scenes = []; defaultKey = null; ready = owner !== null && categoryID === null; form.reset(); renderScenes();
        $('#create-topic-title').textContent = categoryID === null ? 'New private topic' : 'Edit private topic';
        $('#topic-editor-delete').hidden = $('#topic-editor-publish').hidden = true;
        if (!dialog.open) dialog.showModal();
        if (!owner) {
            const link = element('a', '', 'Sign in'); link.href = '/login'; status.append(document.createTextNode(' '), link); setBusy(false); return;
        }
        if (categoryID !== null) {
            setBusy(true); status.hidden = false; setLoading(status, 'Loading topic');
            try {
                const result = await postJSON('/api/get_private_topic_editor', { categoryID }, { timeoutMs: 20000, requireJSON: true });
                if (request !== sequence || pageAccountWriteScope.capture() !== owner) return;
                topic = result; ready = true; name.value = topic.name; description.value = topic.description;
                scenes = topic.scenes.map(scene => ({ key: String(scene.ID), ID: scene.ID, name: scene.name }));
                defaultKey = topic.scenes.find(scene => scene.isDefault)?.ID?.toString() ?? null;
                $('#topic-editor-delete').hidden = !topic.isPrivate;
                $('#topic-editor-publish').hidden = false;
                $('#topic-editor-publish').textContent = topic.isPrivate ? 'Make public' : 'Make private';
                $('#create-topic-title').textContent = topic.isPrivate ? 'Edit private topic' : 'Edit public topic';
                message(''); renderScenes();
            } catch (error) { report(error); return; }
            finally { setBusy(false); }
        }
        setBusy(false); savedDraft = JSON.stringify(payload()); name.focus();
    }
    activeEditor = { open };
    return activeEditor;
}
