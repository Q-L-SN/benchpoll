import { setLoading } from './shared/loading.js';
import { postJSON, postWriteJSON } from './shared/http.js';
import { pageAccountWriteScope, canonicalAccountID } from './shared/account-identity.js';
import { openSignIn, installSignInLinks, listenAccountChange } from './shared/sign-in.js';
import { rankingNumber } from './shared/ranking-number.js';
import { modelBarColor } from './workspace/score-colors.js';
import { mountProposalDiscussion } from './shared/proposal-discussion.js';

const $ = selector => document.querySelector(selector);
const element = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
const proposalID = Number(location.pathname.match(/^\/topic-proposals\/([1-9]\d*)\/preview\/?$/)?.[1]);
mountProposalDiscussion(proposalID);
let proposal, snapshot, selectedKey, sequence = 0, busy = false, copying = false, profile = null, accountBlocked = false;
const drafts = new Map(), weights = new Map();
const errors = {
    proposal_weights_owner_only: 'Only the proposer can adjust weights while support is being collected.',
    topic_proposal_changed: 'This proposal has a new version. Reload it before trying or saving more changes.',
    topic_proposal_not_found: 'This proposal is no longer available.',
    topic_proposal_preview_unavailable: 'This older proposal does not have a configuration snapshot.',
    proposal_private_or_unavailable_reference: 'A referenced public Topic is no longer available.',
    proposal_evaluation_unavailable: 'An evaluation item in this snapshot is no longer available.',
    topic_name_or_scene_exists: 'You already have a private Topic with this name. Choose another name.',
    topic_creation_limit: 'You have reached the daily Topic creation limit. Try again later.',
    pie_total_must_equal_100_percent: 'The weights must add up to 100%.',
    private_topic_changed: 'This topic changed. Reload before retrying.'
};
const message = error => errors[error.payload?.error] ?? error.message ?? 'Could not complete this request. Try again.';
const selectedScene = () => snapshot.scenes.find(scene => scene.key === selectedKey);
const canAdjustWeights = () => !accountBlocked && (proposal?.isMine || proposal?.status !== 'open');
const selectedEntries = () => drafts.get(selectedKey) ?? selectedScene().entries;
const readOptions = { timeoutMs: 60000, requireJSON: true };
async function loadProfile() {
    try {
        const value = await postJSON('/api/get_user_profile', {}, { timeoutMs: 15000, requireJSON: true });
        if (value?.userID) {
            const ID = canonicalAccountID(value.userID);
            if (!ID) throw new Error('Could not confirm your account.');
            pageAccountWriteScope.bind(ID); profile = { ...value, userID: ID };
        } else profile = null;
    } catch { profile = null; }
}
const profileReady = loadProfile();
listenAccountChange(() => {
    accountBlocked = true; drafts.clear(); pageAccountWriteScope.invalidate();
    if (snapshot) { renderPermissions(); renderWeights(); void calculate(); }
    $('#proposal-copy-status').textContent = 'Your account changed. Refresh before saving a private copy.';
});
installSignInLinks();
function renderPermissions() {
    $('#proposal-reset').hidden = $('#proposal-calculate').hidden = !canAdjustWeights();
    $('#proposal-trial-guidance').hidden = !canAdjustWeights();
}
function renderScenes() {
    const host = $('#proposal-preview-scenes'); host.replaceChildren(); host.hidden = !snapshot.hasScenes;
    for (const scene of snapshot.scenes) {
        const button = element('button', '', scene.name); button.type = 'button'; button.setAttribute('aria-current', String(scene.key === selectedKey));
        button.addEventListener('click', () => { if (!captureDraft()) return; selectedKey = scene.key; renderScenes(); renderWeights(); void calculate(); });
        host.append(button);
    }
}
function renderWeights() {
    const host = $('#proposal-trial-weights'); host.replaceChildren();
    const current = new Map(selectedEntries().map(entry => [entry.conditionID, entry.weightBasisPoints]));
    for (const entry of selectedScene().entries) {
        const label = weights.get(selectedKey)?.find(item => item.conditionID === entry.conditionID);
        const row = element('label', 'pp-weight-row');
        const name = element('span', '', label?.name ?? (entry.conditionID < 0 ? 'Topic reference' : 'Evaluation item'));
        const input = element('input', ''); input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '1';
        input.value = String((current.get(entry.conditionID) ?? 0) / 100); input.dataset.conditionId = String(entry.conditionID);
        input.disabled = busy || !canAdjustWeights();
        input.setAttribute('aria-label', (label?.name ?? 'Evaluation item') + ' weight (%)');
        input.addEventListener('input', updateTotal); row.append(name, input, element('span', '', '%')); host.append(row);
    }
    updateTotal();
}
function readDraft() {
    return [...$('#proposal-trial-weights').querySelectorAll('input')].map(input => ({ conditionID: Number(input.dataset.conditionId), weightBasisPoints: Number(input.value) * 100 }));
}
function updateTotal() {
    const total = readDraft().reduce((sum, item) => sum + item.weightBasisPoints, 0);
    $('#proposal-trial-total').textContent = (Number.isFinite(total) ? total / 100 : 0) + '%';
    $('#proposal-trial-total').classList.toggle('is-invalid', total !== 10000 && selectedScene().entries.length > 0);
}
function captureDraft() {
    if (!snapshot || !selectedKey || !canAdjustWeights()) return true;
    const entries = readDraft().filter(item => item.weightBasisPoints !== 0);
    const total = entries.reduce((sum, item) => sum + item.weightBasisPoints, 0);
    if (entries.some(item => !Number.isSafeInteger(item.weightBasisPoints) || item.weightBasisPoints < 100 || item.weightBasisPoints > 10000)
        || selectedScene().entries.length && total !== 10000) {
        $('#proposal-ranking-status').textContent = 'Use weights of at least 1% (or 0 to exclude), adding up to 100%.'; return false;
    }
    if (JSON.stringify(entries) === JSON.stringify(selectedScene().entries)) drafts.delete(selectedKey);
    else drafts.set(selectedKey, entries);
    return true;
}
function renderRanking(data) {
    const host = $('#proposal-preview-ranking'); host.replaceChildren();
    const table = element('table', 'pp-ranking');
    const heading = element('tr', '');
    for (const title of ['Model', data.scoreMode === 'range' ? 'Score range' : 'Estimated score', 'Coverage']) heading.append(element('th', '', title));
    const head = element('thead', ''); head.append(heading); table.append(head);
    const body = element('tbody', '');
    for (const [index, model] of data.models.entries()) {
        const row = element('tr', ''), identity = element('th', '', `${index + 1}. ${model.modelName ?? model.name}`); identity.scope = 'row';
        const score = element('td', 'pp-score-cell');
        const bar = element('span', 'pp-score-bar'); bar.style.width = Math.max(0, Math.min(100, model.lower || 0)) + '%'; bar.style.backgroundColor = modelBarColor(model);
        const text = model.comparable === false ? '—' : data.scoreMode === 'range'
            ? rankingNumber(model.lower) + '–' + rankingNumber(model.upper) : rankingNumber(model.lower);
        score.append(bar, element('span', 'pp-score-number', text));
        row.append(identity, score, element('td', '', Number.isFinite(model.coverage) ? rankingNumber(model.coverage) + '%' : '—')); body.append(row);
    }
    table.append(body); host.append(table);
    if (!data.models.length) host.append(element('p', 'pp-note', 'No model ranking is available for these weights.'));
    $('#proposal-ranking-label').textContent = drafts.has(selectedKey) ? 'Your trial weights · personal preview' : 'Proposer’s configuration · 1 contributor';
    if (data.referenceIssues?.length) $('#proposal-ranking-status').textContent = 'Some referenced evaluation weight is unavailable. Coverage and score ranges keep that missing weight visible.';
}
async function calculate() {
    const request = ++sequence, sceneKey = selectedKey;
    busy = true; $('#proposal-calculate').disabled = true; setLoading($('#proposal-ranking-status'), 'Calculating...');
    $('#proposal-trial-weights').querySelectorAll('input').forEach(input => { input.disabled = true; });
    $('#proposal-preview-ranking').setAttribute('aria-busy', 'true');
    try {
        const data = await postJSON('/api/preview_topic_proposal', { proposalID, revision: proposal.revision, sceneKey,
            scoreMode: $('#proposal-preview-mode').value, ...(drafts.has(sceneKey) ? { entries: drafts.get(sceneKey) } : {}) }, readOptions);
        if (request !== sequence) return;
        weights.set(sceneKey, data.weights); renderWeights(); $('#proposal-ranking-status').textContent = ''; renderRanking(data);
    } catch (error) { if (request === sequence) { $('#proposal-ranking-status').textContent = message(error); $('#proposal-preview-ranking').replaceChildren(); } }
    finally { if (request === sequence) { busy = false; $('#proposal-calculate').disabled = false;
        $('#proposal-trial-weights').querySelectorAll('input').forEach(input => { input.disabled = !canAdjustWeights(); });
        $('#proposal-preview-ranking').setAttribute('aria-busy', 'false'); } }
}
$('#proposal-trial-form').addEventListener('submit', event => { event.preventDefault(); if (!busy && captureDraft()) void calculate(); });
$('#proposal-preview-mode').addEventListener('change', () => { if (captureDraft()) void calculate(); });
$('#proposal-reset').addEventListener('click', () => { if (!snapshot) return; drafts.delete(selectedKey); renderWeights(); void calculate(); });
$('#proposal-copy-form').addEventListener('submit', async event => {
    event.preventDefault(); if (copying || !captureDraft()) return;
    await profileReady;
    if (accountBlocked) return;
    if (!profile) { $('#proposal-copy-status').textContent = 'Sign in to save a private copy. Your trial stays on this page.'; openSignIn(); return; }
    copying = true; $('#proposal-copy').disabled = true; setLoading($('#proposal-copy-status'), 'Saving private copy...');
    try {
        const security = await postJSON('/api/get_privacy_status', {}, { timeoutMs: 15000, requireJSON: true });
        const result = await pageAccountWriteScope.write((path, body) => postWriteJSON(path, body, { timeoutMs: 30000 }), '/api/copy_topic_proposal', {
            proposalID, revision: proposal.revision, name: $('#proposal-copy-name').value,
            sceneDrafts: [...drafts].map(([key, entries]) => ({ key, entries })), csrfToken: security.csrfToken });
        if (!Number.isSafeInteger(result?.categoryID) || result.url !== '/personal/' + result.categoryID) throw new Error('The private copy could not be confirmed. Retry to check the same request.');
        const link = element('a', '', 'Open your private Topic'); link.href = result.url;
        $('#proposal-copy-status').replaceChildren(document.createTextNode('Saved. '), link);
    } catch (error) { $('#proposal-copy-status').textContent = message(error); }
    finally { copying = false; $('#proposal-copy').disabled = false; }
});
try {
    const data = await postJSON('/api/get_topic_proposal_snapshot', { proposalID }, readOptions);
    $('#proposal-preview-status').textContent = '';
    proposal = data.proposal; snapshot = data.snapshot; selectedKey = snapshot.scenes.find(scene => scene.isDefault).key;
    $('#proposal-title').textContent = snapshot.name; $('#proposal-summary').textContent = snapshot.description;
    $('#proposal-version').textContent = 'Proposal snapshot · Version ' + proposal.revision;
    $('#proposal-copy-name').value = snapshot.name;
    $('#proposal-support-link').href = '/topic-proposals#proposal-' + proposalID;
    document.title = snapshot.name + ' - Topic proposal | BenchPoll';
    $('#proposal-preview-content').hidden = false; renderPermissions(); renderScenes(); renderWeights(); await calculate();
} catch (error) { $('#proposal-title').textContent = 'Proposal preview unavailable'; $('#proposal-preview-status').textContent = message(error); }
