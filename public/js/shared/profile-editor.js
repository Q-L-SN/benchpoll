import { setButtonLoading } from './loading.js';
import { postJSON } from './http.js';
import { pageAccountWriteScope, isAccountWriteError } from './account-identity.js';
import { createAction } from './ui-components.js';

const MAX_PROFILE_BYTES = 300 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
let activeEditor = null;
let sequence = 0;

export function profileDisplayName(value) {
    if (typeof value !== 'string' || value.length > 240
        || /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value)) return null;
    const name = value.normalize('NFC').trim();
    return name && [...name].length <= 60 && name.replace(/[\p{Cf}\p{M}\s]/gu, '') ? name : null;
}

export function profileAvatarURL(value) {
    if (typeof value !== 'string') return '';
    if (value.length <= MAX_PROFILE_BYTES && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
    if (value.length > 2048) return '';
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'avatars.githubusercontent.com'
            && !url.username && !url.password && !url.port ? url.href : '';
    } catch { return ''; }
}

export function rasterUploadType(bytes) {
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.length >= 16 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
        && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
        && ['VP8 ', 'VP8L', 'VP8X'].includes(String.fromCharCode(...bytes.subarray(12, 16)))) return 'image/webp';
    return null;
}

const aborted = () => new globalThis.DOMException('The image upload was cancelled.', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw aborted(); };

async function rasterImage(bytes, mime, signal) {
    checkAbort(signal);
    const dataURL = await new Promise((resolve, reject) => {
        const reader = new globalThis.FileReader();
        const stop = () => reader.abort();
        const cleanup = () => signal?.removeEventListener('abort', stop);
        reader.onload = () => { cleanup(); resolve(reader.result); };
        reader.onerror = () => { cleanup(); reject(new Error('The image could not be read.')); };
        reader.onabort = () => { cleanup(); reject(aborted()); };
        signal?.addEventListener('abort', stop, { once: true });
        reader.readAsDataURL(new globalThis.Blob([bytes], { type: mime }));
    });
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const image = new globalThis.Image();
        let timer;
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); image.onload = image.onerror = null; };
        const stop = () => { cleanup(); image.src = ''; reject(aborted()); };
        image.onload = () => { cleanup(); resolve(image); };
        image.onerror = () => { cleanup(); reject(new Error('Choose a valid PNG, JPEG or WebP image.')); };
        signal?.addEventListener('abort', stop, { once: true });
        timer = setTimeout(() => { cleanup(); image.src = ''; reject(new Error('The image took too long to load.')); }, 15000);
        image.src = dataURL;
    });
}

function canvasPNG(value) {
    const prefix = 'data:image/png;base64,';
    if (!value.startsWith(prefix)) throw new Error('The image could not be processed.');
    const bytes = Uint8Array.from(globalThis.atob(value.slice(prefix.length)), char => char.charCodeAt(0));
    if (rasterUploadType(bytes) !== 'image/png') throw new Error('The image could not be processed.');
    const view = new DataView(bytes.buffer);
    const chunks = [bytes.subarray(0, 8)];
    // Canvas is sRGB by default; strip browser-added ICC/ancillary metadata before storage.
    for (let offset = 8; offset < bytes.length;) {
        if (offset + 12 > bytes.length) throw new Error('The image could not be processed.');
        const end = offset + view.getUint32(offset) + 12;
        if (end > bytes.length) throw new Error('The image could not be processed.');
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (['IHDR', 'IDAT', 'IEND'].includes(type)) chunks.push(bytes.subarray(offset, end));
        else if (!(bytes[offset + 4] & 32)) throw new Error('The image could not be processed.');
        offset = end;
    }
    const binary = [];
    for (const chunk of chunks) for (let offset = 0; offset < chunk.length; offset += 8192) {
        binary.push(String.fromCharCode(...chunk.subarray(offset, offset + 8192)));
    }
    return prefix + globalThis.btoa(binary.join(''));
}

export async function prepareProfileAvatar(file, { signal } = {}) {
    checkAbort(signal);
    if (!file || !file.size || file.size > MAX_UPLOAD_BYTES) throw new Error('Choose an image smaller than 10 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    checkAbort(signal);
    const mime = rasterUploadType(bytes);
    if (!mime || (file.type && file.type !== mime)) throw new Error('Choose a valid PNG, JPEG or WebP image.');
    const image = await rasterImage(bytes, mime, signal);
    checkAbort(signal);
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || width > 8192 || height > 8192 || width * height > 32 * 1024 * 1024) {
        throw new Error('Choose an image no larger than 8192 pixels per side and 32 megapixels.');
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image processing is unavailable in this browser.');
    const side = Math.min(width, height);
    for (const size of [Math.min(256, side), 224, 192, 160, 128].filter((size, index, sizes) => size > 0
        && (index === 0 || size < sizes[0]))) {
        checkAbort(signal);
        canvas.width = canvas.height = size;
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
        const value = canvasPNG(canvas.toDataURL('image/png'));
        if (value.length < MAX_PROFILE_BYTES - 2048) return value;
    }
    throw new Error('The cropped image is too large. Choose a smaller image.');
}

function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
}

