import type { AgentDescriptor, AgentEvent, RunHooks, RunRequest } from './types.js';

/**
 * The single contract every backend integration implements. A frontend never
 * talks to `claude`/`codex` directly — it goes through an AgentAdapter, so
 * adding a new backend never touches the CLI or the orchestrator.
 */
export interface AgentAdapter {
  /** Adapter type id, matches AgentDescriptor.type. */
  readonly type: string;

  /**
   * Whether the backend is actually usable on this machine (binary present,
   * server reachable, etc.). Used for auto-detection at startup.
   */
  detect(descriptor: AgentDescriptor): Promise<DetectResult>;

  /**
   * Run a single turn. Returns an async iterable of normalized events. The
   * adapter owns process lifecycle for the duration of the iteration.
   */
  run(
    descriptor: AgentDescriptor,
    request: RunRequest,
    hooks: RunHooks,
  ): AsyncIterable<AgentEvent>;
}

export interface DetectResult {
  available: boolean;
  /** Resolved binary path or server URL, when available. */
  resolvedPath?: string;
  /** Backend version string, if cheaply obtainable. */
  version?: string;
  /** Why it is unavailable, for diagnostics. */
  reason?: string;
}
