import { estimationVotePairKey } from '../shared/estimation-votes.js';
import { createAction } from '../shared/ui-components.js';
import { expandCommunityVersions, groupBenchmarkRows, versionChoiceOrder } from '../shared/benchmark-version-choice.js';
import { benchmarkEvaluationOrder, groupedEvaluationOrder } from '../shared/benchmark-version-order.js';
import { createEvidenceCount, updateEvidenceCount } from '../shared/evidence-count.js';
import { setHelpText } from '../shared/help-popover.js';
import { excludedFromRanking } from '../shared/aa-ranking-policy.js';
import { createExternalVersionPicker } from './external-version-picker.js';

function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

export const versionName = version => version.conditionName?.toLowerCase() === 'default' ? 'Default evaluation' : version.conditionName;
const scoringHelp = 'Scoring shares are weighted by each person’s allocation to this benchmark.';
const estimationHelp = 'Estimation support is the share of sitewide votes allowing these two versions to help estimate each other. '
    + 'A source is eligible unless opposition exceeds support. Versions of the same benchmark are eligible by default. External versions appear while the pair has recent support.';
const personalScoringHelp = 'Choose one scoring version. Select it again to follow the community.';
const personalEstimationHelp = 'Your vote applies to this pair in both directions across all topics and scenes. '
    + 'Select the same thumb again to clear your vote.';

function percentage(points = 0) {
    if (points > 0 && points < 1) return '<0.01%';
    if (points > 9999 && points < 10000) return '>99.99%';
    return `${Number((points / 100).toFixed(2))}%`;
}

export function selectedScoringCondition(entries) {
    return entries.length === 1 && entries[0].followCommunityVersion !== true ? entries[0].conditionID : null;
}

function icon(className) {
    const element = node('i', className);
    element.setAttribute('aria-hidden', 'true');
    return element;
}

function describe(element, description) {
    element.setAttribute('aria-label', description);
    element.dataset.tooltip = description;
}

function supportsEstimation({ estimationVoting, group, catalogue }) {
    return estimationVoting === true && (group.versions.length > 1 || catalogue?.length > 1);
}

function statusText({ readOnly, entries, group }, active, target, estimationAvailable) {
    if (readOnly) {
        if (target) return `Read-only. Inspecting estimation sources for ${versionName(target)}.`;
        return estimationAvailable ? 'Read-only. Choose a version to inspect its estimation sources.' : 'Read-only';
    }
    if (entries.length > 1) return 'Choose a scoring version to replace your saved version mix.';
    if (target) return `Scoring with ${versionName(target)}. Select it again to follow the community.`;
    if (active !== null) return 'Select it again to follow the community.';
    return group.isDefault ? 'Using the default scoring version.' : 'Following community scoring versions.';
}

function orderedExternalVersions({ catalogue, group, publicEntries = [], personalEntries = [], pinPersonal }) {
    const publicWeights = new Map();
    for (const entry of expandCommunityVersions(publicEntries, catalogue)) {
        publicWeights.set(entry.conditionID, (publicWeights.get(entry.conditionID) ?? 0) + entry.weightBasisPoints);
    }
    const personalWeights = new Map(personalEntries.map(entry => [entry.conditionID, entry.weightBasisPoints]));
    const versions = catalogue.filter(item => item.benchmarkID !== group.benchmarkID).flatMap(item => item.versions
        .filter(version => !excludedFromRanking(version)).map(version => ({
            ...version, name: item.name, versionLabel: versionName(version),
            publicWeightBasisPoints: publicWeights.get(version.conditionID) ?? 0,
            personalWeightBasisPoints: personalWeights.get(version.conditionID) ?? null
        })));
    const groups = groupBenchmarkRows(versions).sort((left, right) =>
        (pinPersonal ? (right.personalWeightBasisPoints ?? 0) - (left.personalWeightBasisPoints ?? 0) : 0)
        || groupedEvaluationOrder(left, right));
    const order = new Map(groups.map((item, index) => [item.benchmarkID, index]));
    return versions.sort((left, right) => order.get(left.benchmarkID) - order.get(right.benchmarkID)
        || benchmarkEvaluationOrder(left, right));
}

