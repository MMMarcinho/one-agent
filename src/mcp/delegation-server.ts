import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { registerBuiltinAdapters } from '../adapters/index.js';
import { Orchestrator } from '../core/orchestrator.js';
import { AgentRegistry } from '../core/registry.js';
import { SessionStore } from '../core/session-store.js';
import { builtinSpec, loadSpec, type Spec } from '../core/spec.js';
import { collectText } from './run-helpers.js';

/**
 * The delegation backbone. This MCP server is injected into a running agent so
 * that the agent can spawn *other* agents — but only within the user's spec:
 * the parent id, recursion depth, and allowed targets are passed in via env and
 * re-checked here on every call. This is what realizes "an agent decides to
 * launch another agent", governed by the rules the user defined.
 */
export async function startDelegationServer(): Promise<void> {
  const ctx = readContext();
  const spec = await resolveSpec();
  const registry = registerBuiltinAdapters(new AgentRegistry());
  const store = new SessionStore();
  const conventionsPath = process.env.ONE_AGENT_CONVENTIONS;
  const conventions = conventionsPath ? await safeLoad(conventionsPath) : undefined;
  const orchestrator = new Orchestrator(spec, registry, {
    specPath: process.env.ONE_AGENT_SPEC,
    store,
    conventions,
    conventionsPath,
  });

  const server = new McpServer({ name: 'one-agent', version: '0.1.0' });

  server.registerTool(
    'list_agents',
    {
      title: 'List delegatable agents',
      description:
        'List the agents this agent is permitted to delegate to, with their roles.',
      inputSchema: {},
    },
    async () => {
      const agents = ctx.allowed.map((id) => ({
        id,
        role: spec.agents[id]?.role ?? '(no role defined)',
        type: spec.agents[id]?.type,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] };
    },
  );

  server.registerTool(
    'spawn_agent',
    {
      title: 'Delegate a task to another agent',
      description:
        'Spawn another local coding agent to handle a sub-task and return its final output. ' +
        'Only agents allowed by the orchestration spec can be targeted.',
      inputSchema: {
        agent: z.string().describe('Target agent id (see list_agents).'),
        task: z.string().describe('A complete, self-contained task description.'),
        cwd: z
          .string()
          .optional()
          .describe('Working directory for the sub-agent (defaults to the parent cwd).'),
      },
    },
    async ({ agent, task, cwd }) => {
      const gate = orchestrator.canDelegate(ctx.parent, agent);
      if (!gate.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Delegation denied: ${gate.reason}` }],
        };
      }
      const workdir = cwd ?? ctx.cwd ?? process.cwd();
      const text = await collectText(
        orchestrator.run({
          agentId: agent,
          cwd: workdir,
          prompt: task,
          requestId: ctx.requestId,
          delegation: {
            depth: ctx.depth,
            parent: ctx.parent,
            rootRunId: ctx.rootRun,
            requestId: ctx.requestId,
          },
        }),
      );
      return { content: [{ type: 'text', text: text || '(sub-agent produced no output)' }] };
    },
  );

  await server.connect(new StdioServerTransport());
}

interface DelegationCtx {
  parent: string;
  depth: number;
  allowed: string[];
  rootRun: string;
  requestId?: string;
  cwd?: string;
}

function readContext(): DelegationCtx {
  return {
    parent: process.env.ONE_AGENT_PARENT ?? 'user',
    depth: Number(process.env.ONE_AGENT_DEPTH ?? '1'),
    allowed: (process.env.ONE_AGENT_ALLOWED ?? '').split(',').filter(Boolean),
    rootRun: process.env.ONE_AGENT_ROOT_RUN ?? 'root',
    requestId: process.env.ONE_AGENT_REQUEST,
    cwd: process.env.ONE_AGENT_CWD,
  };
}

async function safeLoad(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

async function resolveSpec(): Promise<Spec> {
  const path = process.env.ONE_AGENT_SPEC;
  if (path) {
    try {
      return await loadSpec(path);
    } catch {
      // Fall through to builtin on any spec error in a child process.
    }
  }
  return builtinSpec();
}
