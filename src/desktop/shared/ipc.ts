/**
 * IPC contract shared between the Electron main process and the renderer.
 * Kept self-contained (no core imports) so the renderer stays decoupled from
 * the orchestration internals. The main process maps core types onto these.
 */

export type PermissionMode = 'plan' | 'ask' | 'acceptEdits' | 'auto' | 'bypass';

export interface AgentInfo {
  id: string;
  type: string;
  role?: string;
  available: boolean;
  reason?: string;
  isDefault: boolean;
  canDelegateTo?: string[];
}

export interface InitResult {
  cwd: string;
  specPath?: string;
  conventionsPath?: string;
  usingBuiltin: boolean;
  defaultAgent: string;
  routingAuto: boolean;
  agents: AgentInfo[];
}

export interface RequestSummary {
  id: string;
  title: string;
  createdAt: string;
  agents: string[];
}

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface RunInfo {
  id: string;
  agentId: string;
  sessionId?: string;
  parent: string;
  depth: number;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  resultSummary?: string;
}

export interface RequestDetail {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  createdAt: string;
  runs: RunInfo[];
}

/** Normalized agent event, mirrors core's AgentEvent. */
export type AgentEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool-call'; name: string; input: unknown; id?: string }
  | { kind: 'tool-result'; name: string; output: unknown; id?: string }
  | { kind: 'permission-request'; request: unknown }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { kind: 'error'; message: string; fatal: boolean }
  | { kind: 'done'; result?: string };

/** Messages streamed from main to renderer on the 'run:event' channel. */
export type RunEventMsg =
  | { requestId: string; kind: 'routed'; agentId: string; reason: string }
  | { requestId: string; kind: 'event'; event: AgentEvent }
  | { requestId: string; kind: 'finished'; cancelled: boolean };

export interface StartRequestInput {
  cwd: string;
  prompt: string;
  /** undefined or "auto" => auto-route. */
  agentId?: string;
  mode?: PermissionMode;
}

/** The API surface exposed on window.oneAgent via the preload bridge. */
export interface OneAgentAPI {
  init(startDir?: string): Promise<InitResult>;
  pickDirectory(): Promise<string | null>;
  listAgents(cwd: string): Promise<AgentInfo[]>;
  listRequests(): Promise<RequestSummary[]>;
  getRequest(id: string): Promise<RequestDetail | null>;
  startRequest(input: StartRequestInput): Promise<{ requestId: string }>;
  cancelRequest(requestId: string): Promise<void>;
  onRunEvent(cb: (msg: RunEventMsg) => void): () => void;
}

export const IPC = {
  init: 'app:init',
  pickDirectory: 'dialog:pickDirectory',
  listAgents: 'agents:list',
  listRequests: 'requests:list',
  getRequest: 'request:get',
  startRequest: 'run:start',
  cancelRequest: 'run:cancel',
  runEvent: 'run:event',
} as const;
