import { DEFAULT_ESTIMATION_ALGORITHM, ESTIMATION_ALGORITHMS } from '../shared/estimation-algorithms.js';
import { setHelpText } from '../shared/help-popover.js?v=help-popovers-20261008';

export function createEstimationControl(host) {
    if (!host) return { render() {} };
    const select = host.querySelector('select'), help = host.querySelector('.bp-help-trigger');
    for (const algorithm of ESTIMATION_ALGORITHMS) {
        const option = document.createElement('option'); option.value = algorithm.ID; option.textContent = algorithm.label;
        select.append(option);
    }
    const method = ESTIMATION_ALGORITHMS.find(item => item.ID === DEFAULT_ESTIMATION_ALGORITHM);
    select.value = method.ID;
    setHelpText(help, method.description);
    return { render({ scoreMode }) {
        host.hidden = scoreMode !== 'available';
    } };
}
