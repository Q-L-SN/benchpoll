// One observer per document also covers forms mounted later inside dialogs.
const environments = new WeakMap();

export function observeTextareaAutosize(root = document) {
    const document = root.ownerDocument ?? root;
    const view = document.defaultView;
    if (!view) return;
    let environment = environments.get(document);
    if (!environment) {
        const controllers = new Map(), pending = new Set();
        let frame = null;
        function queue(textarea) {
            pending.add(textarea);
            if (frame !== null) return;
            frame = view.requestAnimationFrame(() => {
                frame = null;
                for (const node of pending) {
                    if (!node.isConnected || !node.getClientRects().length || !node.clientWidth) continue;
                    const style = view.getComputedStyle(node);
                    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
                    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
                    node.style.height = 'auto';
                    const height = node.scrollHeight + (style.boxSizing === 'border-box' ? border : -padding);
                    node.style.height = `${Math.ceil(height)}px`;
                    node.style.overflowY = node.scrollHeight > node.clientHeight + 1 ? 'auto' : 'hidden';
                }
                pending.clear();
            });
        }
        const resize = new view.ResizeObserver(entries => {
            for (const entry of entries) {
                const controller = controllers.get(entry.target), width = entry.contentRect.width;
                if (controller && width !== controller.width) { controller.width = width; queue(entry.target); }
            }
        });
        function mount(textarea) {
            if (controllers.has(textarea)) return;
            const descriptor = Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value');
            const own = Object.getOwnPropertyDescriptor(textarea, 'value');
            // Preserve form code's value semantics while resizing after draft restore or clearing.
            const watch = descriptor?.get && descriptor.set && !own;
            if (watch) Object.defineProperty(textarea, 'value', {
                configurable: true, enumerable: descriptor.enumerable,
                get() { return descriptor.get.call(this); },
                set(value) { descriptor.set.call(this, value); queue(this); }
            });
            controllers.set(textarea, { width: null, watch });
            resize.observe(textarea); queue(textarea);
        }
        function scan(scope) {
            if (scope.matches?.('textarea')) mount(scope);
            scope.querySelectorAll?.('textarea').forEach(mount);
        }
        const observer = new view.MutationObserver(records => {
            for (const record of records) {
                for (const node of record.addedNodes) scan(node);
                if (record.type === 'attributes') {
                    if (record.target.matches('textarea')) queue(record.target);
                    record.target.querySelectorAll('textarea').forEach(queue);
                }
            }
            for (const [node, controller] of controllers) if (!node.isConnected) {
                resize.unobserve(node); controllers.delete(node); pending.delete(node);
                if (controller.watch) delete node.value;
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['hidden', 'open', 'rows'] });
        document.addEventListener('input', event => { if (event.target.matches('textarea')) queue(event.target); }, true);
        document.addEventListener('reset', event => view.queueMicrotask(() => {
            if (!event.defaultPrevented) event.target.querySelectorAll('textarea').forEach(queue);
        }), true);
        document.fonts?.ready.then(() => controllers.forEach((_, node) => queue(node)));
        environment = { scan };
        environments.set(document, environment);
    }
    environment.scan(root);
}
