import { registerBuiltinAdapters } from '../adapters/index.js';
import { Orchestrator } from '../core/orchestrator.js';
import { AgentRegistry } from '../core/registry.js';
import { SessionStore } from '../core/session-store.js';
import { builtinSpec, findSpecPath, loadSpec, type Spec } from '../core/spec.js';

export interface Bootstrapped {
  spec: Spec;
  specPath?: string;
  registry: AgentRegistry;
  orchestrator: Orchestrator;
  store: SessionStore;
  usingBuiltin: boolean;
}

/**
 * Load the effective spec (from disk or the built-in default) and wire up the
 * registry + orchestrator. Shared by every CLI command.
 */
export async function bootstrap(startDir: string): Promise<Bootstrapped> {
  const specPath = findSpecPath(startDir);
  let spec: Spec;
  let usingBuiltin = false;
  if (specPath) {
    spec = await loadSpec(specPath);
  } else {
    spec = builtinSpec();
    usingBuiltin = true;
  }
  const registry = registerBuiltinAdapters(new AgentRegistry());
  const store = new SessionStore();
  const orchestrator = new Orchestrator(spec, registry, { specPath, store });
  return { spec, specPath, registry, orchestrator, store, usingBuiltin };
}
