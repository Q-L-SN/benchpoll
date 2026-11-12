const MAX_PROFILE_BYTES = 300 * 1024;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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
