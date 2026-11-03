import { setLoading, setButtonLoading } from './shared/loading.js';
import { postJSON, postWriteJSON } from './shared/http.js';
import { pageAccountWriteScope, canonicalAccountID, accountWriteError, isAccountWriteError } from './shared/account-identity.js';
import { openSignIn, installSignInLinks, listenAccountChange } from './shared/sign-in.js';
import { createAction } from './shared/ui-components.js';
import { profileAvatarURL } from './shared/profile-editor.js';
import { normalizeTopicSummary, isReservedTopicSlug, topicSlug } from './shared/topics.js';
import { mountSiteActions } from './shared/site-header.js';

export const SUPPORT_THRESHOLD = 30;
export const PROPOSAL_LIMITS = Object.freeze({ supports: 3, proposals: 1, days: 14 });
const READ_OPTIONS = Object.freeze({ timeoutMs: 15000, requireJSON: true });
const DRAFT_KEY = 'benchpoll:topic-proposal-draft:v1';
const positiveID = value => Number.isSafeInteger(value) && value > 0;
const nullableID = value => value === null || positiveID(value);
const invalidResponse = () => Object.assign(new Error('The server response could not be confirmed.'), { code: 'unconfirmed_response' });
const refreshRequired = () => Object.assign(new Error('This proposal changed. Review the current proposal before continuing.'), { code: 'proposal_refresh_required' });
const validDeadline = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const unicodeLength = value => [...String(value).trim().normalize('NFC')].length;
export const proposalStatus = (proposal, now = Date.now()) => proposal.status === 'open'
    && Date.parse(proposal.expiresAt) <= now ? 'expired' : proposal.status;

export function validateProposalDraft(values) {
    const name = typeof values?.name === 'string' ? values.name.trim().normalize('NFC') : '';
    let description = typeof values?.description === 'string' ? values.description.trim().normalize('NFC') : '';
    const errors = {};
    const parentTopicID = values?.parentTopicID ?? null;
    if (parentTopicID !== null && !positiveID(parentTopicID)) errors.parentTopicID = 'Choose a public Topic for this scene.';
    if (!name || [...name].length > 128 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)) {
        errors.name = 'Enter a Topic name of 1 to 128 characters.';
    } else if (parentTopicID === null && isReservedTopicSlug(name)) errors.name = 'This name is reserved. Choose another Topic name.';
    try { description = normalizeTopicSummary(description); }
    catch { errors.description = 'Write one sentence of 1 to 180 characters.'; }
    if (/[\p{Cs}]/u.test(description)) errors.description = 'Use valid Unicode characters in the summary.';
    return { name, description, ...(parentTopicID !== null ? { parentTopicID } : {}), errors };
}

export function approvedTopicURL(value, name) {
    return typeof value === 'string' && value === `/${topicSlug(name)}` && !isReservedTopicSlug(name) ? value : null;
}

function approvedSceneURL(value, proposal) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
    try {
        const url = new URL(value, 'https://benchpoll.invalid');
        return url.origin === 'https://benchpoll.invalid' && !url.hash && !url.search
            && url.pathname === `/${topicSlug(proposal.parentTopicName)}/${proposal.sceneSlug || topicSlug(proposal.name)}` ? value : null;
    } catch { return null; }
}

export function parseProposal(value) {
    if (!value || !positiveID(value.proposalID) || value.threshold !== SUPPORT_THRESHOLD
        || !Number.isSafeInteger(value.supportCount) || value.supportCount < 0
        || !['open', 'pending', 'approved', 'rejected', 'expired', 'withdrawn'].includes(value.status)
        || !positiveID(value.revision) || !validDeadline(value.expiresAt)
        || ['supported', 'canSupport', 'isMine', 'canEdit', 'canWithdraw', 'canCancelSupport'].some(key => typeof value[key] !== 'boolean')
        || value.isMine && value.supported
        || value.canSupport && (value.supported || value.isMine || value.status !== 'open')
        || (value.canEdit || value.canWithdraw) && (!value.isMine || value.status !== 'open')
        || value.canCancelSupport && (!value.supported || value.isMine || value.status !== 'open')
        || !nullableID(value.submissionID) || !nullableID(value.topicID)) throw invalidResponse();
    const scene = value.parentTopicID != null;
    if (scene && (!positiveID(value.parentTopicID) || value.kind !== 'scene' || !nullableID(value.sceneID)
        || value.topicID !== null || value.parentTopicName !== null && typeof value.parentTopicName !== 'string'
        || value.status !== 'approved' && value.sceneID !== null)
        || !scene && (value.kind === 'scene' || value.sceneID != null)) throw invalidResponse();
    const draft = validateProposalDraft(value);
    if (Object.keys(draft.errors).length || draft.name !== value.name || draft.description !== value.description
        || (['open', 'expired', 'withdrawn'].includes(value.status) ? value.supportCount >= SUPPORT_THRESHOLD : value.supportCount < SUPPORT_THRESHOLD)
        || ['open', 'expired', 'withdrawn'].includes(value.status) && value.submissionID !== null
        || value.status !== 'approved' && (value.url !== null || value.topicID !== null)
        || value.url !== null && !(scene ? approvedSceneURL(value.url, value) : approvedTopicURL(value.url, value.name))) throw invalidResponse();
    return { proposalID: value.proposalID, name: value.name, description: value.description,
        supportCount: value.supportCount, threshold: value.threshold, status: value.status,
        supported: value.supported, canSupport: value.canSupport, submissionID: value.submissionID,
        topicID: value.topicID, url: value.url, revision: value.revision, expiresAt: value.expiresAt,
        hasSnapshot: value.hasSnapshot === true,
        previewURL: value.hasSnapshot === true && value.previewURL === `/topic-proposals/${value.proposalID}/preview` ? value.previewURL : null,
        ...(value.isMine && positiveID(value.sourceTopicID) ? { sourceTopicID: value.sourceTopicID } : {}),
        ...(scene ? { kind: 'scene', parentTopicID: value.parentTopicID, parentTopicName: value.parentTopicName, sceneID: value.sceneID, sceneSlug: value.sceneSlug } : {}),
        isMine: value.isMine, canEdit: value.canEdit, canWithdraw: value.canWithdraw, canCancelSupport: value.canCancelSupport };
}

export function parseProposalPage(value, before = null) {
    if (!value || typeof value.authenticated !== 'boolean' || value.threshold !== SUPPORT_THRESHOLD
        || !Array.isArray(value.proposals) || value.proposals.length > 30
        || !nullableID(value.nextCursor) || before !== null && !positiveID(before)
        || Object.entries(PROPOSAL_LIMITS).some(([key, limit]) => value.limits?.[key] !== limit)
        || (value.authenticated ? !value.account || !Number.isSafeInteger(value.account.activeSupports)
            || value.account.activeSupports < 0 || !nullableID(value.account.activeProposalID) : value.account !== null)) throw invalidResponse();
    const proposals = value.proposals.map(parseProposal);
    const activeProposal = value.activeProposal === null ? null : parseProposal(value.activeProposal);
    if (value.authenticated ? (value.account.activeProposalID === null ? activeProposal !== null
        : !activeProposal || activeProposal.proposalID !== value.account.activeProposalID || !activeProposal.isMine || activeProposal.status !== 'open')
        : activeProposal !== null) throw invalidResponse();
    if (proposals.some((proposal, index) => (index && proposal.proposalID >= proposals[index - 1].proposalID)
        || before !== null && proposal.proposalID >= before)
        || value.nextCursor !== null && (!proposals.length
            || value.nextCursor > proposals.at(-1).proposalID
            || before !== null && value.nextCursor >= before)) throw invalidResponse();
    if (!value.authenticated && proposals.some(proposal => proposal.supported || proposal.isMine || proposal.canSupport
        || proposal.canEdit || proposal.canWithdraw || proposal.canCancelSupport)) throw invalidResponse();
    return { authenticated: value.authenticated, proposals, nextCursor: value.nextCursor, limits: { ...PROPOSAL_LIMITS },
        account: value.account === null ? null : { activeSupports: value.account.activeSupports, activeProposalID: value.account.activeProposalID }, activeProposal };
}

