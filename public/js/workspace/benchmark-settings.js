import { createAction } from '../shared/ui-components.js';
import { versionChoiceOrder } from '../shared/benchmark-version-choice.js';
import { createEvidenceCount, updateEvidenceCount } from '../shared/evidence-count.js';
import { setHelpText } from '../shared/help-popover.js';

function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

const versionName = version => version.conditionName?.toLowerCase() === 'default' ? 'Default evaluation' : version.conditionName;
const scoringHelp = 'Scoring shares are weighted by each person’s allocation to this benchmark.';
const estimationHelp = 'Estimation support is the share of votes in favor of using a source to estimate missing scores for the chosen scoring version. '
    + 'A source is eligible unless opposition exceeds support. Sources with no votes are eligible by default.';
const personalScoringHelp = 'Choose one scoring version. Select it again to follow the community.';
const personalEstimationHelp = 'Vote to set whether a source can estimate missing scores for the scoring version you chose. '
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

function supportsEstimation({ estimationVoting, group }) {
    return estimationVoting === true && group.versions.length > 1;
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
    host.append(title, status, heading, list);

    const rows = new Map();
    let intent = null;

    function clearRows() {
        rows.clear();
        list.replaceChildren();
    }

    function close() {
        if (intent) clearRows();
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
        const previous = current.personalEstimationVotes.find(item => item.targetConditionID === targetConditionID
            && item.sourceConditionID === sourceConditionID)?.vote;
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
        const { rate, support, oppose } = row.estimation;
        const { supportCount = 0, opposeCount = 0 } = counts ?? {};
        const total = supportCount + opposeCount;
        const direction = `${versionName(source)} as an estimation source for ${versionName(target)}`;
        const share = total ? percentage(supportCount / total * 10000) : null;
        rate.textContent = share ?? 'No votes · Eligible by default';
        describe(rate, share
            ? `${share} community support for ${direction}. ${supportCount} in support, ${opposeCount} opposed.`
            : `No community votes on ${direction}. Eligible by default.`);
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
        const targetID = target?.conditionID;
        const personalVotes = new Map(readOnly ? [] : personalEstimationVotes.filter(item => item.targetConditionID === targetID)
            .map(({ sourceConditionID, vote }) => [sourceConditionID, vote]));
        const counts = new Map(communityEstimationVotes.filter(item => item.targetConditionID === targetID)
            .map(item => [item.sourceConditionID, item]));
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
            updateEstimation(row, version, target, personalVotes.get(conditionID), counts.get(conditionID), readOnly, disabled);
        }
        host.hidden = false;
    }

    return { refresh, close };
}
