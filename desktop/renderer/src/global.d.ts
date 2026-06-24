import type { OneAgentAPI } from '@shared/ipc';

declare global {
  interface Window {
    oneAgent: OneAgentAPI;
  }
}

export {};