export function validatePublishedProposal(value, body) {
    const proposal = parseProposal(value);
    if (!proposal.isMine || proposal.supported || proposal.canSupport) throw invalidResponse();
    if (proposal.name !== body.name || proposal.description !== body.description || proposal.revision !== 1
        || (proposal.parentTopicID ?? null) !== (body.parentTopicID ?? null)) throw refreshRequired();
    return proposal;
}

export function validateSupportedProposal(value, previous) {
    const proposal = parseProposal(value);
    if (proposal.proposalID !== previous.proposalID || proposal.isMine) throw invalidResponse();
    if (!sameContent(proposal, previous) || !proposal.supported) throw refreshRequired();
    return proposal;
}

const sameContent = (proposal, previous) => proposal.revision === previous.revision && proposal.name === previous.name
    && proposal.description === previous.description && proposal.expiresAt === previous.expiresAt
    && (proposal.parentTopicID ?? null) === (previous.parentTopicID ?? null);

export function validateCanceledSupport(value, previous) {
    const proposal = parseProposal(value);
    if (proposal.proposalID !== previous.proposalID || proposal.isMine) throw invalidResponse();
    if (!sameContent(proposal, previous) || proposal.supported) throw refreshRequired();
    return proposal;
}

export function validateEditedProposal(value, previous, body) {
    const proposal = parseProposal(value);
    if (proposal.proposalID !== previous.proposalID || !proposal.isMine) throw invalidResponse();
    const unchanged = body.name === previous.name && body.description === previous.description;
    const revisions = body.sourceTopicID && unchanged ? [previous.revision, previous.revision + 1] : [previous.revision + (unchanged ? 0 : 1)];
    if (!revisions.includes(proposal.revision) || proposal.name !== body.name || proposal.description !== body.description
        || proposal.expiresAt !== previous.expiresAt || (proposal.parentTopicID ?? null) !== (previous.parentTopicID ?? null)) throw refreshRequired();
    return proposal;
}

