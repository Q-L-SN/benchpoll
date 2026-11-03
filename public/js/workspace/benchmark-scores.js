import { setLoading } from '../shared/loading.js';
import { postJSON } from '../shared/http.js';
import { buildResultEditURL } from './links.js?v=clean-urls-20260908';
import { animateContent, mountDisclosureMotion } from '../shared/motion.js';
import { createOrganizationMark } from '../shared/organization-logos.js?v=organization-logos-20261006';
import { protectModelName } from '../shared/model-name.js?v=model-name-translation-20261006';
import { AA_DISPLAY_RESTRICTION, AA_DISPLAY_MESSAGE } from '../shared/aa-ranking-policy.js';

const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
};
function scoreRow(score, condition) {
    const row = node('article', 'benchmark-score-row');
    row.dataset.scoreId = String(score.ID);
    const heading = node('div', 'benchmark-score-identity');
    const mark = createOrganizationMark(score, 'benchmark-score-vendor');
    heading.append(mark, protectModelName(node('strong', '', score.modelName)),
        node('span', 'benchmark-score-value', `${score.rawScore}${condition.usesPercentageScale ? '%' : ''}`));
    row.append(heading);
    if (score.fields.length) {
        const details = node('details', 'benchmark-score-fields');
        details.append(node('summary', '', `Run fields (${score.fields.length})`));
        const list = node('dl');
        for (const field of score.fields) list.append(node('dt', '', field.name), node('dd', '', field.value));
        details.append(list); row.append(details);
    }
    const footer = node('div', 'benchmark-score-source');
    if (score.sourceURL) {
        const url = new URL(score.sourceURL);
        if (['http:', 'https:'].includes(url.protocol)) {
            const link = node('a', '', score.sourceTitle || url.hostname.replace(/^www\./, ''));
            link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.dataset.tooltip = url.href; footer.append(link);
        } else footer.append(node('span', '', 'Source link unavailable'));
    } else footer.append(node('span', '', 'No source link'));
    const edit = node('a', 'benchmark-score-change');
    edit.href = buildResultEditURL(score); edit.dataset.tooltip = 'Change this score'; edit.setAttribute('aria-label', `Change score for ${score.modelName}`);
    const icon = node('i', 'fa-regular fa-pen-to-square'); icon.setAttribute('aria-hidden', 'true'); edit.append(icon);
    footer.append(edit); row.append(footer);
    return row;
}

function validatePayload(payload, benchmarkID, conditionID) {
    const validRestriction = value => value == null || value === AA_DISPLAY_RESTRICTION;
    const restricted = payload?.displayRestriction === AA_DISPLAY_RESTRICTION;
    if (payload?.benchmarkID !== benchmarkID || payload.conditionID !== conditionID
        || !validRestriction(payload.displayRestriction)
        || (payload.omittedScores !== undefined && typeof payload.omittedScores !== 'boolean')
        || !Array.isArray(payload.conditions) || !Array.isArray(payload.scores)
        || payload.scores.length > 50 || !payload.conditions.some(condition => condition.ID === conditionID)
        || new Set(payload.conditions.map(condition => condition.ID)).size !== payload.conditions.length
        || payload.conditions.some(condition => !Number.isSafeInteger(condition.ID) || condition.ID < 1
            || typeof condition.name !== 'string' || typeof condition.usesPercentageScale !== 'boolean'
            || !validRestriction(condition.displayRestriction)
            || (condition.displayRestriction === AA_DISPLAY_RESTRICTION ? condition.scoreCount !== null
                : !Number.isSafeInteger(condition.scoreCount) || condition.scoreCount < 0))
        || restricted !== (payload.conditions.find(condition => condition.ID === conditionID)?.displayRestriction === AA_DISPLAY_RESTRICTION)
        || (restricted && (payload.scores.length !== 0 || payload.nextBeforeID !== null))
        || payload.scores.some(score => !Number.isSafeInteger(score.ID) || score.ID < 1 || !Number.isFinite(score.rawScore)
            || !['modelName', 'vendorName'].every(key => typeof score[key] === 'string')
            || !Array.isArray(score.fields) || score.fields.some(field => typeof field.name !== 'string' || typeof field.value !== 'string')
            || (score.sourceURL && !URL.canParse(score.sourceURL)))
        || !(payload.nextBeforeID === null || (payload.scores.length === 50 && payload.nextBeforeID === payload.scores.at(-1).ID))) {
        throw new Error('Invalid benchmark scores response');
    }
}

