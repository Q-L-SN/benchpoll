import 'dotenv/config';
import mysql from 'mysql2/promise';
import { fieldNameKey } from '../public/js/shared/score-fields.js';

const apply = process.argv.includes('--apply');
if (apply && !process.argv.includes('--backup-confirmed')) throw new Error('Verified database backup required');
const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4' });
let locked = false;
try {
    const [[{ acquired }]] = await db.query("SELECT GET_LOCK('benchpoll_arena_latest_import',30) AS acquired");
    if (Number(acquired) !== 1) throw new Error('Arena import lock unavailable');
    locked = true;
    await db.beginTransaction();
    const name = 'Search context size';
    const [fields] = await db.execute('SELECT * FROM score_fields WHERE name_key=? FOR UPDATE', [fieldNameKey(name)]);
    let field = fields[0];
    const createdField = !field;
    if (field && (field.name !== name || field.field_type !== 'enum' || !field.is_active
        || field.allow_empty || !field.exclude_missing || field.exclude_empty)) {
        throw new Error('Existing Search context size field has a different contract');
    }
    if (!field && apply) {
        const [inserted] = await db.execute("INSERT INTO score_fields (name,name_key,field_type) VALUES (?,?,'enum')",
            [name, fieldNameKey(name)]);
        field = { ID: Number(inserted.insertId) };
    }
    const [existingOptions] = field
        ? await db.execute('SELECT * FROM score_field_options WHERE field_ID=? FOR UPDATE', [field.ID]) : [[]];
    const missingOptions = [];
    for (const label of ['low', 'medium', 'high']) {
        const matches = existingOptions.filter(option => option.label_key === fieldNameKey(label));
        if (matches.length > 1 || (matches[0] && (!matches[0].is_active || matches[0].excluded || matches[0].label !== label))) {
            throw new Error(`Existing Search context size option is incompatible: ${label}`);
        }
        if (!matches.length) {
            missingOptions.push(label);
            if (apply) await db.execute('INSERT INTO score_field_options (field_ID,label,label_key) VALUES (?,?,?)',
                [field.ID, label, fieldNameKey(label)]);
        }
    }
    if (apply) await db.commit();
    else await db.rollback();
    console.log(JSON.stringify({ apply, createdField, missingOptions, fieldID: field?.ID ?? null }));
} catch (error) { await db.rollback(); throw error; }
finally {
    if (locked) await db.query("SELECT RELEASE_LOCK('benchpoll_arena_latest_import')");
    await db.end();
}
