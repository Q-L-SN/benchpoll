import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migrationSource = fs.readFileSync(
    new URL('../scripts/migrate-session-integrity.mjs', import.meta.url),
    'utf8'
);
const packageJSON = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('session cleanup is enforced by a repeatable database migration', () => {
    assert.match(migrationSource, /010_session_integrity/);
    assert.match(migrationSource, /sessions\.session_id = user_sessions\.session_ID/);
    assert.match(migrationSource, /users\.ID = user_sessions\.user_ID/);
    assert.match(migrationSource, /COLLATE utf8mb4_bin NOT NULL/);
    assert.match(migrationSource, /FOREIGN KEY \(session_ID\) REFERENCES sessions\(session_id\)/);
    assert.match(migrationSource, /FOREIGN KEY \(user_ID\) REFERENCES users\(ID\)/);
    assert.equal((migrationSource.match(/ON DELETE CASCADE/g) ?? []).length, 2);
    assert.equal(
        packageJSON.scripts['migrate:session-integrity'],
        'node scripts/migrate-session-integrity.mjs --apply'
    );
});
