import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { profileDisplayName, profileAvatarURL, rasterUploadType, prepareProfileAvatar } from '../public/js/shared/profile-editor.js';
import { userDisplayName } from '../user-profile-service.js';

test('client/server name checks agree without excluding emoji joiners or Unicode names', () => {
    for (const input of ['Name', ' 中文 ', 'e\u0301', '👩‍💻', '😀'.repeat(60), '😀'.repeat(61),
        '', '\u200d', '\u0301', 'a\nb', '\ud800', 'x\u202ey', 5, null]) {
        let expected = null;
        try { expected = userDisplayName(input); } catch { /* Validation failure is represented as null in the editor. */ }
        assert.equal(profileDisplayName(input), expected);
    }
});

test('avatar rendering only permits bounded raster data and credential-free GitHub defaults', () => {
    assert.equal(profileAvatarURL('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
    assert.equal(profileAvatarURL('https://avatars.githubusercontent.com/u/1'), 'https://avatars.githubusercontent.com/u/1');
    for (const value of [null, {}, '/avatar.svg', 'javascript:alert(1)', 'blob:http://localhost/test',
        'data:image/svg+xml,<svg/>', 'https://evil.test/a.png', 'https://avatars.githubusercontent.com.evil.test/a.png',
        'http://avatars.githubusercontent.com/u/1', 'https://user:pass@avatars.githubusercontent.com/u/1',
        'https://avatars.githubusercontent.com:444/u/1', `data:image/png;base64,${'A'.repeat(300 * 1024)}`]) {
        assert.equal(profileAvatarURL(value), '');
    }
});

test('upload type is determined from raster magic, not a filename or claimed MIME', () => {
    assert.equal(rasterUploadType(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png');
    assert.equal(rasterUploadType(Uint8Array.from([255, 216, 255])), 'image/jpeg');
    for (const fourcc of ['VP8 ', 'VP8L', 'VP8X']) {
        assert.equal(rasterUploadType(Buffer.from(`RIFF0000WEBP${fourcc}`)), 'image/webp');
    }
    for (const bytes of [Buffer.from('<svg/>'), Buffer.from('GIF89a'), Buffer.from('RIFF0000WEBPTEST'), new Uint8Array()]) {
        assert.equal(rasterUploadType(bytes), null);
    }
});

test('invalid, oversized and already-cancelled uploads fail before browser decoding', async () => {
    await assert.rejects(prepareProfileAvatar({ size: 10 * 1024 * 1024 + 1 }), /smaller than 10 MB/);
    await assert.rejects(prepareProfileAvatar({ size: 0 }), /smaller than 10 MB/);
    await assert.rejects(prepareProfileAvatar({ size: 6, type: 'image/png', arrayBuffer: async () => Buffer.from('<svg/>') }), /valid PNG/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(prepareProfileAvatar(null, { signal: controller.signal }), { name: 'AbortError' });
});

test('editor uses native modality, shared transport, text-only rendering and document profile notifications', async () => {
    const source = await readFile(new URL('../public/js/shared/profile-editor.js', import.meta.url), 'utf8');
    assert.match(source, /dialog.showModal\(\)/);
    assert.match(source, /file.type = 'file'/);
    assert.match(source, /pageAccountWriteScope.write\(/);
    assert.match(source, /postJSON\(path, payload/);
    assert.match(source, /document.dispatchEvent\(new CustomEvent\('benchpoll:profile-updated'/);
    assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage|accountUserID|expectedUserID:|createObjectURL/);
    const discussion = await readFile(new URL('../public/js/discussion.js', import.meta.url), 'utf8');
    assert.match(discussion, /document.addEventListener\('benchpoll:profile-updated'/);
    assert.match(discussion, /post.isDeleted \? null/);
    assert.match(discussion, /avatar.referrerPolicy = 'no-referrer'/);
});
