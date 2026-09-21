export function createComparisonControls({ onChange, onInvalid }) {
    const toggle = document.getElementById('model-comparison-toggle');
    const panel = document.getElementById('model-comparison-panel');
    const keys = document.getElementById('model-comparison-keys');
    const mode = document.getElementById('model-comparison-mode');
    const note = document.getElementById('model-comparison-note');
    toggle.disabled = true;
    toggle.addEventListener('click', () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute('aria-expanded', String(!panel.hidden));
    });
    // The same checkbox has different meanings in each mode; keep the drafts separate.
    const selections = { best: [], matched: [] };
    let initialized = false;
    let unconfiguredCount = 0;
    let availableKeys = [];
    const describe = () => {
        const missing = mode.value === 'matched' && selections.matched.length === 0;
        const unavailable = selections[mode.value].filter(key => !availableKeys.includes(key));
        const error = unavailable.length ? `These keys are no longer available: ${unavailable.join(', ')}. Uncheck them and choose current keys.`
            : missing ? 'Select at least one key to compare.' : '';
        keys.setAttribute('aria-label', mode.value === 'best' ? 'Keys to ignore' : 'Keys to compare');
        note.setAttribute('role', 'status');
        note.classList.toggle('is-invalid', Boolean(error));
        note.textContent = error || (mode.value === 'matched'
            ? 'Selected keys define comparison groups. Other keys must match; Fallback is off.'
            : 'Selected keys are ignored. Each benchmark uses the best result across those configurations.');
        if (!error && unconfiguredCount) note.textContent += ` ${unconfiguredCount} configurations have no structured conditions yet.`;
        return error;
    };
    const changed = () => {
        renderKeys();
        const error = describe();
        if (error) { onInvalid(error); return; }
        onChange({ mode: mode.value, keys: [...selections[mode.value]] });
    };
    mode.addEventListener('change', () => {
        keys.querySelectorAll('input').forEach(input => { input.checked = selections[mode.value].includes(input.value); });
        changed();
    });
    keys.addEventListener('change', () => {
        selections[mode.value] = [...keys.querySelectorAll('input:checked')].map(input => input.value);
        changed();
    });
    let keySignature = '';
    function renderKeys() {
        const visibleKeys = [...new Set([...availableKeys, ...selections[mode.value]])];
        const nextSignature = JSON.stringify([availableKeys, visibleKeys]);
        if (keySignature === nextSignature) {
            keys.querySelectorAll('input').forEach(input => { input.checked = selections[mode.value].includes(input.value); });
            return;
        }
        keySignature = nextSignature;
        keys.replaceChildren();
        for (const key of visibleKeys) {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox'; input.value = key;
            input.checked = selections[mode.value].includes(key);
            const text = document.createElement('span');
            text.textContent = key === 'model' ? 'Model' : key.replaceAll('_', ' ');
            if (!availableKeys.includes(key)) text.textContent += ' (unavailable)';
            label.append(input, text); keys.append(label);
        }
    }
    return metadata => {
        toggle.disabled = false;
        if (!initialized) {
            mode.value = metadata.mode;
            selections[metadata.mode] = [...metadata.keys];
            initialized = true;
        }
        unconfiguredCount = metadata.unconfiguredCount;
        availableKeys = [...metadata.availableKeys];
        renderKeys();
        const error = describe();
        if (error) {
            panel.hidden = false;
            toggle.setAttribute('aria-expanded', 'true');
            onInvalid(error);
        }
    };
}
