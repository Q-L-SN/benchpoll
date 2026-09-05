import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const getFlagValue = flag => {
    const index = args.indexOf(flag);
    return index === -1 || index === args.length - 1 ? null : args[index + 1];
};
const sourcePath = path.resolve(getFlagValue('--source') ?? 'data/eval-items-2025-plus.json');
const checkDataOnly = args.includes('--check-data');
const allowedArguments = new Set(['--source', '--check-data']);
for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowedArguments.has(argument)) {
        throw new Error(
            `Unsupported argument ${argument}. Database import was retired with the old vote-based data model.`
        );
    }
    if (argument === '--source') index += 1;
}

const allowedModalities = new Set([
    'text', 'image', 'audio', 'video', 'mixed', 'other', 'action', null
]);

function fail(message) {
    console.error(message);
    process.exit(1);
}

function loadData() {
    if (!fs.existsSync(sourcePath)) {
        fail(`Seed file not found: ${sourcePath}`);
    }
    const data = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    if (!Array.isArray(data.items)) {
        fail('Seed file must contain an items array.');
    }
    const names = new Set();
    for (const [index, item] of data.items.entries()) {
        const label = `items[${index}]`;
        if (!item.name || typeof item.name !== 'string' || item.name.length > 128) {
            fail(`${label}.name must be a non-empty string up to 128 characters.`);
        }
        if (names.has(item.name)) {
            fail(`Duplicate item name: ${item.name}`);
        }
        names.add(item.name);
        if (!item.url || typeof item.url !== 'string' || item.url.length > 512) {
            fail(`${label}.url must be a non-empty string up to 512 characters.`);
        }
        if (!item.categoryPath || typeof item.categoryPath !== 'string') {
            fail(`${label}.categoryPath must be a non-empty string.`);
        }
        if (!allowedModalities.has(item.inputModality ?? null)) {
            fail(`${label}.inputModality is invalid.`);
        }
        if (!allowedModalities.has(item.outputModality ?? null)) {
            fail(`${label}.outputModality is invalid.`);
        }
    }
    return data;
}

function categorySummary(items) {
    const counts = new Map();
    for (const item of items) {
        counts.set(item.categoryPath, (counts.get(item.categoryPath) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const data = loadData();
console.log(`Validated ${data.items.length} legacy research records from ${sourcePath}`);
for (const [category, count] of categorySummary(data.items)) {
    console.log(`${String(count).padStart(3, ' ')}  ${category}`);
}

if (!checkDataOnly) {
    fail(
        'Database import was removed because this legacy dataset has no evaluation profiles, '
        + 'score semantics, or global evaluation identity. Submit normalized evaluation contributions instead.'
    );
}