export function createBenchmarkScoresView({ onViewChange }) {
    const $ = id => document.getElementById(id);
    const view = $('benchmark-scores-view'), list = $('benchmark-scores-list'), selector = $('benchmark-scores-condition');
    const status = $('benchmark-scores-status'), more = $('benchmark-scores-more'), retry = $('benchmark-scores-retry');
    let information = null, sequence = 0, active = false, nextBeforeID = null, retryAppend = false;
    mountDisclosureMotion(list, 'details');

    async function load(append = false) {
        const current = ++sequence;
        const benchmarkID = information.benchmarkID, conditionID = Number(selector.value), cursor = nextBeforeID;
        if (!append) { list.replaceChildren(); $('benchmark-scores-count').textContent = ''; nextBeforeID = null; }
        more.hidden = retry.hidden = true;
        list.setAttribute('aria-busy', 'true'); setLoading(status, 'Loading scores...');
        try {
            const payload = await postJSON('/api/get_benchmark_scores', { benchmarkID, conditionID, ...(append ? { beforeID: cursor } : {}) }, { timeoutMs: 60000 });
            if (current !== sequence || !active) return;
            validatePayload(payload, benchmarkID, conditionID);
            selector.replaceChildren(...payload.conditions.map(condition => {
                const option = node('option', '', condition.displayRestriction === AA_DISPLAY_RESTRICTION
                    ? condition.name : `${condition.name} (${condition.scoreCount})`);
                option.value = String(condition.ID); return option;
            }));
            selector.value = String(conditionID);
            if (payload.displayRestriction === AA_DISPLAY_RESTRICTION) {
                list.replaceChildren(); nextBeforeID = null;
                $('benchmark-scores-count').textContent = '';
                status.textContent = AA_DISPLAY_MESSAGE;
                return;
            }
            const condition = payload.conditions.find(condition => condition.ID === conditionID);
            const rows = payload.scores.map(score => scoreRow(score, condition));
            list.append(...rows);
            if (!append) animateContent(list);
            $('benchmark-scores-count').textContent = `${condition.scoreCount.toLocaleString('en')} approved score${condition.scoreCount === 1 ? '' : 's'}`;
            nextBeforeID = payload.nextBeforeID; more.hidden = nextBeforeID === null;
            status.textContent = payload.omittedScores
                ? 'Artificial Analysis scores are hidden to respect their data-use terms.'
                : list.children.length ? '' : 'No approved scores for this benchmark version yet.';
        } catch (error) {
            if (current !== sequence || !active) return;
            status.textContent = 'Could not load scores. Please try again.';
            retryAppend = append; retry.hidden = false; console.error(error);
        } finally { if (current === sequence) list.setAttribute('aria-busy', 'false'); }
    }
    function reset() {
        sequence++; active = false; information = null; nextBeforeID = null;
        list.setAttribute('aria-busy', 'false');
        list.replaceChildren(); selector.replaceChildren(); status.textContent = '';
        $('benchmark-scores-count').textContent = ''; more.hidden = retry.hidden = true;
        onViewChange(false);
    }
    $('benchmark-scores-back').addEventListener('click', () => {
        sequence++; active = false; list.setAttribute('aria-busy', 'false');
        onViewChange(false);
    });
    selector.addEventListener('change', () => { void load(); });
    more.addEventListener('click', () => { if (nextBeforeID !== null) void load(true); });
    retry.addEventListener('click', () => { void load(retryAppend); });
    return { reset, open(info) {
        information = info; active = true; nextBeforeID = null;
        const option = node('option', '', info.conditionName); option.value = String(info.conditionID);
        selector.replaceChildren(option); onViewChange(true); animateContent(view);
        selector.focus({ preventScroll: true }); void load();
    } };
}
