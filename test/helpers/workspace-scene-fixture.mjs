// Keep recovery/race tests scoped to two concrete numeric scenes independently
// of the general-purpose preview's current topic catalogue.
export const recoveryScene = Object.freeze({ standard: '101', extended: '102' });

export function withRecoveryScenes(payload, contextValues = {}) {
    const scene = String(contextValues.scene ?? recoveryScene.standard);
    const sceneID = Number(scene), sceneNumber = scene === recoveryScene.extended ? 2 : 1;
    const publicID = payload.context.publicID ?? payload.context.categoryID;
    return { ...payload, context: { ...payload.context, ID: sceneID, contextID: sceneID, sceneID,
        categoryPath: `${publicID}/${sceneNumber}`, url: `/${publicID}/${sceneNumber}`,
        contextValues: { scene }, dimensions: [], scenes: [
            { ID: 101, name: 'Standard', isDefault: true, sceneNumber: 1, url: `/${publicID}/1` },
            { ID: 102, name: 'Extended', isDefault: false, sceneNumber: 2, url: `/${publicID}/2` }
        ] } };
}
