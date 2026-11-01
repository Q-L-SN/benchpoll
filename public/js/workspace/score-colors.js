import { organizationLogo } from '../shared/organization-logos.js?v=organization-logos-20261006';

const COLORS = Object.freeze({
    anthropic: '#a85c40', openai: '#262626', google: '#287c51', meta: '#0971b8',
    deepseek: '#3469c7', mistral: '#9b5c00', alibaba: '#6550a0', qwen: '#6550a0',
    zhipu: '#246baa', zai: '#246baa', xai: '#53596b'
});
const DEFAULT_COLORS = Object.freeze([
    '#315ea8', '#2e6f5e', '#8b4964', '#795c32', '#47597e', '#9b452e',
    '#596b32', '#704b91', '#2b6d80', '#8d4c3c', '#6b5870', '#4c6a6b'
]);
const normalize = value => typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase().replace(/[\s._-]+/g, '') : '';

function organizationID(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return '';
    return value.trim().replace(/^0+/, '');
}

export function modelBarColor(model = {}) {
    const organization = organizationLogo({ vendorSlug: model.vendorSlug, vendorName: model.vendorName, vendor: model.vendor });
    if (organization && COLORS[organization.key]) return COLORS[organization.key];
    const id = [model.vendorID, model.vendorId, model.vendor_ID].map(organizationID).find(Boolean);
    const name = organization?.key || [model.vendorSlug, model.vendorName, model.vendor].map(normalize).find(Boolean);
    const identity = id ? `id:${id}` : name ? `name:${name}` : '';
    if (!identity) return '#64707d';
    // Stable identity hashing keeps colors independent of rank, view and model name.
    let hash = 2166136261;
    for (let index = 0; index < identity.length; index++) hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
    return DEFAULT_COLORS[(hash >>> 0) % DEFAULT_COLORS.length];
}

export function modelBarTextColor(color) {
    const channels = color.slice(1).match(/.{2}/g).map(channel => {
        const value = parseInt(channel, 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    return (luminance + .05) / .05 > 1.05 / (luminance + .05) ? '#000000' : '#ffffff';
}
