import { createWorkspaceChannel } from './workspace-channel.js';

// Successful server snapshots flow to navigation separately from navigation
// requests. Keeping the directions separate avoids reload/publish feedback loops.
export const navigationChannel = createWorkspaceChannel();
