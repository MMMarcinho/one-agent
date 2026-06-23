import type { AgentAdapter, DetectResult } from './adapter.js';
import { commandFor, type Spec } from './spec.js';
import type { AgentDescriptor } from './types.js';

/**
 * Holds the available adapter implementations and turns a parsed spec into
 * concrete, runnable AgentDescriptors. Detection results are cached per id.
 */
export class AgentRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly detectCache = new Map<string, DetectResult>();

  register(adapter: AgentAdapter): this {
    this.adapters.set(adapter.type, adapter);
    return this;
  }

  adapterFor(descriptor: AgentDescriptor): AgentAdapter {
    const adapter = this.adapters.get(descriptor.type);
    if (!adapter) {
      throw new Error(
        `No adapter registered for type "${descriptor.type}" (agent "${descriptor.id}").`,
      );
    }
    return adapter;
  }

  /** Build descriptors for every agent declared in the spec. */
  describe(spec: Spec): AgentDescriptor[] {
    return Object.entries(spec.agents).map(([id, agent]) => ({
      id,
      type: agent.type,
      command: commandFor(id, agent),
      args: agent.args,
      model: agent.model,
      permissionMode: agent.permissionMode,
      role: agent.role,
      env: agent.env,
      canDelegateTo: agent.canDelegateTo,
    }));
  }

  descriptor(spec: Spec, id: string): AgentDescriptor {
    const found = this.describe(spec).find((d) => d.id === id);
    if (!found) throw new Error(`Agent "${id}" is not defined in the spec.`);
    return found;
  }

  async detect(descriptor: AgentDescriptor): Promise<DetectResult> {
    const cached = this.detectCache.get(descriptor.id);
    if (cached) return cached;
    const adapter = this.adapters.get(descriptor.type);
    const result: DetectResult = adapter
      ? await adapter.detect(descriptor)
      : { available: false, reason: `no adapter for type "${descriptor.type}"` };
    this.detectCache.set(descriptor.id, result);
    return result;
  }

  /** Detect every agent in the spec; useful for the startup picker. */
  async detectAll(spec: Spec): Promise<Map<string, DetectResult>> {
    const out = new Map<string, DetectResult>();
    await Promise.all(
      this.describe(spec).map(async (d) => {
        out.set(d.id, await this.detect(d));
      }),
    );
    return out;
  }
}
