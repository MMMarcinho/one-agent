import { randomUUID } from 'node:crypto';
import { buildConvention } from './conventions.js';
import { RuleRouter, type Router, type RoutingDecision } from './router.js';
import type { AgentRegistry } from './registry.js';
import type { SessionStore, RunRecord } from './session-store.js';
import type { Spec } from './spec.js';
import type {
  AgentDescriptor,
  AgentEvent,
  McpServerConfig,
  RunHooks,
  RunRequest,
} from './types.js';

export interface OrchestratorOptions {
  /** Path to the active spec file, propagated to spawned sub-agents. */
  specPath?: string;
  /** Command used to launch the one-agent delegation MCP server in children. */
  delegationBin?: string;
  delegationArgs?: string[];
  /** Records requests/runs so the user can review what each request spawned. */
  store?: SessionStore;
  /** User's ONE_AGENT.md conventions, injected into every launched agent. */
  conventions?: string;
  /** Path to the conventions file, propagated to spawned sub-agents. */
  conventionsPath?: string;
  /** Strategy for auto-selecting an agent. Defaults to the rule-based router. */
  router?: Router;
}

/**
 * The orchestration core. Frontends and the delegation MCP server both drive
 * agents through here, so the spec's policy (routing, delegation graph,
 * recursion bound) is enforced in exactly one place.
 */
export class Orchestrator {
  constructor(
    private readonly spec: Spec,
    private readonly registry: AgentRegistry,
    private readonly options: OrchestratorOptions = {},
  ) {}

  get activeSpec(): Spec {
    return this.spec;
  }

  /** Pick an agent for a task: explicit id > matching rule > default. */
  route(opts: { agentId?: string; prompt: string; cwd: string }): string {
    if (opts.agentId) return opts.agentId;
    if (this.spec.routing.auto) {
      const hit = this.spec.routing.rules.find((r) => matchesRule(r.when, opts));
      if (hit) return hit.use;
    }
    return this.spec.defaultAgent;
  }

  /**
   * Resolve which agent should handle a request, auto-routing among the agents
   * actually available on this machine when none is explicitly chosen (agentId
   * omitted or "auto"). Returns the choice plus a human-readable reason.
   */
  async resolveAgent(opts: {
    agentId?: string;
    prompt: string;
    cwd: string;
  }): Promise<RoutingDecision> {
    if (opts.agentId && opts.agentId !== 'auto') {
      return { agentId: opts.agentId, reason: 'selected by you' };
    }
    const detected = await this.registry.detectAll(this.spec);
    const available = [...detected.entries()].filter(([, d]) => d.available).map(([id]) => id);
    const router = this.options.router ?? new RuleRouter();
    return router.choose({ spec: this.spec, prompt: opts.prompt, cwd: opts.cwd, available });
  }

  /** Whether `parent` is permitted to delegate to `target` under the spec. */
  canDelegate(parent: string, target: string): { ok: boolean; reason?: string } {
    if (!this.spec.delegation.enabled) {
      return { ok: false, reason: 'delegation is disabled in the spec' };
    }
    if (!this.spec.agents[target]) {
      return { ok: false, reason: `unknown target agent "${target}"` };
    }
    const allowed = this.spec.agents[parent]?.canDelegateTo ?? [];
    if (!allowed.includes(target)) {
      return {
        ok: false,
        reason: `spec does not allow "${parent}" to delegate to "${target}"`,
      };
    }
    return { ok: true };
  }

