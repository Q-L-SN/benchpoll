#!/usr/bin/env node

import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { initPool, pool } from '../db.js';
import { listComparisonProfiles, saveComparisonProfile, deleteComparisonProfile } from '../comparison-profiles.js';

const userID = Number(process.argv.find(arg => arg.startsWith('--user-id='))?.slice(10));
if (!Number.isSafeInteger(userID) || userID < 1 || process.argv.slice(2).some(arg => !arg.startsWith('--user-id='))) {
    throw Error('Usage: node scripts/verify-comparison-profiles.mjs --user-id=<existing-user-ID>');
}

initPool(process.env.DB_PASSWORD);
const name = `Verification ${randomUUID()}`;
const comparison = { mode: 'best', keys: ['model'], filters: [] };
let created = false;
try {
    await saveComparisonProfile(pool, userID, { name, comparison });
    created = true;
    const profiles = await listComparisonProfiles(pool, userID);
    assert.deepEqual(profiles.profiles.find(profile => profile.name === name)?.comparison, comparison);
    console.log('Comparison profile account persistence passed.');
} finally {
    try {
        if (created) await deleteComparisonProfile(pool, userID, name);
    } finally {
        await pool.end();
    }
}
