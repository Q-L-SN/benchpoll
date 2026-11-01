import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { modelBarColor, modelBarTextColor } from '../public/js/workspace/score-colors.js';

test('creator colors use the established readable palette in both score views', () => {
    assert.notEqual(modelBarColor({ vendorSlug: 'openai' }), modelBarColor({ vendorSlug: 'anthropic' }));
    assert.equal(modelBarColor({}), '#64707d');
    for (const vendorSlug of ['openai', 'anthropic', 'google', 'meta', 'mistral', 'deepseek', 'qwen'])
        assert.equal(modelBarTextColor(modelBarColor({ vendorSlug })), '#ffffff');
});
test('fixed creator colors no longer mount controls or read per-user color preferences', async () => {
    const colors = await readFile(new URL('../public/js/workspace/score-colors.js', import.meta.url), 'utf8');
    const workspace = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
    assert.doesNotMatch(colors, /localStorage|createAction|MutationObserver|initializeScoreColors|dataset/);
    assert.doesNotMatch(workspace, /initializeScoreColors/);
});
test('creator-color rules are unconditional and preserve outside black labels', async () => {
    const css = await readFile(new URL('../public/css/ui/score-colors.css', import.meta.url), 'utf8');
    const shared = await readFile(new URL('../public/css/ui/workspace.css', import.meta.url), 'utf8');
    assert.match(css, /background: var\(--score-vendor-color/);
    assert.match(shared, /data-bar-label-fallback="outside"[\s\S]*?color: #111/);
    assert.doesNotMatch(css, /data-score-colors|score-colors-toggle|score-title-tools/);
});
test('hyphenated provider slugs share their established creator colors', () => {
    assert.equal(modelBarColor({ vendorSlug: 'z-ai' }), modelBarColor({ vendorSlug: 'zhipu' }));
    assert.equal(modelBarColor({ vendorSlug: 'x-ai' }), modelBarColor({ vendorSlug: 'xai' }));
    assert.equal(modelBarColor({ vendorName: 'Google DeepMind' }), modelBarColor({ vendorSlug: 'google' }));
    assert.equal(modelBarColor({ vendorName: 'Alibaba Qwen' }), modelBarColor({ vendorSlug: 'alibaba' }));
});

test('unknown creators use a stable identity instead of model names or ranking order', () => {
    assert.equal(modelBarColor({ vendorID: 42, vendorName: 'Old name', name: 'Model A' }),
        modelBarColor({ vendor_ID: '00042', vendorSlug: 'new-name', name: 'Model B' }));
    assert.equal(modelBarColor({ vendorSlug: ' ACME-Labs ' }), modelBarColor({ vendorName: 'Acme Labs' }));
    assert.equal(modelBarColor({ vendorSlug: '', vendorName: 'Acme Labs' }), modelBarColor({ vendor: 'acme_labs' }));
    assert.equal(modelBarColor({ vendorName: 'Cohere' }), modelBarColor({ vendorSlug: 'cohere' }));
    assert.equal(modelBarColor({ vendorId: '900719925474099300' }), modelBarColor({ vendor_ID: '0900719925474099300' }));
    assert.equal(modelBarColor({ vendorID: NaN, vendorSlug: 'Acme' }), modelBarColor({ vendorSlug: 'Acme' }));
    assert.equal(modelBarColor({ vendorID: 9007199254740992, vendorSlug: 'Acme' }), modelBarColor({ vendorSlug: 'Acme' }));
    assert.equal(modelBarColor({ vendorID: '0', vendorName: 'Acme' }), modelBarColor({ vendorName: 'Acme' }));
    assert.equal(modelBarColor({ vendorID: '-1', vendorName: 'Acme' }), modelBarColor({ vendorName: 'Acme' }));
});

test('missing creator metadata stays neutral and partial brand names do not impersonate a brand', () => {
    assert.equal(modelBarColor(), '#64707d');
    assert.equal(modelBarColor({ name: 'OpenAI model', ID: 123, logoKey: 'openai' }), '#64707d');
    assert.equal(modelBarColor({ vendorName: '  ', vendorSlug: '' }), '#64707d');
    assert.notEqual(modelBarColor({ vendorSlug: 'openai-competitor' }), modelBarColor({ vendorSlug: 'openai' }));
});

test('every default color supports white score labels with at least 4.5:1 contrast', () => {
    const colors = new Set(Array.from({ length: 1000 }, (_, vendorID) => modelBarColor({ vendorID: vendorID + 1 })));
    colors.add(modelBarColor({}));
    assert.equal(colors.size, 13);
    for (const color of colors) {
        const channels = color.slice(1).match(/.{2}/g).map(channel => {
            const value = parseInt(channel, 16) / 255;
            return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
        });
        const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
        assert.ok(1.05 / (luminance + .05) >= 4.5, color);
        assert.equal(modelBarTextColor(color), '#ffffff');
    }
});
