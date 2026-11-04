import { createAction } from '../shared/ui-components.js';
import { excludedFromRanking } from '../shared/aa-ranking-policy.js';
import { distributeToTarget } from './weights.js';
import { MIN_WEIGHT_BASIS_POINTS } from './constants.js';
import { setLoading } from '../shared/loading.js';

// Public proportions can contain fractional or sub-minimum allocations. Keep
// benchmark-level weights while opting out of version and fallback votes.
export function publicWeightStart(entries, composition, limits) {
    const groups = new Map((composition ?? []).flatMap(group => group.versions.map(version => [version.conditionID, group])));
    const merged = new Map();
    for (const entry of entries) {
        if (!(entry.weightBasisPoints > 0) || excludedFromRanking(entry)) continue;
        const group = groups.get(entry.conditionID);
        const version = group?.versions.find(version => version.conditionID === group.primaryConditionID);
        const source = version ? { ...version, followCommunityVersion: true } : { ...entry };
        if (source.conditionID < 0) delete source.followCommunityVersion;
        const existing = merged.get(source.conditionID);
        merged.set(source.conditionID, { ...source, weightBasisPoints: (existing?.weightBasisPoints ?? 0) + entry.weightBasisPoints });
    }
    const ordered = [...merged.values()].sort((a, b) => b.weightBasisPoints - a.weightBasisPoints || a.conditionID - b.conditionID);
    const maximum = Math.min(limits.maxPieItems, Math.floor(limits.totalBasisPoints / MIN_WEIGHT_BASIS_POINTS));
    const chosen = ordered.slice(0, maximum);
    const normalized = distributeToTarget(chosen, limits.totalBasisPoints);
    const omitted = ordered.length - chosen.length;
    return { entries: normalized, note: omitted
        ? `Starts with the ${maximum} largest weights, adjusted to the 1% minimum.`
        : chosen.some(entry => entry.weightBasisPoints < MIN_WEIGHT_BASIS_POINTS)
            ? 'Small weights are adjusted to the 1% minimum.' : '' };
}

export function createPersonalPieStart({ stage, getScope, getPublicStart, isPrivate, onApply, onChange }) {
    const background = document.createElement('div'); background.className = 'bp-pie-start-background';
    background.append(...stage.childNodes); stage.append(background);
    const overlay = document.createElement('div'); overlay.id = 'personal-pie-start'; overlay.className = 'bp-pie-start'; overlay.hidden = true;
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-labelledby', 'personal-pie-start-title');
    overlay.setAttribute('aria-describedby', 'personal-pie-start-message');
    const panel = document.createElement('div'); panel.className = 'bp-pie-start-panel';
    const title = document.createElement('h3'); title.id = 'personal-pie-start-title';
    const message = document.createElement('p'); message.id = 'personal-pie-start-message';
    const choices = document.createElement('div'); choices.className = 'bp-pie-start-choices';
    const fromPublic = createAction({ label: 'From public weights', icon: 'fa-solid fa-users', variant: 'primary' });
    fromPublic.id = 'personal-pie-start-public';
    const blank = createAction({ label: 'From blank', icon: 'fa-regular fa-file', variant: 'secondary' });
    blank.id = 'personal-pie-start-blank'; choices.append(fromPublic, blank);
    const confirmation = document.createElement('div'); confirmation.className = 'bp-pie-start-choices'; confirmation.hidden = true;
    const confirm = createAction({ label: 'Start over', variant: 'primary' }); confirm.id = 'personal-pie-start-confirm';
    const keep = createAction({ label: 'Keep my weights', variant: 'secondary' });
    confirmation.append(confirm, keep);
    const closeButton = createAction({ label: 'Cancel starting over', icon: 'fa-solid fa-xmark', iconOnly: true, variant: 'quiet' });
    closeButton.classList.add('bp-pie-start-close');
    const status = document.createElement('p'); status.className = 'bp-pie-start-status'; status.setAttribute('role', 'status'); status.hidden = true;
    panel.append(title, message, choices, confirmation, status); overlay.append(closeButton, panel); stage.append(overlay);
    let intent = null;
    function close({ restore = true } = {}) {
        const trigger = intent?.trigger;
        intent = null; overlay.hidden = true; background.inert = false;
        stage.classList.remove('has-weight-start');
        onChange();
        if (restore && trigger?.isConnected && !trigger.disabled && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
    }
    function refresh() {
        if (!intent) return;
        if (intent.scope !== getScope()) { close({ restore: false }); return; }
        const confirming = Boolean(intent.choice);
        overlay.dataset.step = confirming ? 'confirm' : 'choose';
        title.textContent = confirming ? 'Replace your personal weights?' : 'Where would you like to start?';
        const publicStart = getPublicStart();
        const available = !isPrivate() && publicStart.entries.length > 0;
        message.textContent = confirming
            ? `${intent.choice.source === 'public' ? 'Start from public weights' : 'Start from blank'}. This replaces your current weights, version choices and fallback settings.`
            : !available ? isPrivate() ? 'Public weights are unavailable for private topics.' : 'No public weights in this scene yet.' : publicStart.note;
        message.hidden = !message.textContent;
        choices.hidden = confirming; confirmation.hidden = !confirming;
        for (const button of overlay.querySelectorAll('button')) button.disabled = Boolean(intent.applying);
        fromPublic.disabled ||= !available;
        confirm.querySelector('span').textContent = intent.choice?.source === 'public' ? 'Use public weights' : 'Start from blank';
        closeButton.setAttribute('aria-label', intent.reset ? 'Cancel starting over' : 'Cancel creating personal weights');
    }
    async function apply(choice) {
        const active = intent;
        if (!active || active.applying || active.scope !== getScope()) return;
        active.applying = true; status.hidden = false; setLoading(status, 'Starting personal weights'); refresh();
        try {
            const applied = await onApply(choice.entries, () => intent === active && active.scope === getScope());
            if (intent !== active) return;
            if (applied) close({ restore: false });
            else { active.applying = false; status.textContent = 'Could not start over. Your weights are kept. Please try again.'; refresh(); }
        } catch {
            if (intent !== active) return;
            active.applying = false; status.textContent = 'Could not start over. Your weights are kept. Please try again.'; refresh();
        }
    }
    function choose(source) {
        if (!intent || intent.applying || intent.scope !== getScope()) return;
        const entries = source === 'public' ? getPublicStart().entries : [];
        if (source === 'public' && (!entries.length || isPrivate())) return;
        const choice = { source, entries: structuredClone(entries) };
        if (intent.reset) { intent.choice = choice; refresh(); keep.focus({ preventScroll: true }); }
        else void apply(choice);
    }
    fromPublic.addEventListener('click', () => choose('public'));
    blank.addEventListener('click', () => choose('blank'));
    confirm.addEventListener('click', () => { if (intent?.choice) void apply(intent.choice); });
    keep.addEventListener('click', () => close()); closeButton.addEventListener('click', () => close());
    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !intent?.applying) { event.preventDefault(); event.stopPropagation(); close(); }
    });
    return { refresh, close, get isOpen() { return Boolean(intent); }, open({ reset = false, trigger }) {
        intent = { reset, trigger, scope: getScope(), choice: null, applying: false };
        overlay.hidden = false; status.hidden = true; background.inert = true;
        stage.classList.add('has-weight-start'); refresh(); onChange();
        stage.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        (fromPublic.disabled ? blank : fromPublic).focus({ preventScroll: true });
    } };
}
