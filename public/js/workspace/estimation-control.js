import { ESTIMATION_ALGORITHMS } from '../shared/estimation-algorithms.js';
import { setHelpText } from '../shared/help-popover.js?v=help-popovers-20261008';

export function createEstimationControl(host, { onChange }) {
    if (!host) return { render() {} };
    const select = host.querySelector('select'), help = host.querySelector('.bp-help-trigger');
    for (const algorithm of ESTIMATION_ALGORITHMS) {
        const option = document.createElement('option'); option.value = algorithm.ID; option.textContent = algorithm.label;
        select.append(option);
    }
    select.addEventListener('change', () => { void onChange(select.value); });
    return { render({ scoreMode, estimationAlgorithm }) {
        host.hidden = scoreMode !== 'available'; select.value = estimationAlgorithm;
        const selected = ESTIMATION_ALGORITHMS.find(item => item.ID === estimationAlgorithm);
        setHelpText(help, selected.description + ' This is a test setting for this tab. '
            + (estimationAlgorithm === 'current' ? 'The default algorithm is unchanged.'
                : 'Missing-only methods use 50 for gaps without a prediction and bound predictions to 0–100. The midpoint is a test assumption, not a statistical confidence estimate.'));
    } };
}