function ensureStyles() {
    if (document.querySelector('link[data-bp-profile-editor]')) return;
    const link = element('link');
    link.rel = 'stylesheet';
    link.href = new URL('../../css/ui/profile-editor.css', import.meta.url).href;
    link.dataset.bpProfileEditor = '';
    document.head.append(link);
}

function saveError(error) {
    if (isAccountWriteError(error)) return error.message;
    const code = error?.payload?.error;
    const messages = {
        profile_display_name_invalid: 'Enter a display name with 1 to 60 characters and no control characters.',
        profile_avatar_invalid: 'The image could not be verified. Choose the image again.',
        profile_payload_too_large: 'The image is too large. Choose a smaller image.',
        profile_account_unavailable: 'This account cannot update its public profile.',
        authentication_required: 'Sign in again before saving your profile.'
    };
    return messages[code] || (error?.status === 401 ? 'Sign in again before saving your profile.'
        : error?.status >= 500 ? 'Your profile could not be saved. Your changes are kept; try again.'
            : error?.message || 'Your profile could not be saved. Try again.');
}

// Resolves with the effective profile after saving, or null after local dismissal.
export async function openProfileEditor({ profile, onSaved } = {}) {
    pageAccountWriteScope.bind(profile?.userID);
    const owner = pageAccountWriteScope.capture();
    if (activeEditor) { activeEditor.dialog.focus(); return activeEditor.result; }
    ensureStyles();
    const trigger = document.activeElement;
    const id = `bp-profile-editor-${++sequence}`;
    const dialog = element('dialog', 'bp-profile-editor');
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    const form = element('form', 'bp-profile-editor-form');
    form.noValidate = true;
    const header = element('header', 'bp-profile-editor-header');
    const title = element('h2', '', 'Public profile');
    title.id = `${id}-title`;
    const close = createAction({ label: 'Close profile editor', icon: 'fa-solid fa-xmark', iconOnly: true });
    header.append(title, close);

    const avatarRow = element('div', 'bp-profile-editor-avatar-row');
    const preview = element('div', 'bp-profile-editor-preview');
    const picture = element('img');
    picture.width = picture.height = 96;
    picture.alt = 'Avatar preview';
    picture.referrerPolicy = 'no-referrer';
    const initial = element('span', 'bp-profile-editor-initial');
    initial.setAttribute('aria-hidden', 'true');
    picture.addEventListener('error', () => { picture.hidden = true; initial.hidden = false; });
    preview.append(picture, initial);
    const avatarControls = element('div', 'bp-profile-editor-avatar-controls');
    const fileLabel = element('label', '', 'Avatar');
    const file = element('input');
    file.type = 'file';
    file.accept = 'image/png,image/jpeg,image/webp';
    file.id = `${id}-file`;
    fileLabel.htmlFor = file.id;
    const reset = createAction({ label: 'Reset avatar', icon: 'fa-solid fa-arrow-rotate-left' });
    avatarControls.append(fileLabel, file, reset);
    avatarRow.append(preview, avatarControls);

    const nameField = element('div', 'bp-profile-editor-name');
    const nameLabel = element('label', '', 'Display name');
    const name = element('input', 'bp-ui-input');
    name.id = `${id}-name`;
    name.name = 'displayName';
    name.type = 'text';
    name.autocomplete = 'nickname';
    name.value = typeof profile.userName === 'string' ? profile.userName : '';
    name.maxLength = Math.max(240, name.value.length);
    nameLabel.htmlFor = name.id;
    const count = element('output', 'bp-profile-editor-count');
    count.htmlFor = name.id;
    count.setAttribute('aria-label', 'Display name character count');
    const nameHeader = element('div', 'bp-profile-editor-name-header');
    nameHeader.append(nameLabel, count);
    nameField.append(nameHeader, name);
    const status = element('p', 'bp-profile-editor-status');
    status.id = `${id}-status`;
    status.setAttribute('role', 'alert');
    name.setAttribute('aria-describedby', status.id);
    file.setAttribute('aria-describedby', status.id);
    const actions = element('footer', 'bp-profile-editor-actions');
    const cancel = createAction({ label: 'Cancel' });
    const save = createAction({ label: 'Save', icon: 'fa-solid fa-check', variant: 'primary' });
    save.type = 'submit';
    actions.append(cancel, save);
    form.append(header, avatarRow, nameField, status, actions);
    dialog.append(form);

    let finishResult;
    const result = new Promise(resolve => { finishResult = resolve; });
    let closed = false, saving = false, processing = false, avatarChanged = false;
    let avatar = profile.userProfilePictureURL, uploadSequence = 0;
    let uploadController = null, saveController = null;
    const sameName = () => name.value.normalize('NFC').trim() === (profile.userName ?? '').normalize('NFC').trim();
    const showAvatar = value => {
        const url = profileAvatarURL(value);
        initial.textContent = [...name.value.trim()][0]?.toLocaleUpperCase() || '?';
        initial.hidden = Boolean(url);
        picture.hidden = !url;
        if (url) picture.src = url;
        else picture.removeAttribute('src');
    };
    const sync = () => {
        const valid = sameName() || profileDisplayName(name.value) !== null;
        count.value = `${[...name.value.normalize('NFC').trim()].length} / 60`;
        name.setAttribute('aria-invalid', String(!valid));
        save.disabled = saving || processing || !valid || (sameName() && !avatarChanged);
        name.disabled = file.disabled = saving;
        reset.disabled = saving || (!processing && avatar === null)
            || (!processing && !avatarChanged && !profile.hasCustomAvatar);
        form.setAttribute('aria-busy', String(saving || processing));
        setButtonLoading(save, saving || processing, processing ? 'Processing profile picture' : 'Saving profile');
        initial.textContent = [...name.value.trim()][0]?.toLocaleUpperCase() || '?';
    };
    const finish = value => {
        if (closed) return;
        closed = true;
        uploadSequence++;
        uploadController?.abort();
        saveController?.abort();
        if (dialog.open) dialog.close();
        dialog.remove();
        activeEditor = null;
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        finishResult(value);
    };
    close.addEventListener('click', () => finish(null));
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.addEventListener('close', () => finish(null));
    dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') event.stopPropagation();
        if (event.key !== 'Tab') return;
        event.stopPropagation();
        const items = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)')]
            .filter(item => item.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    name.addEventListener('input', () => {
        status.textContent = sameName() || profileDisplayName(name.value) !== null ? ''
            : 'Enter a display name with 1 to 60 characters and no control characters.';
        sync();
    });
    reset.addEventListener('click', () => {
        uploadSequence++;
        uploadController?.abort();
        processing = false;
        avatarChanged = true;
        avatar = null;
        file.value = '';
        status.textContent = '';
        showAvatar(profile.defaultUserProfilePictureURL ?? (!profile.hasCustomAvatar ? profile.userProfilePictureURL : null));
        sync();
    });
    file.addEventListener('change', async () => {
        const selected = file.files?.[0];
        if (!selected || saving || closed) return;
        const token = ++uploadSequence;
        uploadController?.abort();
        uploadController = new globalThis.AbortController();
        processing = true;
        status.textContent = '';
        file.setAttribute('aria-invalid', 'false');
        sync();
        try {
            const value = await prepareProfileAvatar(selected, { signal: uploadController.signal });
            if (closed || token !== uploadSequence) return;
            avatar = value;
            avatarChanged = true;
            showAvatar(value);
        } catch (error) {
            if (!closed && token === uploadSequence && error.name !== 'AbortError') {
                status.textContent = error.message;
                file.setAttribute('aria-invalid', 'true');
            }
        } finally {
            if (!closed && token === uploadSequence) { processing = false; file.value = ''; sync(); }
        }
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (saving || processing || closed || save.disabled) return;
        const body = {};
        if (!sameName()) {
            const value = profileDisplayName(name.value);
            if (value === null) { status.textContent = 'Enter a display name with 1 to 60 characters.'; name.focus(); return; }
            body.displayName = value;
        }
        if (avatarChanged) body.avatar = avatar;
        saving = true;
        status.textContent = '';
        sync();
        saveController = new globalThis.AbortController();
        try {
            const saved = await pageAccountWriteScope.write((path, payload) => postJSON(path, payload,
                { signal: saveController.signal, timeoutMs: 20000, requireJSON: true }), '/api/save_user_profile', body);
            if (closed) return;
            if (saved?.userID !== owner || typeof saved.userName !== 'string'
                || typeof saved.hasCustomDisplayName !== 'boolean' || typeof saved.hasCustomAvatar !== 'boolean') {
                throw new Error('The saved profile could not be confirmed. Your changes are kept; try again.');
            }
            finish(saved);
            document.dispatchEvent(new CustomEvent('benchpoll:profile-updated', { detail: saved }));
            try { await onSaved?.(saved); }
            catch (error) { console.error('Profile saved, but its view could not be refreshed.', error); }
        } catch (error) {
            if (!closed) status.textContent = saveError(error);
        } finally {
            if (!closed) { saving = false; sync(); }
        }
    });
    activeEditor = { dialog, result };
    document.body.append(dialog);
    showAvatar(avatar);
    sync();
    try { dialog.showModal(); name.focus({ preventScroll: true }); }
    catch (error) { finish(null); throw error; }
    return result;
}
