/**
 * Core, interface-agnostic types for one-agent.
 *
 * These types are the contract between the orchestration core and any frontend
 * (the CLI today, a desktop app later). Nothing in here may import from `cli/`.
 */

/** How much autonomy an agent is granted over file/command side effects. */
export type PermissionMode =
  | 'plan' // read-only, propose changes but do not apply
  | 'ask' // prompt before each side effect
  | 'acceptEdits' // auto-apply edits, ask for shell/network
  | 'auto' // auto-apply edits and routine commands
  | 'bypass'; // full autonomy (a.k.a. "yolo"); use with care

/** A coding agent backend that one-agent knows how to drive. */
export type AdapterType = 'claude-code' | 'codex' | 'acp';

/** Static description of a configured agent (derived from the spec). */
export interface AgentDescriptor {
  /** Stable id used in specs and delegation (e.g. "claude-code", "codex"). */
  id: string;
  /** Which adapter implementation drives this agent. */
  type: AdapterType;
  /** Binary / launch command (e.g. "claude", "codex"). */
  command: string;
  /** Extra CLI args appended on launch. */
  args?: string[];
  /** Model override, if the backend supports it. */
  model?: string;
  /** Default permission mode for runs against this agent. */
  permissionMode?: PermissionMode;
  /** Human/agent-readable role description; used for routing & delegation. */
  role?: string;
  /** Extra env injected into the agent process. */
  env?: Record<string, string>;
  /** Agent ids this agent is allowed to delegate to (delegation policy). */
  canDelegateTo?: string[];
}

/** A single run of an agent against a working directory. */
export interface RunRequest {
  /** Which configured agent to run. */
  agentId: string;
  /** Absolute path to the project/working directory. */
  cwd: string;
  /** The user (or delegating agent's) prompt. */
  prompt: string;
  /** Per-run override of the agent's default permission mode. */
  permissionMode?: PermissionMode;
  /** Resume an existing backend session id, if the adapter supports it. */
  resumeSessionId?: string;
  /**
   * The top-level request (需求) this run belongs to. All runs across agents —
   * including delegated sub-runs — that share a requestId are grouped together
   * so the user can review everything one request spawned.
   */
  requestId?: string;
  /**
   * Delegation lineage. depth 0 = user-initiated; >0 = spawned by another
   * agent. Carried into the spawned agent so the policy can bound recursion.
   */
  delegation?: DelegationContext;
  /**
   * MCP servers to inject into the spawned backend. The orchestrator uses this
   * to give a running agent the one-agent delegation tools, so it can in turn
   * spawn other agents within the policy.
   */
  mcpServers?: McpServerConfig[];
  /**
   * Orchestration guidance injected into the agent as appended system context:
   * the auto-generated delegation roster plus the user's ONE_AGENT.md
   * conventions. Tells the agent when it is recommended to delegate to whom.
   */
  systemConvention?: string;
}

/** A stdio MCP server definition injected into a backend at launch. */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface DelegationContext {
  /** How many agent->agent hops deep this run is. */
  depth: number;
  /** The agent id that initiated this run (or "user"). */
  parent: string;
  /** Correlates a delegated run back to its parent run. */
  rootRunId: string;
  /** The request (需求) this delegated run belongs to. */
  requestId?: string;
}

/** Normalized event stream emitted by every adapter, regardless of backend. */
export type AgentEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool-call'; name: string; input: unknown; id?: string }
  | { kind: 'tool-result'; name: string; output: unknown; id?: string }
  | { kind: 'permission-request'; request: PermissionRequest }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { kind: 'error'; message: string; fatal: boolean }
  | { kind: 'done'; result?: string };

export interface PermissionRequest {
  id: string;
  /** Tool the agent wants to run (e.g. "Bash", "Edit"). */
  tool: string;
  input: unknown;
  /** Human-readable summary for prompting. */
  summary: string;
}

export type PermissionDecision =
  | { allow: true; updatedInput?: unknown }
  | { allow: false; reason?: string };

/** Callbacks an adapter may invoke during a run. */
export interface RunHooks {
  /** Resolve a permission prompt. If absent, adapter uses its default mode. */
  onPermission?: (req: PermissionRequest) => Promise<PermissionDecision>;
}
