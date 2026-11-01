import { createHash } from 'node:crypto';
import { familyKey, FALLBACK_RULE_MODE } from './public/js/shared/benchmark-families.js';

const hash = (primary, entries) => createHash('sha256').update(familyKey(primary, entries)).digest('hex');
const invalid = details => { throw { status: 409, body: { error: 'benchmark_family_invariant_failed', ...details } }; };

export function parseFamilyRows(rows) {
    const families = new Map();
    for (const row of rows) {
        const ID = Number(row.family_ID);
        const primaryConditionID = Number(row.primary_benchmark_condition_ID);
        if (!Number.isSafeInteger(ID) || ID < 1 || !Number.isSafeInteger(primaryConditionID) || primaryConditionID < 1) invalid({ familyID: ID });
        if (!families.has(ID)) families.set(ID, { familyID: ID, primaryConditionID, mode: FALLBACK_RULE_MODE,
            chainHash: row.chain_hash, entries: [] });
        const family = families.get(ID);
        if (family.primaryConditionID !== primaryConditionID || family.chainHash !== row.chain_hash
            || Number(row.position) !== family.entries.length + 1) invalid({ familyID: ID });
        family.entries.push({ conditionID: Number(row.fallback_benchmark_condition_ID) });
    }
    return [...families.values()].map(family => {
        try {
            if (!family.entries.length || hash(family.primaryConditionID, family.entries) !== family.chainHash) invalid({ familyID: family.familyID });
        } catch { invalid({ familyID: family.familyID }); }
        const { chainHash: _hash, ...value } = family;
        return value;
    });
}

export async function loadBenchmarkFamilies(connection, { referencedOnly = false } = {}) {
    const [rows] = await connection.execute(`SELECT f.ID AS family_ID, f.primary_benchmark_condition_ID, f.chain_hash,
        m.position, m.benchmark_condition_ID AS fallback_benchmark_condition_ID
        FROM benchmark_families f LEFT JOIN benchmark_family_members m ON m.family_ID = f.ID
        ${referencedOnly ? `WHERE EXISTS (SELECT 1 FROM personal_pie_score_rules r WHERE r.family_ID = f.ID)` : ''}
        ORDER BY f.ID, m.position`);
    return parseFamilyRows(rows);
}

export async function loadReferencedBenchmarkFamilyIDs(connection) {
    const [rows] = await connection.execute('SELECT DISTINCT family_ID FROM personal_pie_score_rules WHERE family_ID IS NOT NULL');
    return rows.map(row => Number(row.family_ID));
}

export async function pruneUnusedBenchmarkFamilies(connection, familyIDs = null) {
    if (familyIDs !== null && (!Array.isArray(familyIDs)
        || familyIDs.some(ID => !Number.isSafeInteger(ID) || ID < 1))) {
        throw new TypeError('Invalid family cleanup IDs');
    }
    const IDs = familyIDs === null ? null : [...new Set(familyIDs)];
    if (IDs?.length === 0) return 0;
    const [result] = await connection.execute(`DELETE f FROM benchmark_families f
        WHERE ${IDs ? `f.ID IN (${IDs.map(() => '?').join(', ')}) AND ` : ''}
        NOT EXISTS (SELECT 1 FROM personal_pie_score_rules r WHERE r.family_ID = f.ID)`, IDs ?? []);
    return Number(result.affectedRows);
}

export async function ensureBenchmarkFamily(connection, primaryConditionID, entries) {
    const chainHash = hash(primaryConditionID, entries);
    if (!entries.length) throw new TypeError('Singleton conditions do not require a family record');
    let ID;
    let created = false;
    try {
        const [result] = await connection.execute(`INSERT INTO benchmark_families (primary_benchmark_condition_ID, chain_hash) VALUES (?, ?)`,
        [primaryConditionID, chainHash]);
        ID = Number(result.insertId);
        created = true;
    } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
        const [rows] = await connection.execute('SELECT ID FROM benchmark_families WHERE chain_hash = ? FOR UPDATE', [chainHash]);
        if (rows.length !== 1) throw error;
        ID = Number(rows[0].ID);
    }
    if (created) {
        // Keep each statement below MySQL's parameter limit without limiting the chain.
        for (let offset = 0; offset < entries.length; offset += 1000) {
            const batch = entries.slice(offset, offset + 1000);
            await connection.execute(`INSERT INTO benchmark_family_members (family_ID, position, benchmark_condition_ID)
                VALUES ${batch.map(() => '(?, ?, ?)').join(', ')}`,
            batch.flatMap((entry, index) => [ID, offset + index + 1, entry.conditionID]));
        }
    }
    const [rows] = await connection.execute(`SELECT f.ID AS family_ID, f.primary_benchmark_condition_ID, f.chain_hash,
        m.position, m.benchmark_condition_ID AS fallback_benchmark_condition_ID
        FROM benchmark_families f LEFT JOIN benchmark_family_members m ON m.family_ID = f.ID
        WHERE f.ID = ? ORDER BY m.position FOR UPDATE`, [ID]);
    const family = parseFamilyRows(rows)[0];
    if (!family || familyKey(family.primaryConditionID, family.entries) !== familyKey(primaryConditionID, entries)) invalid({ familyID: ID });
    return ID;
}
