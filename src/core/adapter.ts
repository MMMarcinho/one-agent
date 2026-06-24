import type {
  AgentDescriptor,
  AgentEvent,
  McpServerConfig,
  PermissionMode,
  RunHooks,
} from './types.js';

/**
 * The single contract every backend integration implements. A frontend never
 * talks to `claude`/`codex` directly — it goes through an AgentAdapter, so
 * adding a new backend never touches the CLI, desktop app, or orchestrator.
 *
 * Backends are session-oriented: `openSession` starts a (possibly long-lived)
 * conversation, and each `send` is one turn. Persistent backends (Claude Code,
 * ACP) keep one process alive across turns; others may spawn per turn.
 */
export interface AgentAdapter {
  readonly type: string;

  /**
   * Whether the backend is actually usable on this machine (binary present,
   * server reachable, etc.). Used for auto-detection at startup.
   */
  detect(descriptor: AgentDescriptor): Promise<DetectResult>;

  /** Open a conversation against a working directory. */
  openSession(descriptor: AgentDescriptor, opts: SessionOpts): Promise<AgentSession>;
}

export interface SessionOpts {
  cwd: string;
  permissionMode?: PermissionMode;
  /** MCP servers injected into the backend (e.g. the delegation server). */
  mcpServers?: McpServerConfig[];
  /** Orchestration conventions injected as system context. */
  systemConvention?: string;
  /** Resume a known backend session id, if the adapter supports it. */
  resumeSessionId?: string;
}

export interface TurnInput {
  prompt: string;
}

/** A live conversation with one backend. Turns are sequential. */
export interface AgentSession {
  /** Backend session id once known (after the first turn for most backends). */
  readonly sessionId: string | undefined;
  /** Run one turn; yields normalized events until the turn completes. */
  send(input: TurnInput, hooks: RunHooks): AsyncIterable<AgentEvent>;
  /** Interrupt the in-flight turn without ending the session (best effort). */
  interrupt(): void;
  /** End the conversation and release the backend process. */
  close(): Promise<void>;
}

export interface DetectResult {
  available: boolean;
  resolvedPath?: string;
  version?: string;
  reason?: string;
}

/**
 * One-shot convenience: open a session, run a single turn, then close. Used for
 * delegated sub-tasks and the CLI's non-interactive `run`, where conversation
 * continuity isn't needed.
 */
export async function* runOnce(
  adapter: AgentAdapter,
  descriptor: AgentDescriptor,
  opts: SessionOpts,
  input: TurnInput,
  hooks: RunHooks,
): AsyncIterable<AgentEvent> {
  const session = await adapter.openSession(descriptor, opts);
  try {
    yield* session.send(input, hooks);
  } finally {
    await session.close();
  }
}
