/**
 * The core link, re-exported under its original name so callers (`main.ts`) don't care
 * that it grew a second transport.
 *
 * The implementation now lives in `core-link/`: shared request/event plumbing plus one
 * module per transport (fork IPC for a local core, WebSocket for a remote one).
 */
export {
  callCore,
  linkStatus,
  pairRemote,
  orchestratorRunning,
  restartOrchestrator,
  startOrchestrator,
  stopOrchestrator,
} from './core-link/index.js';
