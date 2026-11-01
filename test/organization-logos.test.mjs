import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ORGANIZATION_LOGOS, organizationLogo } from '../public/js/shared/organization-logos.js';

const sources = JSON.parse(readFileSync(new URL('../public/assets/vendors/sources.json', import.meta.url), 'utf8'));
const code = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('all registered organizations resolve to cache-versioned local artwork with recorded hashes', () => {
    assert.equal(sources.length, Object.keys(ORGANIZATION_LOGOS).length);
    assert.equal(new Set(sources.map(source => source.key)).size, sources.length);
    for (const [key, file] of Object.entries(ORGANIZATION_LOGOS)) {
        assert.match(file, /^[a-z0-9-]+\.(?:svg|png|webp|jpg)$/);
        assert.deepEqual(organizationLogo(key), { key, url: `/assets/vendors/${file}?v=organization-logos-20261006` });
        const source = sources.find(source => source.key === key);
        assert.equal(source.file, file);
        const bytes = readFileSync(new URL('../public/assets/vendors/' + file, import.meta.url));
        assert.equal(bytes.length, source.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
        assert.ok(source.license && source.evidence);
        assert.equal(Boolean(source.url && /gravatar\.com|identicon|[?&]d=retro/i.test(source.url)), false, `${key}: no generated placeholder as brand artwork`);
    }
});

test('organization aliases cover Z AI, Zhipu and vendor metadata used by each page', () => {
    for (const [value, key] of [
        ['智谱', 'zhipu'], ['智谱AI', 'zhipu'], ['Zhipu AI', 'zhipu'], ['z-ai', 'zai'], ['Z.AI', 'zai'],
        ['google-alt', 'google'], ['Google DeepMind', 'google'], ['microsoft-ai', 'microsoft'],
        ['moonshot-ai', 'moonshot'], ['MiniMax', 'minimax'], ['AI2', 'allenai'],
        ['shanghai-ai-lab', 'internlm'], ['Shengshu', 'vidu'], ['PLAYGROUND AI', 'playground-ai']
    ]) {
        for (const attribute of ['logoKey', 'vendorLogoKey', 'vendorSlug', 'slug', 'vendorName', 'vendor', 'name']) {
            assert.equal(organizationLogo({ [attribute]: value })?.key, key, `${attribute}: ${value}`);
        }
    }
    assert.equal(organizationLogo({ logoKey: null, slug: 'z-ai', name: 'Z AI' }).key, 'zai');
    assert.equal(organizationLogo({ logoKey: 'unregistered', vendorSlug: 'anthropic' }).key, 'anthropic');
    assert.equal(organizationLogo({ vendorSlug: 'anthropic', name: 'OpenAI' }).key, 'anthropic');
});

test('missing, unattributed and lookalike identities never borrow an organization logo', () => {
    for (const value of [undefined, null, {}, '', 'openai-clone', 'The Google fan club', 'arena-unattributed',
        'https://example.com/openai.svg', '../openai', '<svg onload="alert(1)">', { name: 'Thinky' },
        { vendorSlug: 'unknown', logoKey: 'data:image/svg+xml;base64,bad' }]) {
        assert.equal(organizationLogo(value), null);
    }
});

test('SVG marks are actual vector artwork without script, embedded bitmaps or external dependencies', () => {
    for (const file of Object.values(ORGANIZATION_LOGOS).filter(file => file.endsWith('.svg'))) {
        const svg = code('public/assets/vendors/' + file);
        assert.match(svg, /<svg\b/);
        assert.match(svg, /viewBox=/);
        assert.equal(/<(?:script|foreignObject|image)\b|\bon[a-z]+=|<!DOCTYPE|<!ENTITY/i.test(svg), false, file);
        assert.equal(/(?:href\s*=\s*["'](?!#)|url\(\s*["']?(?!#)[a-z])/i.test(svg), false, file);
    }
});

test('ranking, benchmark scores and forms use one organization registry', () => {
    for (const path of ['public/js/workspace/model-list.js', 'public/js/workspace/benchmark-scores.js', 'public/js/contribute.js']) {
        const source = code(path);
        assert.match(source, /import \{ createOrganizationMark \} from ['"].*shared\/organization-logos\.js\?v=organization-logos-20261006/);
        assert.doesNotMatch(source, /\/assets\/vendors\/|knownVendorLogos|vendorLogoURL/);
    }
});

test('new registry does not turn broken known logos into silently hidden errors', () => {
    const source = code('public/js/shared/organization-logos.js');
    assert.match(source, /image\.alt = ''/);
    assert.match(source, /image\.style\.colorScheme = 'light'/);
    assert.doesNotMatch(source, /onerror|addEventListener\(['"]error|\.catch\(/);
    assert.match(code('private/home.html'), /\/js\/home-workspace\.js\?v=[^"\s]+/);
    assert.match(code('private/contribute.html'), /\/js\/contribute\.js\?v=[^"\s]+/);
});