export function createBenchmarkSettings({ host, selectedHeader, getScope, getData, onVersion, onVote }) {
    const title = node('h3', 'bp-benchmark-settings-title');
    title.hidden = Boolean(selectedHeader);
    const status = node('p', 'bp-benchmark-settings-status');
    status.setAttribute('role', 'status');
    const heading = node('div', 'bp-version-choices-heading');
    const scoringHeading = node('div', 'bp-scoring-versions-heading');
    const estimationHeading = node('span', 'bp-estimation-heading', 'Estimation support');
    const help = createAction({ label: 'About scoring versions and score estimation', icon: 'fa-regular fa-circle-question', iconOnly: true });
    scoringHeading.append(node('span', '', 'Scoring version'), help);
    heading.append(scoringHeading, estimationHeading);
    const list = node('ul', 'bp-version-choices');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Benchmark versions');
    const scroller = node('div', 'bp-benchmark-settings-scroll');
    scroller.append(title, status, heading, list);
    const external = node('section', 'bp-external-versions');
    external.setAttribute('aria-labelledby', 'external-versions-title');
    external.hidden = true;
    const externalHeading = node('header', 'bp-external-versions-heading');
    const externalTitle = node('h4', '', 'External versions');
    externalTitle.id = 'external-versions-title';
    const externalList = node('ul', 'bp-version-choices');
    externalList.setAttribute('role', 'list');
    externalList.setAttribute('aria-label', 'Nominated external versions');
    const picker = node('button', 'bp-version-nomination');
    picker.type = 'button';
    picker.setAttribute('aria-label', 'Nominate a version from another benchmark');
    picker.append(icon('fa-solid fa-plus'), node('span', '', 'Add version'));
    const versionPicker = createExternalVersionPicker({ trigger: picker, scrollAnchor: host.closest('.bp-pie-card'), onChoose(source) {
        const current = data();
        const targetID = current && selectedScoringCondition(current.entries);
        return targetID != null && current.editable && !current.readOnly && current.authenticated && !current.busy
            && targetID === intent.externalTargetID && onVote(current.group, targetID, source.conditionID, 'support', true);
    } });
    const login = node('a', '', 'Sign in to nominate a version');
    login.href = '/github_login';
    externalHeading.append(externalTitle, picker, login);
    external.append(externalHeading, externalList);
    host.append(scroller, external, versionPicker.panel);
    const externalSize = new ResizeObserver(() => {
        host.style.setProperty('--bp-external-versions-height', `${external.getBoundingClientRect().height}px`);
    });
    externalSize.observe(external);

    const rows = new Map(), externalRows = new Map();
    let intent = null;

    function clearRows() {
        rows.clear();
        list.replaceChildren();
    }

    function close() {
        if (intent) {
            scroller.scrollTop = 0;
            clearRows();
            externalRows.clear();
            externalList.replaceChildren();
        }
        versionPicker.close();
        external.hidden = true;
        host.hidden = true;
        intent = null;
    }

    function data() {
        return intent && intent.scope === getScope() ? getData(intent.benchmarkID) : null;
    }

    function chooseVersion(conditionID) {
        const current = data();
        if (!current || current.busy) return;
        if (current.readOnly) {
            if (!supportsEstimation(current)) return;
            intent.inspectedConditionID = intent.inspectedConditionID === conditionID ? null : conditionID;
            refresh();
        } else if (current.editable) {
            const next = selectedScoringCondition(current.entries) === conditionID ? null : conditionID;
            if (onVersion(current.group, next)) refresh();
        }
    }

    function chooseVote(sourceConditionID, vote) {
        const current = data();
        if (!current?.editable || current.busy || current.readOnly || !supportsEstimation(current)) return;
        const targetConditionID = selectedScoringCondition(current.entries);
        if (targetConditionID === null || targetConditionID === sourceConditionID) return;
        const key = estimationVotePairKey(targetConditionID, sourceConditionID);
        const previous = current.personalEstimationVotes.find(item => estimationVotePairKey(item.targetConditionID, item.sourceConditionID) === key)?.vote;
        if (onVote(current.group, targetConditionID, sourceConditionID, previous === vote ? null : vote)) refresh();
    }

    function createVote(sourceConditionID, vote) {
        const element = node('button', 'bp-estimation-vote');
        const glyph = icon('');
        const value = node('span', 'bp-estimation-vote-count');
        value.setAttribute('aria-hidden', 'true');
        element.type = 'button';
        element.dataset.vote = vote;
        element.append(glyph, value);
        element.addEventListener('click', () => chooseVote(sourceConditionID, vote));
        return { element, glyph, value };
    }

    function createEstimation(sourceConditionID, readOnly) {
        const panel = node('div', 'bp-estimation-result');
        const rate = node('span', 'bp-estimation-rate');
        rate.setAttribute('role', 'img');
        panel.append(rate);
        if (readOnly) return { panel, rate };
        const votes = node('div', 'bp-estimation-votes');
        const support = createVote(sourceConditionID, 'support');
        const oppose = createVote(sourceConditionID, 'oppose');
        votes.append(support.element, oppose.element);
        panel.append(votes);
        return { panel, rate, support, oppose };
    }

    function createRow(conditionID, interactive) {
        const row = node('li', 'bp-version-choice-row');
        row.dataset.conditionId = String(conditionID);
        const choice = node(interactive ? 'button' : 'span', 'bp-version-choice');
        choice.dataset.conditionId = String(conditionID);
        const indicator = icon('');
        indicator.hidden = !interactive;
        const details = node('span', 'bp-version-choice-details');
        const name = node('span', 'bp-version-choice-name');
        const metadata = node('span', 'bp-version-choice-metadata');
        const scores = createEvidenceCount(0);
        scores.removeAttribute('tabindex');
        const share = node('span', 'bp-version-choice-share');
        share.setAttribute('role', 'img');
        metadata.append(scores, share);
        details.append(name, metadata);
        choice.append(indicator, details);
        if (interactive) {
            choice.type = 'button';
            choice.addEventListener('click', () => chooseVersion(conditionID));
        }
        row.append(choice);
        list.append(row);
        return { row, choice, name, indicator, scores, share, estimation: null };
    }

    function updateVote(button, vote, direction, count, pressed, disabled) {
        const { element, glyph, value } = button;
        const supporting = vote === 'support';
        const label = `${supporting ? 'Support' : 'Oppose'} ${direction}`;
        const description = `${count} community ${count === 1 ? 'vote' : 'votes'}.`;
        glyph.className = `fa-${pressed ? 'solid' : 'regular'} fa-thumbs-${supporting ? 'up' : 'down'}`;
        value.textContent = String(count);
        element.disabled = disabled;
        element.setAttribute('aria-pressed', String(pressed));
        element.setAttribute('aria-label', label);
        element.setAttribute('aria-description', description);
        element.dataset.tooltip = `${label}. ${description}`;
    }

    function updateChoice(row, version, active, readOnly, interactive, disabled) {
        const name = versionName(version);
        const share = percentage(version.selectionBasisPoints);
        const shareDescription = `${share} community scoring version share`;
        row.name.textContent = name;
        updateEvidenceCount(row.scores, version.scoreCount);
        row.share.textContent = share;
        describe(row.share, shareDescription);
        if (!interactive) return;
        row.choice.disabled = disabled;
        row.choice.setAttribute('aria-pressed', String(active));
        row.choice.setAttribute('aria-label', readOnly
            ? `Inspect estimation sources for ${name}` : `Use ${name} for scoring`);
        row.choice.setAttribute('aria-description', `${row.scores.getAttribute('aria-label')} ${shareDescription}.`);
        row.indicator.className = readOnly ? `fa-${active ? 'solid' : 'regular'} fa-eye`
            : active ? 'fa-solid fa-circle-check' : 'fa-regular fa-circle';
    }

    function updateEstimation(row, source, target, vote, counts, readOnly, disabled) {
        if (!target || source.conditionID === target.conditionID) {
            if (row.estimation) row.estimation.panel.remove();
            row.estimation = null;
            return;
        }
        if (!row.estimation) {
            row.estimation = createEstimation(source.conditionID, readOnly);
            row.row.append(row.estimation.panel);
        }
        const { panel, rate, support, oppose } = row.estimation;
        const { supportCount = 0, opposeCount = 0 } = counts ?? {};
        const total = supportCount + opposeCount;
        const direction = `mutual estimation between ${versionName(target)} and ${source.externalName ?? versionName(source)}`;
        rate.hidden = total === 0;
        panel.hidden = readOnly && total === 0;
        if (total) {
            const share = percentage(supportCount / total * 10000);
            rate.textContent = share;
            describe(rate, `${share} community support for ${direction}. ${supportCount} in support, ${opposeCount} opposed.`);
        } else {
            rate.textContent = '';
            rate.removeAttribute('aria-label');
            delete rate.dataset.tooltip;
        }
        if (readOnly) return;
        updateVote(support, 'support', direction, supportCount, vote === 'support', disabled);
        updateVote(oppose, 'oppose', direction, opposeCount, vote === 'oppose', disabled);
    }

    function refresh(primary, expanded) {
        if (primary !== undefined) {
            if (!primary || !expanded) { close(); return; }
            const scope = getScope();
            if (intent?.scope !== scope || intent?.benchmarkID !== primary.benchmarkID) {
                close();
                intent = { scope, benchmarkID: primary.benchmarkID, inspectedConditionID: null };
            }
        }
        const current = data();
        if (!current) { close(); return; }
        const { group, entries, readOnly, editable, busy, personalEstimationVotes, communityEstimationVotes } = current;
        const estimationAvailable = supportsEstimation(current);
        const interactive = !readOnly || estimationAvailable;
        const active = readOnly ? intent.inspectedConditionID : selectedScoringCondition(entries);
        const versions = new Map(group.versions.map(version => [version.conditionID, version]));
        const target = estimationAvailable ? versions.get(active) : null;
        const message = statusText(current, active, target, estimationAvailable);
        if (status.textContent !== message) status.textContent = message;
        if (title.textContent !== group.name) title.textContent = group.name;
        host.setAttribute('aria-label', `Advanced settings for ${group.name}`);
        host.dataset.estimation = String(Boolean(target));
        estimationHeading.hidden = !target;
        if (intent.readOnly !== readOnly || intent.interactive !== interactive) {
            clearRows();
            Object.assign(intent, { readOnly, interactive });
        }
        if (host.dataset.readonly !== String(readOnly) || intent.estimationAvailable !== estimationAvailable) {
            host.dataset.readonly = String(readOnly);
            intent.estimationAvailable = estimationAvailable;
            const instructions = [scoringHelp];
            if (!readOnly) instructions.unshift(personalScoringHelp);
            if (estimationAvailable) {
                instructions.push(estimationHelp);
                if (!readOnly) instructions.push(personalEstimationHelp);
            }
            setHelpText(help, instructions.join(' '));
        }
        const pairMap = rows => new Map(rows.map(item => [estimationVotePairKey(item.targetConditionID, item.sourceConditionID), item]));
        const personalVotes = pairMap(readOnly ? [] : personalEstimationVotes), counts = pairMap(communityEstimationVotes);
        const updatePair = (row, version, disabled) => {
            const key = target && estimationVotePairKey(target.conditionID, version.conditionID);
            updateEstimation(row, version, target, personalVotes.get(key)?.vote, counts.get(key), readOnly, disabled);
        };
        for (const [conditionID, row] of rows) {
            if (!versions.has(conditionID)) { row.row.remove(); rows.delete(conditionID); }
        }
        // Existing rows stay in place through rank refreshes. A new visit starts with current community proportions.
        const disabled = busy || (!readOnly && !editable);
        for (const version of [...versions.values()].sort(versionChoiceOrder)) {
            const { conditionID } = version;
            if (!rows.has(conditionID)) rows.set(conditionID, createRow(conditionID, interactive));
            const row = rows.get(conditionID);
            updateChoice(row, version, active === conditionID, readOnly, interactive, disabled);
            updatePair(row, version, disabled);
        }
        refreshExternalVersions(current, target, updatePair, disabled);
        host.hidden = false;
    }

    function refreshExternalVersions(current, target, updatePair, disabled) {
        const targetID = target?.conditionID;
        if (intent.externalTargetID !== targetID || intent.externalReadOnly !== current.readOnly) {
            versionPicker.close();
            externalRows.clear();
            externalList.replaceChildren();
            externalList.scrollTop = 0;
            intent.externalTargetID = targetID;
            intent.externalReadOnly = current.readOnly;
        }
        const nominatedIDs = new Set();
        for (const { targetConditionID, sourceConditionID } of current.externalPairs ?? []) {
            if (targetConditionID === targetID) nominatedIDs.add(sourceConditionID);
            if (sourceConditionID === targetID) nominatedIDs.add(targetConditionID);
        }
        for (const [ID, row] of externalRows) if (!nominatedIDs.has(ID)) {
            row.row.remove();
            externalRows.delete(ID);
        }
        const catalogue = current.catalogue ?? [];
        if (nominatedIDs.size) for (const group of catalogue) {
            if (group.benchmarkID === current.group.benchmarkID) continue;
            for (const version of group.versions) if (nominatedIDs.has(version.conditionID)) {
                const name = group.name + ' · ' + versionName(version);
                let row = externalRows.get(version.conditionID);
                if (!row) {
                    const item = node('li', 'bp-version-choice-row');
                    item.dataset.externalConditionId = String(version.conditionID);
                    item.append(node('span', 'bp-version-choice-name', name));
                    externalList.append(item);
                    row = { row: item, estimation: null };
                    externalRows.set(version.conditionID, row);
                }
                row.row.firstElementChild.textContent = name;
                updatePair(row, { ...version, externalName: name }, disabled);
            }
        }
        external.hidden = !target || catalogue.length <= 1 || current.readOnly && !externalRows.size;
        picker.hidden = current.readOnly || !current.authenticated;
        login.hidden = current.readOnly || current.authenticated;
        const canNominate = !external.hidden && !picker.hidden && current.editable;
        if (!canNominate) { versionPicker.close(); return; }
        const inputs = [catalogue, current.publicEntries, current.personalEntries, current.pinPersonal];
        if (inputs.some((item, index) => item !== intent.candidateInputs?.[index])) {
            intent.candidateInputs = inputs;
            intent.candidates = orderedExternalVersions(current);
        }
        versionPicker.update(intent.candidates, nominatedIDs, disabled);
    }

    return { refresh, close };
}
