import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = '/home/ubuntu/benchpoll';
const app = process.argv.find(value => value.startsWith('--app='))?.slice(6) ?? root;
assert(app === root || /^\/home\/ubuntu\/benchpoll\/scripts\/showcase-view-20261012\/[a-z0-9-]+\/candidate$/.test(app));
const load = path => import(pathToFileURL(`${root}/${path}`).href);
const { default: dotenv } = await load('node_modules/dotenv/lib/main.js');
const { default: mysql } = await load('node_modules/mysql2/promise.js');
const { createModerationEmailService } = await import(pathToFileURL(`${app}/moderation-email.js`).href);
const environment = dotenv.parse(await readFile(`${root}/.env`));
const connection = await mysql.createConnection({
    socketPath: environment.BENCHPOLL_DB_SOCKET || undefined,
    host: environment.BENCHPOLL_DB_HOST || 'localhost', port: Number(environment.BENCHPOLL_DB_PORT || 3306),
    user: environment.BENCHPOLL_DB_USER || 'root', password: environment.BENCHPOLL_DB_PASSWORD ?? environment.DB_PASSWORD,
    database: environment.BENCHPOLL_DB_NAME || 'benchmarks',
    supportBigNumbers: true, bigNumberStrings: false, connectTimeout: 10_000
});
const results = [];
const passed = name => results.push({ name, passed: true });
const snapshot = async () => {
    const [[row]] = await connection.query(`SELECT COUNT(*) AS total, COALESCE(SUM(attempt_count), 0) AS attempts,
        COALESCE(SUM(delivery_status = 'sent'), 0) AS sent FROM moderation_email_outbox WHERE ID < 231`);
    return JSON.stringify(row);
};
let temporaryOutbox = false;
let temporaryUsers = false;
try {
    const before = await snapshot();
    // Temporary tables shadow names only on this private connection, never the running application's connections.
    await connection.query(`CREATE TEMPORARY TABLE users (ID BIGINT UNSIGNED PRIMARY KEY,
        email VARCHAR(320), email_verified_at DATETIME(3), name VARCHAR(255),
        profile_picture_URL VARCHAR(2048), role VARCHAR(32)) ENGINE=InnoDB`);
    temporaryUsers = true;
    await connection.query(`CREATE TEMPORARY TABLE moderation_email_outbox (
        ID BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, moderation_log_ID INT UNSIGNED NOT NULL UNIQUE,
        user_ID BIGINT UNSIGNED NOT NULL, recipient_email VARCHAR(320), decision VARCHAR(16),
        contribution_type VARCHAR(64), delivery_status VARCHAR(16), attempt_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        next_attempt_at DATETIME(3), locked_at DATETIME(3), sent_at DATETIME(3), last_error VARCHAR(1000),
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
        ) ENGINE=InnoDB AUTO_INCREMENT=231`);
    temporaryOutbox = true;
    await connection.execute('INSERT INTO users (ID, email, email_verified_at) VALUES (?, ?, NOW(3)), (2, ?, NULL), (3, ?, NOW(3))',
        ['9007199254740993', 'verified@example.invalid', 'unverified@example.invalid', 'one@example.invalid, two@example.invalid']);
    const messages = [];
    let now = Date.now();
    let failRecord = false;
    const service = createModerationEmailService({
        pool: { execute(sql, params) {
            if (failRecord && /SET delivery_status = 'sent'/.test(sql)) {
                failRecord = false;
                throw new Error('Synthetic bookkeeping failure');
            }
            return connection.execute(sql, params);
        } },
        publicOrigin: 'https://example.invalid',
        environment: { BENCHPOLL_EMAIL_MIN_OUTBOX_ID: '231' },
        logger: { error() {} }, clock: () => now, sleep: async ms => { now += ms; },
        transport: { async sendMail(message) {
            assert.equal(message.to, 'verified@example.invalid');
            messages.push(message);
            return { accepted: [message.to], rejected: [] };
        } }
    });
    const enqueue = (logID, userID = '9007199254740993') => service.enqueue(connection,
        { moderationLogID: logID, userID, decision: 'approved', contributionType: 'feedback' });
    let profileHandler;
    const source = await readFile(`${app}/server.js`, 'utf8');
    const start = source.indexOf("API.post('/get_user_profile'");
    const end = source.indexOf('\n});', start) + 4;
    assert(start >= 0 && end > start);
    vm.runInNewContext(source.slice(start, end), {
        API: { post(_path, handler) { profileHandler = handler; } },
        activeUserExists: async () => true, db: connection, moderationEmailService: service
    });
    for (const [userID, verified] of [['9007199254740993', true], ['2', false]]) {
        let profile;
        await profileHandler({ session: { userID } }, { set() {}, json(value) { profile = value; } },
            () => assert.fail('Synthetic active account unexpectedly rejected'));
        assert.equal(profile.hasVerifiedEmail, verified);
        assert.equal(profile.userID, userID);
    }
    passed('profile reflects verification timestamp, not mere address presence');
    await connection.beginTransaction();
    await enqueue(41);
    await connection.rollback();
    const [[rolledBack]] = await connection.query('SELECT COUNT(*) AS total FROM moderation_email_outbox');
    assert.equal(Number(rolledBack.total), 0);
    passed('transaction rollback removes notification');
    await connection.beginTransaction();
    const first = await enqueue(42);
    const missing = await enqueue(43, '2');
    const multiple = await enqueue(44, '3');
    await connection.commit();
    assert.equal(first.recipientAvailable, true);
    assert.equal(missing.recipientAvailable, false);
    assert.equal(multiple.recipientAvailable, false);
    const [[owner]] = await connection.execute('SELECT user_ID FROM moderation_email_outbox WHERE ID = ?', [first.ID]);
    assert.equal(owner.user_ID, '9007199254740993');
    passed('verified single mailbox and exact bigint identity');
    const concurrent = await Promise.all([service.deliver(first.ID), service.deliver(first.ID)]);
    assert.equal(concurrent.filter(value => value.sent).length, 1);
    assert.equal(messages.length, 1);
    passed('atomic claim and duplicate delivery');
    const second = await enqueue(45);
    failRecord = true;
    assert.deepEqual(await service.deliver(second.ID), { sent: false, reason: 'delivery_record_pending' });
    await service.drain();
    assert.equal(messages.length, 2);
    const [[recorded]] = await connection.execute('SELECT delivery_status, attempt_count FROM moderation_email_outbox WHERE ID = ?', [second.ID]);
    assert.equal(recorded.delivery_status, 'sent');
    assert.equal(Number(recorded.attempt_count), 1);
    passed('accepted notification retries database only');
    await connection.query(`INSERT INTO moderation_email_outbox
        (ID, moderation_log_ID, user_ID, recipient_email, decision, contribution_type, delivery_status, next_attempt_at)
        VALUES (1, 1, 2, 'history@example.invalid', 'approved', 'feedback', 'pending', NOW(3))`);
    const [[historicalBefore]] = await connection.query('SELECT * FROM moderation_email_outbox WHERE ID = 1');
    await connection.query(`INSERT INTO moderation_email_outbox
        (ID, moderation_log_ID, user_ID, recipient_email, decision, contribution_type, delivery_status,
            attempt_count, locked_at, created_at)
        VALUES (300, 46, 2, 'verified@example.invalid', 'approved', 'feedback', 'sending',
            1, DATE_SUB(NOW(3), INTERVAL 25 HOUR), DATE_SUB(NOW(3), INTERVAL 25 HOUR))`);
    await service.drain();
    const [[expired]] = await connection.query('SELECT delivery_status, attempt_count, last_error FROM moderation_email_outbox WHERE ID = 300');
    assert.equal(expired.delivery_status, 'failed');
    assert.equal(Number(expired.attempt_count), 1);
    assert.equal(expired.last_error, 'delivery_uncertain_retry_window_elapsed');
    assert.equal(messages.length, 2);
    const [[historicalAfter]] = await connection.query('SELECT * FROM moderation_email_outbox WHERE ID = 1');
    assert.deepEqual(historicalAfter, historicalBefore);
    passed('expired retry held without changing history');
    const capped = createModerationEmailService({ pool: connection, publicOrigin: 'https://example.invalid',
        environment: { BENCHPOLL_EMAIL_DAILY_LIMIT: '2', BENCHPOLL_EMAIL_MIN_OUTBOX_ID: '231' },
        transport: { sendMail() { assert.fail('Daily cap must stop the transport'); } } });
    const third = await enqueue(47);
    assert.deepEqual(await capped.deliver(third.ID), { sent: false, reason: 'daily_limit_reached' });
    const [[untouched]] = await connection.execute('SELECT attempt_count FROM moderation_email_outbox WHERE ID = ?', [third.ID]);
    assert.equal(Number(untouched.attempt_count), 0);
    passed('daily cap leaves attempts untouched');
    await connection.query('DROP TEMPORARY TABLE moderation_email_outbox');
    temporaryOutbox = false;
    await connection.query('DROP TEMPORARY TABLE users');
    temporaryUsers = false;
    assert.equal(await snapshot(), before);
    passed('real historical queue aggregate unchanged');
    console.log(JSON.stringify({ passed: results.length, results, externalMailSent: 0, persistentBusinessWrites: 0 }));
} finally {
    try {
        await connection.rollback();
        if (temporaryOutbox) await connection.query('DROP TEMPORARY TABLE moderation_email_outbox');
        if (temporaryUsers) await connection.query('DROP TEMPORARY TABLE users');
    } finally { await connection.end(); }
}
