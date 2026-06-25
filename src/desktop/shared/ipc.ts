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

export interface ProjectInfo {
  id: string;
  path: string;
  name: string;
  alias: string;
  lastUsedAt: string;
  /** Latest request/run activity in this project. Not updated by opening the project. */
  lastSessionAt?: string;
}

export interface InitResult {
  cwd: string;
  project: ProjectInfo | null;
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
  latestAt: string;
  agents: string[];
  agentRuns: RequestAgentSummary[];
  statuses: RunStatus[];
  runCount: number;
}

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface RequestAgentSummary {
  agentId: string;
  statuses: RunStatus[];
  runCount: number;
  latestAt: string;
}

export interface RunInfo {
  id: string;
  agentId: string;
  sessionId?: string;
  parent: string;
  depth: number;
  prompt: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  resultSummary?: string;
  events?: StoredRunEventInfo[];
}

export interface StoredRunEventInfo {
  at: string;
  event: AgentEvent;
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

/**
 * Messages streamed from main to renderer on the 'run:event' channel. A
 * conversation (= one request) has many turns; events carry both ids so the
 * renderer attaches each event to the right turn bubble.
 */
export type RunEventMsg =
  | { conversationId: string; turnId: string; kind: 'routed'; agentId: string; reason: string }
  | { conversationId: string; turnId: string; kind: 'event'; event: AgentEvent }
  | { conversationId: string; turnId: string; kind: 'finished'; cancelled: boolean };

export interface StartConversationInput {
  cwd: string;
  /** The project this conversation belongs to. */
  projectId: string;
  prompt: string;
  /** undefined or "auto" => auto-route. */
  agentId?: string;
  mode?: PermissionMode;
  /** Renderer-generated id for the first turn (avoids an event race). */
  turnId: string;
}

export interface SendMessageInput {
  conversationId: string;
  prompt: string;
  turnId: string;
}

/** The API surface exposed on window.oneAgent via the preload bridge. */
export interface OneAgentAPI {
  init(startDir?: string): Promise<InitResult>;
  pickDirectory(): Promise<string | null>;
  /** Projects (opened directories), most-recently-used first. */
  listProjects(): Promise<ProjectInfo[]>;
  renameProject(id: string, alias: string): Promise<ProjectInfo | null>;
  listAgents(cwd: string): Promise<AgentInfo[]>;
  /** Requests (sessions) belonging to a project, newest first. */
  listRequests(projectId: string): Promise<RequestSummary[]>;
  getRequest(id: string): Promise<RequestDetail | null>;
  /** Open a conversation with its first turn. Returns the conversation id. */
  startConversation(
    input: StartConversationInput,
  ): Promise<{ conversationId: string; agentId: string; reason: string }>;
  /** Send a follow-up turn in an existing conversation. */
  sendMessage(input: SendMessageInput): Promise<void>;
  /** Interrupt the in-flight turn (keeps the conversation open). */
  cancelTurn(conversationId: string): Promise<void>;
  /** End a conversation and release its agent process. */
  closeConversation(conversationId: string): Promise<void>;
  onRunEvent(cb: (msg: RunEventMsg) => void): () => void;
}

export const IPC = {
  init: 'app:init',
  pickDirectory: 'dialog:pickDirectory',
  listProjects: 'projects:list',
  renameProject: 'project:rename',
  listAgents: 'agents:list',
  listRequests: 'requests:list',
  getRequest: 'request:get',
  startConversation: 'conversation:start',
  sendMessage: 'conversation:send',
  cancelTurn: 'conversation:cancel',
  closeConversation: 'conversation:close',
  runEvent: 'run:event',
} as const;
