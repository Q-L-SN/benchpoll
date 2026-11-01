export function createEditHistory() {
    const past = [];
    const future = [];
    return {
        get canUndo() { return past.length > 0; },
        get canRedo() { return future.length > 0; },
        record(snapshot) { past.push(structuredClone(snapshot)); future.length = 0; },
        undo(current) {
            if (!past.length) return null;
            future.push(structuredClone(current));
            return past.pop();
        },
        redo(current) {
            if (!future.length) return null;
            past.push(structuredClone(current));
            return future.pop();
        },
        clear() { past.length = 0; future.length = 0; }
    };
}
