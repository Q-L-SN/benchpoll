import { frontendSource } from './helpers/frontend-source.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../private/censor.html', import.meta.url), 'utf8');
const client = frontendSource('public/js/censor.js');
const accountMigration = fs.readFileSync(
    new URL('../scripts/migrate-unified-reviewer-accounts.mjs', import.meta.url),
    'utf8'
);
const moderation = fs.readFileSync(new URL('../moderation-admin.js', import.meta.url), 'utf8');

test('reviewer privileges use the ordinary GitHub user session and server-side role', () => {
    assert.match(server, /SELECT ID, role[\s\S]*FROM users/);
    assert.match(server, /const requireReviewerAuthForAPI/);
    assert.match(server, /const requireSeniorReviewerAuthForAPI/);
    assert.match(server, /activeUserRecord\(req\.session\.userID\)/);
    assert.match(server, /if \(!user\.isSenior\)/);
    assert.doesNotMatch(server, /req\.session\.adminID|SELECT \* FROM admin|\/admin_login/);
});

test('the ordinary contribution endpoint immediately applies senior submissions', () => {
    const endpointStart = server.indexOf("API.post('/submit_contribution'");
    const endpointEnd = server.indexOf('function pendingCatalogReference(', endpointStart);
    const endpoint = server.slice(endpointStart, endpointEnd);
    assert.match(endpoint, /requireAuthForAPI/);
    assert.match(endpoint, /if \(req\.user\.isSenior\)/);
    assert.match(endpoint, /await applyModerationContent\(workingConnection, content/);
    assert.match(endpoint, /UPDATE moderation_logs SET status = 'approved'/);
    assert.match(endpoint, /reviewerUserID: req\.session\.userID/);
    assert.doesNotMatch(endpoint, /adminPassword|adminCredentials|specialAdmin/);
});

test('senior data changes open the existing contribution forms in a new tab', () => {
    assert.match(html, /id="explorer-add"/);
    assert.doesNotMatch(html, /id="direct-editor-form"|id="direct-delete-id"/);
    assert.match(client, /EXPLORER_CONTRIBUTION_FORMS/);
    assert.match(client, /buildContributionURL\('edit_benchmark', \{ targetBenchmarkID: row.id/);
    assert.match(client, /buildContributionURL\('edit_model', \{ targetModelID: row.id/);
    assert.match(client, /buildContributionURL\('edit_result', \{ targetResultID: row.id/);
    assert.match(client, /window\.open\(url, '_blank', 'noopener,noreferrer'\)/);
    assert.doesNotMatch(server, /API\.post\('\/admin_direct_mutation'/);
});

test('the account migration assigns user roles and removes the password administrator table', () => {
    assert.match(accountMigration, /ADD COLUMN role ENUM\('user','reviewer','senior'\)/);
    assert.match(accountMigration, /UPDATE users SET role = 'senior'/);
    assert.match(accountMigration, /DROP TABLE admin/);
    assert.match(accountMigration, /reviewer_user_ID/);
    assert.match(accountMigration, /sender_user_ID/);
    assert.match(accountMigration, /FOREIGN KEY \(reviewer_user_ID\) REFERENCES users \(ID\)/);
});

test('reviewer messages and audit rows are attributed to ordinary user IDs', () => {
    assert.match(server, /API\.post\('\/send_admin_message', requireReviewerAuthForAPI/);
    assert.match(server, /API\.post\('\/list_admin_messages', requireSeniorReviewerAuthForAPI/);
    assert.match(server, /INSERT INTO admin_messages \(sender_user_ID/);
    assert.match(moderation, /reviewer_user_ID/);
    assert.match(html, /Message senior reviewers/);
    assert.match(html, /id="messages-view"/);
});

test('benchmark records expose canonical benchmark conditions without legacy profiles', () => {
    assert.match(moderation, /benchmark_conditions\.score_direction AS scoreDirection/);
    assert.match(moderation, /benchmark_conditions\.uses_percentage_scale AS usesPercentageScale/);
    assert.doesNotMatch(moderation, /evaluation_profiles|model_configurations|evaluation_results/);
});

test('reviewers are warned when a decision email cannot be delivered immediately', () => {
    assert.match(client, /function showModerationEmailStatus/);
    assert.match(client, /Email notification unavailable/);
    assert.match(client, /Configure BenchPoll SMTP delivery/);
    assert.match(client, /data\.emailNotification/);
});

test('edited moderation apply is bound to the current reviewer user and a fresh SQL preview', () => {
    assert.match(server, /createModerationPreviewToken/);
    assert.match(server, /preview\.updatedAt !== moderationTimestamp\(rows\[0\]\.updated_at\)/);
    assert.match(server, /preview\.contentHash !== moderationPreviewContentHash\(editedContent\)/);
    assert.match(server, /preview\.reviewerUserID !== String\(req\.user\.ID\)/);
    assert.match(client, /return fetch\('\/api\/preview_moderation_sql'/);
    assert.match(client, /await previewSQL\(activeEditorLog, content\)/);
    assert.match(client, /previewToken: activeEditorPreviewToken/);
});
