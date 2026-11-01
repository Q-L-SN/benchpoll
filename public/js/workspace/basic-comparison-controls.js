import { basicComparisonOptions, defaultComparison, quickComparisonFields, readComparisonSettings, writeComparisonSettings } from './comparison-settings.js?v=comparison-experiment-20261007';
import { refreshHelpPopover } from '../shared/help-popover.js?v=help-popovers-20261008';
export { basicComparisonOptions };

export function createBasicComparisonControls({ onChange }) {
    const buttons = [...document.querySelectorAll('[data-quick-comparison]')];
    const help = document.getElementById('quick-comparison-help');
    const tooltip = document.getElementById('quick-comparison-tooltip');
    let accountID = null;
    let settings = readComparisonSettings(null);
    let options = basicComparisonOptions(settings);
    let metadata = null;
    function renderButtons() {
        const fields = quickComparisonFields(metadata?.fields ?? [], metadata?.availableKeys ?? []);
        for (const button of buttons) {
            const key = fields[button.dataset.quickComparison];
            button.disabled = !key;
            button.dataset.fieldKey = key ?? '';
            button.setAttribute('aria-pressed', String(Boolean(key && options.keys.includes(key))));
            button.dataset.tooltip = !key ? 'This field is not available in the current data.'
                : button.dataset.quickComparison === 'reasoning' ? 'Compare effort separately' : 'Compare harnesses separately';
        }
    }
    function persist() {
        settings.basic = structuredClone(options);
        writeComparisonSettings(settings, accountID);
    }
    for (const button of buttons) button.addEventListener('click', () => {
        const key = button.dataset.fieldKey;
        if (!key || button.disabled) return;
        options.keys = options.keys.includes(key) ? options.keys.filter(value => value !== key) : [...options.keys, key];
        persist(); renderButtons(); onChange(structuredClone(options));
    });
    const heading = document.createElement('strong'); heading.textContent = 'Separate or combine runs';
    const list = document.createElement('ul');
    for (const text of ['Effort: separate reasoning or image-quality settings.', 'Harness: separate software setups.',
        'Off: combine runs and use their best score.', 'Missing settings: keep an unknown group.']) {
        const item = document.createElement('li'); item.textContent = text; list.append(item);
    }
    tooltip.replaceChildren(heading, list); refreshHelpPopover(help);
    return {
        configureAccount(userID) {
            accountID = userID;
            settings = readComparisonSettings(accountID);
            options = basicComparisonOptions(settings);
            renderButtons();
            return structuredClone(options);
        },
        render(incoming) {
            metadata = incoming;
            options = basicComparisonOptions({ basic: options }, metadata);
            renderButtons();
        },
        resetToDefault() { options = defaultComparison(); persist(); renderButtons(); }
    };
}