export function validateWithdrawnProposal(value, previous) {
    if (!value || value.proposalID !== previous.proposalID || value.deleted !== true || !previous.isMine) throw invalidResponse();
    return { ...previous, status: 'withdrawn', canSupport: false, canEdit: false, canWithdraw: false, canCancelSupport: false };
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function glyph(name) {
    const icon = element('i', `fa-solid fa-${name}`);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

function actionLabel(button, label, icon) {
    if (icon === 'spinner') { setButtonLoading(button, true, label); return; }
    setButtonLoading(button, false);
    button.replaceChildren(glyph(icon), element('span', 'bp-ui-action-label', label));
}

function recoveryAction(kind) {
    if (kind === 'privacy') return createAction({ label: 'Privacy & account choices', href: '/account/privacy', icon: 'fa-solid fa-shield-halved' });
    if (kind === 'refresh') return createAction({ label: 'Refresh page', href: '/topic-proposals', icon: 'fa-solid fa-rotate-right' });
    if (kind === 'signin' || kind === 'email') {
        const button = createAction({ label: kind === 'email' ? 'Verify GitHub email' : 'Sign in with GitHub', icon: 'fa-brands fa-github' });
        button.addEventListener('click', () => openSignIn());
        return button;
    }
    return null;
}

export function proposalErrorInfo(error, operation = 'publish') {
    if (operation === true) operation = 'support';
    if (error?.code === 'proposal_refresh_required') return {
        message: 'This proposal changed. Refresh the hall and review its current text and supports before trying again. Your draft is kept.', recovery: 'hall'
    };
    const code = error?.payload?.error;
    const known = {
        authentication_required: ['Sign in again before continuing. Your draft is kept.', 'signin'],
        account_changed: ['Your account changed. Refresh this page before publishing or supporting. Your draft is kept.', 'refresh'],
        account_identity_required: ['Your account could not be confirmed. Refresh this page. Your draft is kept.', 'refresh'],
        legal_acceptance_required: ['Review the updated Terms in Privacy & account choices, then try again. Your draft is kept.', 'privacy'],
        verified_email_required: ['A verified email linked to your GitHub account is required. Verify it on GitHub, then sign in again. Your draft is kept.', 'email'],
        privacy_form_expired: ['Your security session expired. Try again. Your draft is kept.'],
        reserved_topic_name: ['This name is reserved. Choose another Topic name.'],
        invalid_topic_name: ['Enter a Topic name of 1 to 128 characters.'],
        invalid_topic_description: ['Write one sentence of 1 to 180 characters.'],
        topic_name_exists: ['A public Topic already uses this name. Choose another name.'],
        topic_scene_name_exists: ['This Topic already has a scene with this name. Choose another name.'],
        topic_scene_not_found: ['This scene is no longer available. Refresh the hall.', 'hall'],
        public_topic_required: ['Choose an available public Topic for this scene.'],
        topic_proposal_exists: ['A proposal already uses this name. Support the existing proposal or choose another name.'],
        topic_proposal_not_found: ['This proposal is no longer available. Refresh the hall.', 'hall'],
        proposal_self_support_not_allowed: ['You cannot support your own proposal.'],
        topic_proposal_not_open: ['This proposal is no longer collecting. Support and content are locked. Refresh the hall.', 'hall'],
        active_topic_proposal_limit: ['You already have a collecting proposal. Edit or withdraw it, or wait for collection to end, before proposing another.', 'hall'],
        topic_proposal_support_limit: ['All 3 active supports are in use. Cancel support on a collecting proposal before supporting another.', 'hall'],
        topic_proposal_changed: ['This proposal changed. Refresh the hall and review the latest version before trying again. Your draft is kept.', 'hall'],
        topic_proposal_revision_required: ['The proposal version could not be confirmed. Refresh the hall before trying again. Your draft is kept.', 'hall'],
        topic_proposal_not_owner: ['Only the author can edit or withdraw this proposal. Refresh the hall.', 'hall'],
        topic_proposal_expired: ['The 14-day collection period has ended. This proposal can no longer be changed or supported.', 'hall'],
        topic_creation_limit: ['You have reached the proposal limit. Please try again later.'],
        private_topic_source_required: ['Choose a saved private Topic to publish.'],
        private_topic_not_found: ['That private Topic is unavailable. Choose another Topic or refresh your list.'],
        proposal_topic_empty: ['Save evaluation weights in the private Topic’s default scene before proposing it.'],
        proposal_private_or_unavailable_reference: ['Remove private or unavailable Topic references before publishing. Your original Topic stays private.'],
        proposal_evaluation_unavailable: ['An evaluation item is no longer available. Update your private Topic, then try again.'],
        write_identity_required: ['The request identity could not be confirmed. Please try again.'],
        write_identity_reused: ['The request identity could not be confirmed. Please try again.']
    };
    const [message, recovery] = known[code] ?? (error?.status === 401 ? known.authentication_required :
        [`Could not confirm ${operation === 'support' ? 'this support' : operation === 'cancel' ? 'support cancellation'
            : operation === 'edit' ? 'your edits' : operation === 'withdraw' ? 'withdrawal' : 'publication'}. Your draft is kept. Try again to check the same request.`]);
    return { message, recovery };
}

export function mountProposalHall() {
    const $ = selector => document.querySelector(selector);
    mountSiteActions($('#proposals-site-links'), { accountID: 'proposals-account', accountButton: true });
    const dialog = $('#proposal-dialog'), form = $('#proposal-form'), submit = $('#proposal-submit');
    const fields = { name: $('#proposal-name'), description: $('#proposal-description') };
    const target = $('#proposal-target'), targetStatus = $('#proposal-target-status');
    const source = $('#proposal-source');
    let parentTopicID = null, sourceTopicID = null, publicTopics = [], privateTopics = [], targetsLoaded = false, targetsLoading = false;
    const list = $('#proposals-list'), listStatus = $('#proposals-list-status'), more = $('#proposals-load-more');
    const proposals = new Map(), rowErrors = new Map(), supporting = new Set(), operations = new Map();
    const drafts = new Map();
    let profile = null, boundOwner = null, accountState = 'loading', accountEpoch = 0;
    let security = null, creating = false, attempted = false, trigger = null;
    let listAuthenticated = null, listLoading = false, nextCursor = null, listFailure = null, listView = 'all';
    let listEpoch = 0, listController = null;
    let quota = null, quotaFresh = false, activeProposal = null, editing = null, editConflict = false, withdrawing = null, deadlineTimer;
    const withdrawDialog = $('#proposal-withdraw-dialog');

    function preserveView(update) {
        const active = document.activeElement;
        const activeRow = active?.closest('.tp-row');
        const activeAction = active?.dataset.action;
        const anchor = [...list.children].find(row => row.getBoundingClientRect().bottom > 0);
        const anchorID = anchor?.id, top = anchor?.getBoundingClientRect().top;
        const x = window.scrollX, y = window.scrollY;
        update();
        if (activeRow && !active.isConnected && !dialog.open && !withdrawDialog.open) {
            const row = document.getElementById(activeRow.id);
            (row?.querySelector(`[data-action="${activeAction}"]:not(:disabled)`) ?? row?.querySelector('h3'))?.focus({ preventScroll: true });
        }
        const nextAnchor = anchorID && document.getElementById(anchorID);
        window.scrollTo({ left: x, top: nextAnchor ? y + nextAnchor.getBoundingClientRect().top - top : y, behavior: 'instant' });
    }

    function hallRecovery() { void loadPage(null, { refresh: true }); }

    const setMessage = (host, message, recovery) => {
        host.hidden = !message;
        host.replaceChildren();
        if (!message) return;
        host.append(element('span', '', message));
        const action = recovery === 'hall' ? createAction({ label: 'Refresh hall', icon: 'fa-solid fa-rotate-right' })
            : recovery === 'latest' ? createAction({ label: 'Review latest version', icon: 'fa-solid fa-code-compare' }) : recoveryAction(recovery);
        if (recovery === 'hall') action.addEventListener('click', hallRecovery);
        if (recovery === 'latest') action.addEventListener('click', reviewLatestEdit);
        if (action) host.append(document.createTextNode(' '), action);
    };
    const formMessage = info => setMessage($('#proposal-form-status'), info?.message, info?.recovery);
    const draftValues = () => ({ ...Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value])),
        ...(parentTopicID !== null ? { parentTopicID } : {}), ...(sourceTopicID !== null ? { sourceTopicID } : {}) });
    const editDraftKey = proposal => `${DRAFT_KEY}:edit:${boundOwner}:${proposal.proposalID}`;
    const saveDraft = () => {
        const key = editing ? editDraftKey(editing) : DRAFT_KEY;
        const draft = { ...draftValues(), ...(editing ? { revision: editing.revision } : {}) };
        drafts.set(key, draft);
        try { sessionStorage.setItem(key, JSON.stringify(draft)); } catch { /* The document still retains every draft. */ }
    };
    function restoreDraft(key, fallback = {}) {
        let draft = drafts.get(key) ?? fallback;
        if (!drafts.has(key)) try { draft = JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch { /* Storage is optional. */ }
        for (const key of Object.keys(fields)) fields[key].value = typeof draft[key] === 'string' && draft[key].length <= 16384 ? draft[key] : '';
        parentTopicID = positiveID(draft.parentTopicID) ? draft.parentTopicID : null;
        sourceTopicID = positiveID(draft.sourceTopicID) ? draft.sourceTopicID : null;
        renderTargets();
        return draft;
    }
    restoreDraft(DRAFT_KEY);
    const requestedParent = Number(new URLSearchParams(location.search).get('parentTopicID'));
    if (positiveID(requestedParent)) { parentTopicID = requestedParent; renderTargets(); }
    const requestedSource = Number(new URLSearchParams(location.search).get('sourceTopicID'));
    if (positiveID(requestedSource)) { sourceTopicID = requestedSource; parentTopicID = null; }

    function renderTargets() {
        const options = [new window.Option('New topic', '')];
        for (const topic of publicTopics) options.push(new window.Option(`Scene in ${topic.name}`, String(topic.ID)));
        if (parentTopicID !== null && !publicTopics.some(topic => topic.ID === parentTopicID)) {
            const unavailable = new window.Option(editing?.parentTopicName ? `Scene in ${editing.parentTopicName}`
                : targetsLoaded ? 'Topic unavailable' : 'Selected topic', String(parentTopicID));
            unavailable.disabled = true; options.push(unavailable);
        }
        target.replaceChildren(...options); target.value = parentTopicID === null ? '' : String(parentTopicID);
        source.replaceChildren(new window.Option('Choose a saved private Topic', ''), ...privateTopics.map(topic => new window.Option(topic.name, String(topic.ID))));
        if (sourceTopicID !== null && !privateTopics.some(topic => topic.ID === sourceTopicID)) {
            const unavailable = new window.Option(targetsLoaded ? 'Private Topic unavailable' : 'Selected private Topic', String(sourceTopicID));
            unavailable.disabled = true; source.append(unavailable);
        }
        source.value = sourceTopicID === null ? '' : String(sourceTopicID);
        const link = $('#proposal-source-link'); link.hidden = !privateTopics.some(topic => topic.ID === sourceTopicID);
        if (!link.hidden) link.href = '/personal/' + sourceTopicID;
    }
    async function loadTargets() {
        if (targetsLoaded || targetsLoading) return;
        targetsLoading = true; targetStatus.hidden = false; setLoading(targetStatus, 'Loading topics');
        try {
            const data = await postJSON('/api/get_topics', {}, READ_OPTIONS);
            if (!Array.isArray(data?.topics)) throw invalidResponse();
            publicTopics = data.topics.filter(topic => topic.isPrivate !== true && positiveID(topic.ID) && typeof topic.name === 'string');
            privateTopics = data.topics.filter(topic => topic.isPrivate === true && positiveID(topic.ID) && typeof topic.name === 'string');
            publicTopics.sort((a, b) => a.name.localeCompare(b.name));
            targetsLoaded = true; targetStatus.hidden = true; targetStatus.replaceChildren(); renderTargets();
            if (!editing && sourceTopicID !== null && !fields.name.value) fillSource();
        } catch {
            targetStatus.replaceChildren(element('span', '', 'Could not load public Topics. '));
            const retry = createAction({ label: 'Retry', icon: 'fa-solid fa-rotate-right', variant: 'quiet' });
            retry.addEventListener('click', () => void loadTargets()); targetStatus.append(retry); targetStatus.hidden = false;
        } finally { targetsLoading = false; syncFields(); }
    }
    target.addEventListener('change', () => {
        if (creating || editing) return;
        parentTopicID = target.value ? Number(target.value) : null;
        formMessage(null); syncFields(); saveDraft();
    });
    function fillSource() {
        const topic = privateTopics.find(topic => topic.ID === sourceTopicID);
        if (topic) { fields.name.value = topic.name; fields.description.value = topic.description; }
    }
    source.addEventListener('change', () => {
        sourceTopicID = source.value ? Number(source.value) : null;
        fillSource(); renderTargets(); syncFields(); saveDraft();
    });
    $('#proposal-source-refresh').addEventListener('click', () => { targetsLoaded = false; void loadTargets(); });

    const actorReady = () => accountState === 'ready' && listAuthenticated === true && quotaFresh;
    const proposalByID = id => activeProposal?.proposalID === id ? activeProposal : proposals.get(id);
    function updateProposal(proposal, insert = false) {
        if (proposal.status === 'withdrawn') {
            proposals.delete(proposal.proposalID);
            document.getElementById(`proposal-${proposal.proposalID}`)?.remove();
        } else if (insert || proposals.has(proposal.proposalID)) proposals.set(proposal.proposalID, proposal);
        if (proposal.isMine && proposalStatus(proposal) === 'open') activeProposal = proposal;
        else if (activeProposal?.proposalID === proposal.proposalID) activeProposal = null;
    }
    const proposalFull = () => quota?.activeProposalID !== null && quota?.activeProposalID !== undefined;
    const supportFull = () => (quota?.activeSupports ?? 0) >= PROPOSAL_LIMITS.supports;
    const editable = () => editing && proposalStatus(proposalByID(editing.proposalID) ?? editing) === 'open'
        && proposalByID(editing.proposalID)?.canEdit;

    function renderQuota() {
        const ready = actorReady();
        $('#proposals-quota').textContent = accountState === 'guest' ? 'Sign in to use your proposal and support places.'
            : ready ? `${quota.activeSupports} / 3 active supports; ${proposalFull() ? 1 : 0} / 1 collecting proposal`
                : accountState === 'blocked' ? 'Limits unavailable until your account is confirmed.'
                    : listLoading ? 'Checking your limits...' : 'Limits could not be confirmed. Refresh the hall before making changes.';
        if (accountState !== 'guest' && !ready && accountState !== 'blocked' && listLoading) setLoading($('#proposals-quota'), 'Checking your limits');
        const notes = [];
        if (ready && supportFull()) notes.push('Cancel a collecting support to support another proposal.');
        if (ready && proposalFull()) notes.push('Edit or withdraw your collecting proposal before proposing another.');
        $('#proposals-quota-note').textContent = notes.join(' ');
        const own = $('#proposals-find-own');
        own.hidden = !ready || !proposalFull();
        own.disabled = listLoading || creating || supporting.size > 0;
    }

    function syncFields() {
        const draft = validateProposalDraft(draftValues());
        const needsSource = parentTopicID === null && (!editing || editing.hasSnapshot);
        $('#proposal-source-field').hidden = parentTopicID !== null;
        source.disabled = creating;
        const sourceError = needsSource && (!sourceTopicID || targetsLoaded && !privateTopics.some(topic => topic.ID === sourceTopicID))
            ? 'Choose one of your saved private Topics. Configure its default scene before proposing it.' : '';
        if (sourceError) draft.errors.sourceTopicID = sourceError;
        $('#proposal-source-error').textContent = attempted ? sourceError : '';
        $('#proposal-source-error').hidden = !attempted || !sourceError;
        if (!editing && parentTopicID !== null && (!targetsLoaded || !publicTopics.some(topic => topic.ID === parentTopicID))) {
            draft.errors.parentTopicID = targetsLoaded ? 'This public Topic is unavailable. Choose another Topic.' : 'Load the public Topics before proposing a scene.';
        }
        const targetError = $('#proposal-target-error');
        targetError.textContent = attempted ? draft.errors.parentTopicID ?? '' : '';
        targetError.hidden = !targetError.textContent;
        target.disabled = creating || Boolean(editing);
        target.setAttribute('aria-invalid', String(Boolean(attempted && draft.errors.parentTopicID)));
        for (const [key, input] of Object.entries(fields)) {
            const length = unicodeLength(input.value), limit = key === 'name' ? 128 : 180;
            const counter = $(`#proposal-${key}-count`), error = $(`#proposal-${key}-error`);
            counter.textContent = `${length} / ${limit}`;
            counter.classList.toggle('is-over-limit', length > limit);
            const invalid = (attempted || length > limit) && Boolean(draft.errors[key]);
            input.setAttribute('aria-invalid', String(invalid));
            error.hidden = !invalid;
            error.textContent = invalid ? draft.errors[key] : '';
            input.readOnly = creating;
        }
        submit.disabled = creating || supporting.size > 0 || listLoading || ['loading', 'failed', 'blocked'].includes(accountState)
            || accountState === 'ready' && (!actorReady() || (editing ? editConflict || !editable() : proposalFull()));
        actionLabel(submit, creating ? editing ? 'Saving...' : 'Publishing...' : accountState === 'guest' ? 'Sign in to publish'
            : editing ? 'Save edits' : 'Publish proposal', creating ? 'spinner' : editing ? 'check' : 'paper-plane');
        $('#proposal-dialog-title').textContent = editing ? 'Edit proposal' : parentTopicID !== null ? 'Propose a scene' : 'Propose a Topic';
        $('label[for="proposal-name"]').textContent = parentTopicID !== null ? 'Scene name' : 'Topic name';
        $('#proposal-review-notice').hidden = Boolean(editing);
        $('#proposal-email-notice').hidden = Boolean(editing);
        $('#proposal-edit-notice').hidden = !editing;
        if (editing) $('#proposal-edit-notice').textContent = `Saving content changes resets all supports. The deadline stays ${deadlineText(editing.expiresAt)}.`;
        $('#proposal-close').disabled = $('#proposal-cancel').disabled = creating;
        $('#proposal-editor-withdraw').hidden = !editing;
        $('#proposal-editor-withdraw').disabled = creating || listLoading || supporting.size > 0 || !actorReady() || !editable();
        form.setAttribute('aria-busy', String(creating));
        const note = $('#proposal-sign-in-note');
        note.hidden = accountState === 'ready';
        note.textContent = accountState === 'guest' ? 'Sign in with GitHub to publish. Your draft stays here.'
            : accountState === 'loading' ? 'Checking your account...'
                : accountState === 'blocked' ? 'Your account changed. Refresh this page before continuing. Your draft is kept.'
                    : accountState === 'failed' ? 'Could not confirm your account. Retry the account check in the hall. Your draft is kept.' : '';
        if (accountState === 'loading') setLoading(note, 'Checking your account');
        if (!editing && actorReady() && proposalFull() && !creating) formMessage(proposalErrorInfo({ payload: { error: 'active_topic_proposal_limit' } }));
        if (editing && proposalStatus(proposalByID(editing.proposalID) ?? editing) !== 'open' && !creating) {
            formMessage({ message: 'Collection is closed. This proposal cannot be edited or withdrawn. Your draft is kept.' });
        }
        renderQuota();
        return draft;
    }

    function renderAccount() {
        const button = $('#proposals-account');
        button.disabled = ['loading', 'blocked'].includes(accountState);
        button.removeAttribute('aria-haspopup');
        button.removeAttribute('aria-label');
        if (profile && accountState === 'ready') {
            const name = typeof profile.userName === 'string' && profile.userName.trim() ? profile.userName : 'Your account';
            const url = profileAvatarURL(profile.userProfilePictureURL);
            const avatar = url ? element('img', 'tp-avatar') : glyph('user');
            if (url) { avatar.src = url; avatar.alt = ''; avatar.referrerPolicy = 'no-referrer'; }
            button.replaceChildren(avatar, element('span', 'bp-ui-action-label', name));
            button.setAttribute('aria-haspopup', 'dialog');
            button.setAttribute('aria-label', `Open account center: ${name}`);
        } else actionLabel(button, accountState === 'guest' ? 'Sign in' : accountState === 'failed' ? 'Retry account' : 'Account', 'user');
        const accountStatus = $('#proposals-account-status');
        if (accountState === 'blocked') setMessage(accountStatus, 'Your account changed. Refresh this page before publishing or supporting. Your draft is kept.', 'refresh');
        else if (accountState === 'failed') {
            setMessage(accountStatus, 'Could not confirm your account.');
            const retry = createAction({ label: 'Retry account', icon: 'fa-solid fa-rotate-right' });
            retry.addEventListener('click', () => { void loadProfile(); });
            accountStatus.append(retry);
        } else setMessage(accountStatus, '');
        syncFields();
        syncControls();
    }

    function blockAccount() {
        pageAccountWriteScope.invalidate();
        accountState = 'blocked';
        security = null;
        quotaFresh = false;
        renderAccount();
    }

    async function loadProfile() {
        const epoch = ++accountEpoch;
        accountState = 'loading';
        security = null;
        renderAccount();
        try {
            const value = await postJSON('/api/get_user_profile', {}, READ_OPTIONS);
            if (epoch !== accountEpoch) return;
            if (value === null) {
                profile = null;
                if (boundOwner !== null) { blockAccount(); return; }
                accountState = 'guest';
            } else {
                if (typeof value?.userID !== 'string' || canonicalAccountID(value.userID) !== value.userID) throw invalidResponse();
                if (boundOwner !== null && boundOwner !== value.userID) { blockAccount(); return; }
                pageAccountWriteScope.bind(value.userID);
                boundOwner = value.userID;
                profile = value;
                accountState = 'ready';
            }
        } catch (error) {
            if (epoch !== accountEpoch) return;
            profile = null;
            if (isAccountWriteError(error) || boundOwner !== null && error.status === 401) { blockAccount(); return; }
            accountState = error.status === 401 ? 'guest' : 'failed';
        } finally {
            if (epoch === accountEpoch) renderAccount();
        }
        if (listAuthenticated !== null && listAuthenticated !== (accountState === 'ready')
            && ['guest', 'ready'].includes(accountState)) void loadPage();
    }

    function assertActor(owner, epoch) {
        if (accountState !== 'ready' || epoch !== accountEpoch || profile?.userID !== owner
            || pageAccountWriteScope.capture() !== owner) throw accountWriteError();
    }

    async function csrfFor(owner, epoch) {
        assertActor(owner, epoch);
        if (security?.owner === owner) return security.token;
        const value = await postJSON('/api/get_privacy_status', {}, READ_OPTIONS);
        assertActor(owner, epoch);
        if (value?.authenticated !== true || value.userID !== owner) throw accountWriteError();
        if (typeof value.csrfToken !== 'string' || !value.csrfToken.trim() || value.csrfToken.length > 512) throw invalidResponse();
        security = { owner, token: value.csrfToken };
        return security.token;
    }

    function handleWriteError(error) {
        if (isAccountWriteError(error)) blockAccount();
        else if (error.status === 401) {
            security = null;
            if (boundOwner !== null) blockAccount();
        } else if (error.payload?.error === 'privacy_form_expired') security = null;
    }

    const statusCopy = {
        open: ['users', 'Open for support'], pending: ['clock', 'In official review'],
        approved: ['circle-check', 'Approved'], rejected: ['circle-minus', 'Not approved'],
        expired: ['hourglass-end', 'Expired'], withdrawn: ['ban', 'Withdrawn']
    };
    const deadlineText = value => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

    function syncSupportButton(row, proposal) {
        const button = row.querySelector('[data-support-id]');
        const busy = supporting.has(proposal.proposalID);
        const guest = accountState === 'guest' && listAuthenticated === false;
        const open = proposalStatus(proposal) === 'open';
        const cancel = open && proposal.supported && proposal.canCancelSupport;
        const label = busy ? operations.get(proposal.proposalID) === 'cancel' ? 'Canceling...' : 'Supporting...'
            : cancel ? 'Cancel support' : proposal.supported ? 'Supported' : 'Support';
        button.disabled = supporting.size > 0 || creating || listLoading || !open
            || !(guest || actorReady() && (cancel || proposal.canSupport && !supportFull()));
        actionLabel(button, label, busy ? 'spinner' : cancel ? 'xmark' : proposal.supported ? 'check' : 'thumbs-up');
        button.setAttribute('aria-label', `${label} ${proposal.name}`);
        button.dataset.tooltip = !open ? 'Collection is closed. Support cannot be changed.' : cancel ? 'Cancel your support and free one active support place.'
            : guest ? 'Sign in to support this proposal.' : proposal.isMine ? 'You cannot support your own proposal.'
                : supportFull() ? 'Cancel a collecting support before supporting another proposal.' : 'Support this version of the proposal.';
        button.setAttribute('aria-busy', String(busy));
        for (const action of ['edit', 'withdraw']) {
            const control = row.querySelector(`[data-action="${action}"]`);
            if (control) control.disabled = !actorReady() || !open || creating || listLoading || supporting.size > 0;
        }
    }

    function syncControls() {
        for (const proposal of proposals.values()) {
            const row = document.getElementById(`proposal-${proposal.proposalID}`);
            if (row) syncSupportButton(row, proposal);
        }
        more.disabled = listLoading || supporting.size > 0 || creating;
        $('#proposals-refresh').disabled = listLoading || supporting.size > 0 || creating;
        $('#open-proposal').disabled = creating || supporting.size > 0;
        const withdrawingBusy = withdrawing && supporting.has(withdrawing.proposalID);
        $('#proposal-withdraw-cancel').disabled = Boolean(withdrawingBusy);
        $('#proposal-withdraw-confirm').disabled = Boolean(withdrawingBusy) || !actorReady() || listLoading
            || !withdrawing || !proposalByID(withdrawing.proposalID)?.canWithdraw
            || proposalStatus(proposalByID(withdrawing.proposalID) ?? withdrawing) !== 'open';
        actionLabel($('#proposal-withdraw-confirm'), withdrawingBusy ? 'Withdrawing...' : 'Withdraw proposal', withdrawingBusy ? 'spinner' : 'trash-can');
        withdrawDialog.setAttribute('aria-busy', String(Boolean(withdrawingBusy)));
        renderQuota();
    }

    function renderRow(proposal) {
        const row = element('li', 'tp-row');
        row.id = `proposal-${proposal.proposalID}`;
        const currentStatus = proposalStatus(proposal);
        row.dataset.status = currentStatus;
        row.dataset.revision = String(proposal.revision);
        const content = element('div', 'tp-row-content');
        const title = element('h3', '', proposal.name);
        title.id = `proposal-title-${proposal.proposalID}`;
        title.tabIndex = -1;
        const status = element('span', 'tp-row-state');
        const [icon, label] = statusCopy[currentStatus];
        status.append(glyph(icon), element('span', '', label));
        const deadline = element('p', 'tp-deadline');
        const time = element('time', '', deadlineText(proposal.expiresAt));
        time.dateTime = proposal.expiresAt;
        deadline.append(glyph('calendar-days'), document.createTextNode(currentStatus === 'open' ? 'Closes ' : currentStatus === 'expired' ? 'Expired ' : 'Collection deadline '), time);
        content.append(title, element('p', 'tp-row-description', proposal.description), status, deadline);
        if (proposal.parentTopicID != null) title.before(element('p', 'tp-deadline', `Scene in ${proposal.parentTopicName ?? 'unavailable Topic'}`));
        if (proposal.isMine) content.append(element('span', 'tp-own-label', 'Your proposal'));
        if (proposal.previewURL) content.append(createAction({ label: 'Preview & try weights', href: proposal.previewURL,
            icon: 'fa-solid fa-chart-column', className: 'tp-row-link' }));
        if (proposal.status === 'approved' && proposal.url) content.append(createAction({ label: proposal.parentTopicID != null ? 'View scene' : 'View Topic',
            href: proposal.url, icon: 'fa-solid fa-arrow-right', className: 'tp-row-link' }));
        const actions = element('div', 'tp-row-actions');
        const total = element('p', 'tp-support-total');
        total.append(element('strong', '', String(proposal.supportCount)), document.createTextNode(' / 30 supports'));
        const button = createAction({ label: 'Support', icon: 'fa-solid fa-thumbs-up', variant: 'secondary' });
        button.dataset.supportId = String(proposal.proposalID);
        button.dataset.action = 'support';
        button.addEventListener('click', event => {
            event.currentTarget.focus({ preventScroll: true });
            void mutateProposal(proposal.proposalID, proposalByID(proposal.proposalID)?.supported ? 'cancel' : 'support');
        });
        actions.append(total, button);
        if (proposal.canEdit || proposal.canWithdraw) {
            const ownerActions = element('div', 'tp-owner-actions');
            for (const [kind, icon] of [['edit', 'pen'], ['withdraw', 'trash-can']]) {
                if (!proposal[kind === 'edit' ? 'canEdit' : 'canWithdraw']) continue;
                const action = createAction({ label: `${kind === 'edit' ? 'Edit' : 'Withdraw'} ${proposal.name}`, icon: `fa-solid fa-${icon}`, iconOnly: true });
                action.dataset.action = kind;
                action.addEventListener('click', event => kind === 'edit' ? openEditor(proposals.get(proposal.proposalID), event.currentTarget)
                    : openWithdrawal(proposals.get(proposal.proposalID), event.currentTarget));
                ownerActions.append(action);
            }
            actions.append(ownerActions);
        }
        row.append(content, actions);
        const error = rowErrors.get(proposal.proposalID);
        if (error) {
            const message = element('div', 'tp-row-error');
            message.setAttribute('role', 'alert');
            setMessage(message, error.message, error.recovery);
            row.append(message);
        }
        syncSupportButton(row, proposal);
        return row;
    }

    function replaceRow(proposal) {
        const previous = document.getElementById(`proposal-${proposal.proposalID}`);
        if (!previous && !proposals.has(proposal.proposalID)) return;
        const focused = previous?.contains(document.activeElement);
        const row = renderRow(proposal);
        if (previous) previous.replaceWith(row);
        else list.prepend(row);
        if (focused) (row.querySelector('button:not(:disabled)') ?? row.querySelector('h3')).focus({ preventScroll: true });
    }

    function renderListState() {
        listStatus.hidden = proposals.size > 0;
        if (!proposals.size) {
            if (listLoading) setLoading(listStatus, 'Loading proposals');
            else {
                listStatus.replaceChildren(glyph(listFailure ? 'triangle-exclamation' : 'comments'));
                listStatus.append(element('strong', '', listFailure ? 'Could not load proposals.' : listView === 'review' ? 'No proposals are in review yet.' : 'No Topic proposals yet.'));
            }
            if (!listLoading && listFailure) {
                const retry = createAction({ label: 'Retry proposals', icon: 'fa-solid fa-rotate-right', variant: 'secondary' });
                retry.addEventListener('click', () => { void loadPage(); });
                listStatus.append(retry);
            }
        }
        const pageError = $('#proposals-page-error');
        pageError.hidden = !listFailure || !proposals.size;
        pageError.textContent = listFailure ? 'Could not load proposals. The current list is kept.' : '';
        more.hidden = !proposals.size || nextCursor === null && !listFailure;
        actionLabel(more, listLoading ? 'Loading...' : listFailure ? 'Retry loading proposals' : 'Load more proposals', listLoading ? 'spinner' : listFailure ? 'rotate-right' : 'chevron-down');
        $('#proposals-list-region').setAttribute('aria-busy', String(listLoading));
        syncFields();
        syncControls();
    }

    async function loadPage(before = null, { refresh = false } = {}) {
        if (creating || supporting.size > 0) return;
        const epoch = ++listEpoch, ownerEpoch = accountEpoch;
        listController?.abort();
        listController = new globalThis.AbortController();
        listLoading = true;
        listFailure = null;
        renderListState();
        try {
            const floor = refresh && proposals.size ? Math.min(...proposals.keys()) : null;
            const rows = [];
            let cursor = before, result;
            do {
                result = parseProposalPage(await postJSON('/api/get_topic_proposals', { view: listView, ...(cursor === null ? {} : { before: cursor }) },
                    { ...READ_OPTIONS, signal: listController.signal }), cursor);
                rows.push(...result.proposals);
                cursor = result.nextCursor;
            } while (refresh && cursor !== null && floor !== null && rows.at(-1)?.proposalID > floor);
            if (epoch !== listEpoch) return;
            if (ownerEpoch !== accountEpoch) { void loadPage(null, { refresh: true }); return; }
            if (rows.some(row => before !== null && proposals.has(row.proposalID))) throw invalidResponse();
            listAuthenticated = result.authenticated;
            quota = result.account;
            activeProposal = result.activeProposal;
            quotaFresh = true;
            listLoading = false;
            preserveView(() => {
                if (before === null) { proposals.clear(); list.replaceChildren(); }
                for (const proposal of rows) {
                    proposals.set(proposal.proposalID, proposal);
                    list.append(renderRow(proposal));
                }
                nextCursor = result.nextCursor;
                renderQuota();
                if (editing && proposalByID(editing.proposalID)?.revision !== editing.revision) {
                    editConflict = true;
                    formMessage({ message: 'This proposal changed. Your draft is kept. Review the latest version before saving.', recovery: 'latest' });
                }
            });
            scheduleDeadline();
        } catch (error) {
            if (epoch !== listEpoch || error.name === 'AbortError') return;
            listFailure = { before, refresh };
            quotaFresh = false;
        } finally {
            if (epoch === listEpoch) { listLoading = false; preserveView(renderListState); }
        }
    }

    function scheduleDeadline() {
        clearTimeout(deadlineTimer);
        const deadlines = [...proposals.values(), ...(activeProposal ? [activeProposal] : [])]
            .filter(proposal => proposalStatus(proposal) === 'open').map(proposal => Date.parse(proposal.expiresAt));
        if (!deadlines.length) return;
        deadlineTimer = setTimeout(() => {
            quotaFresh = false;
            preserveView(() => {
                for (const proposal of proposals.values()) if (proposal.status === 'open' && proposalStatus(proposal) === 'expired') replaceRow(proposal);
                syncFields();
                syncControls();
            });
            void loadPage(null, { refresh: true });
        }, Math.min(2147483647, Math.max(1, Math.min(...deadlines) - Date.now())));
    }

    const refreshErrors = new Set(['active_topic_proposal_limit', 'topic_proposal_support_limit', 'topic_proposal_changed',
        'topic_proposal_revision_required', 'topic_proposal_not_owner', 'topic_proposal_expired', 'topic_proposal_not_open', 'topic_proposal_not_found']);
    const needsRefresh = error => error?.code === 'proposal_refresh_required' || refreshErrors.has(error?.payload?.error);

    async function mutateProposal(id, operation) {
        const previous = proposalByID(id);
        if (!previous || supporting.size || creating || listLoading || proposalStatus(previous) !== 'open') return;
        if (accountState === 'guest' && listAuthenticated === false) { saveDraft(); openSignIn(); return; }
        if (!actorReady() || operation === 'support' && (!previous.canSupport || supportFull())
            || operation === 'cancel' && !previous.canCancelSupport || operation === 'withdraw' && !previous.canWithdraw) return;
        if (operation === 'withdraw' && withdrawing?.revision !== previous.revision) {
            setMessage($('#proposal-withdraw-status'), 'This proposal changed. Close this confirmation and review the current proposal.', 'hall');
            return;
        }
        const owner = profile.userID, epoch = accountEpoch;
        const path = operation === 'cancel' ? '/api/cancel_topic_proposal_support' : operation === 'withdraw'
            ? '/api/withdraw_topic_proposal' : '/api/vote_topic_proposal';
        const validate = operation === 'cancel' ? validateCanceledSupport : operation === 'withdraw' ? validateWithdrawnProposal : validateSupportedProposal;
        let refresh = false;
        supporting.add(id);
        operations.set(id, operation);
        rowErrors.delete(id);
        preserveView(() => replaceRow(previous));
        setMessage($('#proposal-withdraw-status'), '');
        syncControls();
        syncFields();
        try {
            const csrfToken = await csrfFor(owner, epoch);
            assertActor(owner, epoch);
            const value = await pageAccountWriteScope.write((path, body) => postWriteJSON(path, body, {
                timeoutMs: 20000, validateResponse: result => validate(result, previous)
            }), path, { proposalID: id, revision: previous.revision, csrfToken });
            assertActor(owner, epoch);
            const proposal = validate(value, previous);
            updateProposal(proposal);
            refresh = true;
            quotaFresh = false;
            preserveView(() => {
                if (operation === 'withdraw') withdrawDialog.close();
                setMessage($('#proposals-feedback'), operation === 'cancel' ? 'Support canceled. Your active support place is available again.'
                    : operation === 'withdraw' ? 'Proposal withdrawn. Your collecting proposal place is available again.'
                        : proposal.status === 'pending' ? 'Support recorded. This proposal has reached 30 supports and is now in official review.' : 'Support recorded.');
            });
        } catch (error) {
            handleWriteError(error);
            const info = proposalErrorInfo(error, operation);
            rowErrors.set(id, info);
            if (operation === 'withdraw') setMessage($('#proposal-withdraw-status'), info.message, info.recovery);
            refresh = needsRefresh(error);
        } finally {
            supporting.delete(id);
            operations.delete(id);
            preserveView(() => { if (proposals.has(id)) replaceRow(proposals.get(id)); });
            if (refresh && accountState === 'ready') await loadPage(null, { refresh: true });
            syncControls();
            syncFields();
        }
    }

    function closeDialog() {
        if (creating) return;
        saveDraft();
        dialog.close();
    }
    function showEditor(source) {
        trigger = source;
        attempted = false;
        formMessage(null);
        $('#proposal-latest-version').hidden = true;
        syncFields();
        dialog.showModal();
        void loadTargets();
        document.body.classList.add('tp-modal-open');
        fields.name.focus({ preventScroll: true });
    }
    function openEditor(proposal, source) {
        if (!proposal?.canEdit || !actorReady() || creating || supporting.size || listLoading || proposalStatus(proposal) !== 'open') return;
        saveDraft();
        editing = proposal;
        const draft = restoreDraft(editDraftKey(proposal), proposal);
        parentTopicID = proposal.parentTopicID ?? null; renderTargets();
        editConflict = draft.revision !== proposal.revision;
        showEditor(source);
        if (editConflict) formMessage({ message: 'Your saved draft is based on an earlier version. Review the latest version before saving.', recovery: 'latest' });
    }
    async function reviewLatestEdit() {
        if (!editing || creating || supporting.size || listLoading || accountState !== 'ready') return;
        await loadPage(null, { refresh: true });
        const latest = proposalByID(editing.proposalID);
        if (!quotaFresh) { formMessage({ message: 'Could not refresh the latest version. Your draft is kept.', recovery: 'latest' }); return; }
        if (!latest?.canEdit || proposalStatus(latest) !== 'open') {
            formMessage({ message: 'Collection is closed. This proposal cannot be edited. Your draft is kept.' });
            syncFields();
            return;
        }
        const baseline = $('#proposal-latest-version');
        baseline.replaceChildren(element('strong', '', 'Latest published version'), element('p', '', latest.name), element('p', '', latest.description));
        baseline.hidden = false;
        editing = latest;
        editConflict = false;
        saveDraft();
        formMessage({ message: 'Your draft is unchanged. Compare it with the latest version above before saving.' });
        syncFields();
    }
    let withdrawTrigger;
    function openWithdrawal(proposal, source) {
        if (!proposal?.canWithdraw || !actorReady() || creating || supporting.size || listLoading || proposalStatus(proposal) !== 'open') return;
        withdrawing = proposal;
        withdrawTrigger = source;
        $('#proposal-withdraw-name').textContent = proposal.name;
        setMessage($('#proposal-withdraw-status'), '');
        syncControls();
        withdrawDialog.showModal();
        document.body.classList.add('tp-modal-open');
        $('#proposal-withdraw-cancel').focus({ preventScroll: true });
    }
    function closeWithdrawal() {
        if (supporting.size) return;
        withdrawDialog.close();
    }
    function returnFocus(source, proposal) {
        if (source?.isConnected) source.focus({ preventScroll: true });
        else (document.getElementById(source?.closest('.tp-row')?.id ?? `proposal-${proposal?.proposalID}`)?.querySelector('h3'))?.focus({ preventScroll: true });
    }
    $('#open-proposal').disabled = false;
    $('#open-proposal').addEventListener('click', event => {
        saveDraft();
        editing = null;
        editConflict = false;
        restoreDraft(DRAFT_KEY);
        showEditor(event.currentTarget);
    });
    $('#proposal-close').addEventListener('click', closeDialog);
    $('#proposal-cancel').addEventListener('click', closeDialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    const trapFocus = host => host.addEventListener('keydown', event => {
        if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation();
        if (event.key !== 'Tab') return;
        const items = [...host.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]')]
            .filter(node => node.getClientRects().length);
        if (!items.length) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement);
        const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : (index + 1) % items.length;
        items[next].focus();
    });
    trapFocus(dialog);
    trapFocus(withdrawDialog);
    dialog.addEventListener('close', () => {
        document.body.classList.toggle('tp-modal-open', withdrawDialog.open);
        returnFocus(trigger, editing);
    });
    $('#proposal-withdraw-cancel').addEventListener('click', closeWithdrawal);
    $('#proposal-withdraw-confirm').addEventListener('click', () => { if (withdrawing) void mutateProposal(withdrawing.proposalID, 'withdraw'); });
    withdrawDialog.addEventListener('cancel', event => { event.preventDefault(); closeWithdrawal(); });
    withdrawDialog.addEventListener('close', () => {
        document.body.classList.toggle('tp-modal-open', dialog.open);
        returnFocus(withdrawTrigger, withdrawing);
    });
    $('#proposal-editor-withdraw').addEventListener('click', () => {
        if (!editing || !editable() || creating || supporting.size || listLoading) return;
        const proposal = proposalByID(editing.proposalID);
        saveDraft();
        dialog.close();
        openWithdrawal(proposal, trigger);
    });
    for (const field of Object.values(fields)) field.addEventListener('input', () => {
        formMessage(null);
        syncFields();
        if (editConflict) formMessage({ message: 'Your draft is kept. Review the latest version before saving.', recovery: 'latest' });
        saveDraft();
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (creating || supporting.size > 0 || listLoading || editConflict) return;
        attempted = true;
        const draft = syncFields();
        if (Object.keys(draft.errors).length) { (fields[Object.keys(draft.errors)[0]] ?? target).focus(); return; }
        saveDraft();
        if (accountState === 'guest') { openSignIn(); return; }
        if (!actorReady() || (editing ? !editable() : proposalFull())) return;
        const owner = profile.userID, epoch = accountEpoch;
        const previous = editing;
        const operation = previous ? 'edit' : 'publish';
        let refresh = false;
        creating = true;
        formMessage(null);
        syncFields();
        syncControls();
        try {
            const csrfToken = await csrfFor(owner, epoch);
            assertActor(owner, epoch);
            const body = { name: draft.name, description: draft.description, csrfToken,
                ...(parentTopicID === null && sourceTopicID !== null ? { sourceTopicID } : {}),
                ...(!previous && parentTopicID !== null ? { parentTopicID } : {}),
                ...(previous ? { proposalID: previous.proposalID, revision: previous.revision } : {}) };
            const validate = result => previous ? validateEditedProposal(result, previous, body) : validatePublishedProposal(result, body);
            const value = await pageAccountWriteScope.write((path, payload) => postWriteJSON(path, payload, {
                timeoutMs: 20000, validateResponse: validate
            }), previous ? '/api/edit_topic_proposal' : '/api/propose_topic', body);
            assertActor(owner, epoch);
            const proposal = validate(value);
            updateProposal(proposal, !previous);
            refresh = true;
            quotaFresh = false;
            preserveView(() => replaceRow(proposal));
            for (const field of Object.values(fields)) field.value = '';
            parentTopicID = null; renderTargets();
            attempted = false;
            const draftKey = previous ? editDraftKey(previous) : DRAFT_KEY;
            drafts.delete(draftKey);
            try { sessionStorage.removeItem(draftKey); } catch { /* The in-memory draft was cleared. */ }
            preserveView(() => {
                dialog.close();
                setMessage($('#proposals-feedback'), previous ? proposal.revision === previous.revision
                    ? 'Proposal unchanged. Existing supports and the deadline are kept.' : 'Edits saved. Earlier supports were reset; the original deadline is unchanged.'
                    : `Proposal published${proposal.supportCount === 0 ? ' with 0 supports' : ''}. It needs 30 supports from other accounts before official review.`);
                renderListState();
            });
            if (previous) { editing = null; restoreDraft(DRAFT_KEY); }
        } catch (error) {
            handleWriteError(error);
            refresh = needsRefresh(error);
            if (previous && (error?.code === 'proposal_refresh_required' || error.payload?.error === 'topic_proposal_changed')) editConflict = true;
            formMessage({ ...proposalErrorInfo(error, operation), ...(editConflict ? { recovery: 'latest' } : {}) });
        } finally {
            creating = false;
            if (refresh && accountState === 'ready') await loadPage(null, { refresh: true });
            syncFields();
            syncControls();
            if (dialog.open) (submit.disabled ? $('#proposal-form-status button:not(:disabled)') ?? fields.name : submit).focus({ preventScroll: true });
        }
    });
    more.addEventListener('click', () => {
        if (!listLoading && !supporting.size && !creating) void loadPage(listFailure ? listFailure.before : nextCursor, { refresh: Boolean(listFailure?.refresh) });
    });
    for (const tab of document.querySelectorAll('[data-proposals-view]')) {
        tab.addEventListener('click', () => {
            if (tab.dataset.proposalsView === listView || creating || supporting.size > 0) return;
            listView = tab.dataset.proposalsView;
            for (const other of document.querySelectorAll('[data-proposals-view]')) {
                const selected = other === tab;
                other.setAttribute('aria-selected', String(selected));
                other.tabIndex = selected ? 0 : -1;
            }
            proposals.clear(); list.replaceChildren(); nextCursor = null;
            void loadPage();
        });
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const tabs = [...document.querySelectorAll('[data-proposals-view]')];
            const index = tabs.indexOf(tab);
            const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(index + 1) % tabs.length];
            next.click(); next.focus();
        });
    }
    $('#proposals-find-own').addEventListener('click', event => openEditor(activeProposal, event.currentTarget));
    $('#proposals-refresh').addEventListener('click', hallRecovery);
    $('#proposals-account').addEventListener('click', async event => {
        if (accountState === 'guest') { saveDraft(); openSignIn(); return; }
        if (accountState === 'failed') { void loadProfile(); return; }
        if (accountState !== 'ready') return;
        event.currentTarget.focus({ preventScroll: true });
        try {
            const { openAccountCenter } = await import('./shared/account-center.js');
            await openAccountCenter({ profile, onProfileSaved: saved => { profile = { ...profile, ...saved }; renderAccount(); },
                onSignedOut: () => { accountEpoch++; profile = null; blockAccount(); void loadPage(); } });
        } catch { setMessage($('#proposals-account-status'), 'Account center is unavailable.', 'privacy'); }
    });
    installSignInLinks();
    listenAccountChange(signal => {
        if (signal === null && boundOwner !== null) { accountEpoch++; profile = null; blockAccount(); void loadPage(); }
        else void loadProfile().then(() => loadPage());
    });
    window.addEventListener('pagehide', () => clearTimeout(deadlineTimer));
    syncFields();
    void Promise.all([loadProfile(), loadPage()]).then(() => {
        if (positiveID(requestedSource) && accountState === 'ready' && !proposalFull()) {
            editing = null; sourceTopicID = requestedSource; parentTopicID = null;
            fields.name.value = ''; fields.description.value = ''; showEditor($('#open-proposal'));
        }
    });
}

if (typeof document !== 'undefined' && document.getElementById('proposal-hall')) mountProposalHall();