  /**
   * Run an agent turn. Enforces delegation depth and, when the run is allowed
   * to delegate further, injects the one-agent MCP server so the agent can
   * spawn sub-agents within the policy.
   */
  async *run(request: RunRequest, hooks: RunHooks = {}): AsyncIterable<AgentEvent> {
    const descriptor = this.registry.descriptor(this.spec, request.agentId);
    const depth = request.delegation?.depth ?? 0;

    if (depth > this.spec.delegation.maxDepth) {
      yield {
        kind: 'error',
        message: `delegation depth ${depth} exceeds maxDepth ${this.spec.delegation.maxDepth}`,
        fatal: true,
      };
      yield { kind: 'done' };
      return;
    }

    const detection = await this.registry.detect(descriptor);
    if (!detection.available) {
      yield {
        kind: 'error',
        message: `agent "${descriptor.id}" is unavailable: ${detection.reason}`,
        fatal: true,
      };
      yield { kind: 'done' };
      return;
    }

    const mcpServers = this.delegationServers(descriptor, depth, request);
    const systemConvention =
      request.systemConvention ??
      buildConvention(this.spec, descriptor, this.options.conventions);
    const adapter = this.registry.adapterFor(descriptor);

    const record = await this.beginRecord(descriptor, request, depth);
    const collected: string[] = [];
    try {
      for await (const event of adapter.run(
        descriptor,
        { ...request, mcpServers, systemConvention },
        hooks,
      )) {
        if (event.kind === 'session') await this.note(record, { sessionId: event.sessionId });
        if (event.kind === 'assistant') collected.push(event.text);
        if (event.kind === 'done' && event.result) collected.push(event.result);
        if (event.kind === 'error' && event.fatal) {
          await this.note(record, { status: 'error', resultSummary: event.message });
        }
        yield event;
      }
      await this.finish(record, hooks.signal?.aborted ? 'cancelled' : 'done', collected.join(''));
    } catch (err) {
      await this.finish(record, 'error', String(err));
      throw err;
    }
  }

  private async beginRecord(
    descriptor: AgentDescriptor,
    request: RunRequest,
    depth: number,
  ): Promise<RunRecord | undefined> {
    const store = this.options.store;
    const requestId = request.requestId ?? request.delegation?.requestId;
    if (!store || !requestId) return undefined;
    return store.startRun({
      requestId,
      agentId: descriptor.id,
      parent: request.delegation?.parent ?? 'user',
      depth,
      prompt: request.prompt,
    });
  }

  private async note(
    record: RunRecord | undefined,
    patch: Parameters<SessionStore['updateRun']>[1],
  ): Promise<void> {
    if (record && this.options.store) await this.options.store.updateRun(record, patch);
  }

  private async finish(
    record: RunRecord | undefined,
    status: 'done' | 'error' | 'cancelled',
    output: string,
  ): Promise<void> {
    if (!record || !this.options.store) return;
    if (record.status !== 'running') return; // already finalized (e.g. fatal error)
    await this.options.store.updateRun(record, {
      status,
      endedAt: new Date().toISOString(),
      resultSummary: summarizeOutput(output),
    });
  }

  /**
   * Build the MCP server injection for a child agent. Returns [] when the agent
   * has no permitted delegation targets or the next hop would exceed maxDepth.
   */
  private delegationServers(
    descriptor: AgentDescriptor,
    depth: number,
    request: RunRequest,
  ): McpServerConfig[] {
    const existing = request.mcpServers ?? [];
    if (!this.spec.delegation.enabled) return existing;
    if (depth + 1 > this.spec.delegation.maxDepth) return existing;

    const targets = descriptor.canDelegateTo ?? [];
    if (targets.length === 0) return existing;

    const rootRunId = request.delegation?.rootRunId ?? randomUUID();
    const requestId = request.requestId ?? request.delegation?.requestId;
    const server: McpServerConfig = {
      name: 'one-agent',
      command: this.options.delegationBin ?? process.env.ONE_AGENT_BIN ?? 'one-agent',
      args: this.options.delegationArgs ?? ['mcp'],
      env: {
        ONE_AGENT_PARENT: descriptor.id,
        ONE_AGENT_DEPTH: String(depth + 1),
        ONE_AGENT_ALLOWED: targets.join(','),
        ONE_AGENT_ROOT_RUN: rootRunId,
        ONE_AGENT_CWD: request.cwd,
        ...(requestId ? { ONE_AGENT_REQUEST: requestId } : {}),
        ...(this.options.store ? { ONE_AGENT_HOME: this.options.store.root } : {}),
        ...(this.options.specPath ? { ONE_AGENT_SPEC: this.options.specPath } : {}),
        ...(this.options.conventionsPath
          ? { ONE_AGENT_CONVENTIONS: this.options.conventionsPath }
          : {}),
      },
    };
    return [...existing, server];
  }
}

function summarizeOutput(output: string): string {
  const flat = output.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? flat.slice(0, 197) + '…' : flat;
}

function matchesRule(when: string, opts: { prompt: string; cwd: string }): boolean {
  const needle = when.toLowerCase();
  return (
    opts.prompt.toLowerCase().includes(needle) || opts.cwd.toLowerCase().includes(needle)
  );
}
