/**
 * Orchestration conventions — a CLAUDE.md-style markdown file (`ONE_AGENT.md`)
 * where the user writes, in plain language, when each agent should delegate to
 * which other agent. one-agent loads it and injects it into every agent it
 * launches, so the convention reaches Claude Code, Codex, and ACP agents alike
 * regardless of each backend's own memory-file support.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentDescriptor } from './types.js';
import type { Spec } from './spec.js';

export const CONVENTION_FILENAMES = ['ONE_AGENT.md', '.one-agent.md', 'one-agent.md'];

/** Walk up from `startDir` to find a conventions file. */
export function findConventionsPath(startDir: string, override?: string): string | undefined {
  if (override) {
    const abs = resolve(startDir, override);
    return existsSync(abs) ? abs : undefined;
  }
  let dir = resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const name of CONVENTION_FILENAMES) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export async function loadConventions(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).trim();
}

/**
 * Build the system context injected into an agent: a machine-generated header
 * describing the delegation capability and the agent's permitted targets (with
 * roles), followed by the user's free-form conventions. Returns undefined when
 * there is nothing useful to inject.
 */
export function buildConvention(
  spec: Spec,
  descriptor: AgentDescriptor,
  userConventions?: string,
): string | undefined {
  const targets = (descriptor.canDelegateTo ?? []).filter((id) => spec.agents[id]);
  const canDelegate = spec.delegation.enabled && targets.length > 0;

  const sections: string[] = [];

  if (canDelegate) {
    const roster = targets
      .map((id) => `- \`${id}\` — ${spec.agents[id]?.role ?? '(no role defined)'}`)
      .join('\n');
    sections.push(
      [
        '## one-agent orchestration',
        '',
        'You are running under one-agent. You may delegate a self-contained sub-task',
        'to another local agent with the `spawn_agent` tool (from the "one-agent" MCP',
        'server), or open a continuing delegated conversation with `start_session`',
        'and follow up with `send_session_message`. Call `list_agents` to inspect',
        'available targets; call `list_sessions` and `read_session` to inspect',
        'progress, summaries, and event content from other sessions in the current',
        'request. Close persistent delegated conversations with `close_session`',
        'when they are no longer needed. Agents you may delegate to:',
        '',
        roster,
        '',
        'Only delegate when it clearly helps (e.g. a target is better suited per the',
        'conventions below or you want an independent second opinion). The sub-agent',
        'shares your working directory unless you pass a different `cwd`.',
      ].join('\n'),
    );
  }

  if (userConventions && userConventions.length > 0) {
    sections.push(['## Project delegation conventions', '', userConventions].join('\n'));
  }

  if (sections.length === 0) return undefined;
  return sections.join('\n\n');
}

/** Starter ONE_AGENT.md written by `one-agent init`. */
export const EXAMPLE_CONVENTIONS = `# one-agent conventions

Plain-language rules for how the agents in this project should collaborate.
one-agent injects this file into every agent it launches, so write it as
guidance addressed to the agent that is currently working.

## When to delegate

- Delegate **test writing / fixing** to \`codex\` once the implementation is in
  place — it is fast and focused for that.
- When you are unsure about an approach, ask \`codex\` for an independent second
  opinion before committing to a large refactor.
- Keep architecture, repo-wide reasoning, and multi-file refactors yourself
  (\`claude-code\`).

## House rules

- Match the surrounding code style; do not introduce new dependencies without a
  clear reason.
- Always state what you changed and why.
`;
