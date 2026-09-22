// Explicit page coordination; importing this module never touches the DOM.
export function createWorkspaceChannel() {
    let current = null;
    let beforeChange = async () => true;
    const listeners = new Set();
    return {
        publish(detail) {
            current = { ...detail };
            return Promise.all([...listeners].map(listener => listener({ ...current })));
        },
        subscribe(listener) {
            listeners.add(listener);
            if (current) listener({ ...current });
            return () => listeners.delete(listener);
        },
        beforeChange(handler) { beforeChange = handler; },
        async prepareChange() { return await beforeChange() !== false; }
    };
}

export const workspaceChannel = createWorkspaceChannel();
