import type { AgentRegistry } from '../core/registry.js';
import { AcpAdapter } from './acp.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';

export { AcpAdapter } from './acp.js';
export { ClaudeCodeAdapter } from './claude-code.js';
export { CodexAdapter } from './codex.js';

/** Register all built-in adapters on a registry. */
export function registerBuiltinAdapters(registry: AgentRegistry): AgentRegistry {
  return registry
    .register(new ClaudeCodeAdapter())
    .register(new CodexAdapter())
    .register(new AcpAdapter());
}
