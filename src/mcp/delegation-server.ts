import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Conversation } from '../core/conversation.js';
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
  const sessions = new Map<string, DelegatedSession>();

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
      if (ctx.depth > spec.delegation.maxDepth) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Delegation denied: depth ${ctx.depth} exceeds maxDepth ${spec.delegation.maxDepth}`,
            },
          ],
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

  server.registerTool(
    'start_session',
    {
      title: 'Start a persistent delegated agent session',
      description:
        'Open a persistent conversation with another allowed local coding agent, send the first task, and return a handle for follow-up turns.',
      inputSchema: {
        agent: z.string().describe('Target agent id (see list_agents).'),
        task: z.string().describe('The first user turn for the delegated session.'),
        cwd: z
          .string()
          .optional()
          .describe('Working directory for the sub-agent (defaults to the parent cwd).'),
      },
    },
    async ({ agent, task, cwd }) => {
      if (!ctx.requestId) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Cannot start a session without a current request id.' }],
        };
      }
      const gate = orchestrator.canDelegate(ctx.parent, agent);
      if (!gate.ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Delegation denied: ${gate.reason}` }],
        };
      }
      const workdir = cwd ?? ctx.cwd ?? process.cwd();
      const convo = await orchestrator.openConversation({
        agentId: agent,
        cwd: workdir,
        requestId: ctx.requestId,
        parent: ctx.parent,
        depth: ctx.depth,
      });
      const handle = randomUUID();
      sessions.set(handle, { convo, agent, cwd: workdir, requestId: ctx.requestId });
      const text = await collectText(convo.send(task));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                sessionHandle: handle,
                agent,
                cwd: workdir,
                backendSessionId: convo.sessionId,
                output: text || '(agent produced no output)',
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'send_session_message',
    {
      title: 'Send a follow-up message to a delegated session',
      description:
        'Continue a persistent delegated agent session that was opened with start_session.',
      inputSchema: {
        sessionHandle: z.string().describe('Handle returned by start_session.'),
        message: z.string().describe('Follow-up user message for the delegated agent.'),
      },
    },
    async ({ sessionHandle, message }) => {
      const session = sessions.get(sessionHandle);
      if (!session) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown delegated session handle: ${sessionHandle}` }],
        };
      }
      const text = await collectText(session.convo.send(message));
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                sessionHandle,
                agent: session.agent,
                cwd: session.cwd,
                backendSessionId: session.convo.sessionId,
                output: text || '(agent produced no output)',
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'close_session',
    {
      title: 'Close a delegated agent session',
      description: 'Release a persistent delegated session opened with start_session.',
      inputSchema: {
        sessionHandle: z.string().describe('Handle returned by start_session.'),
      },
    },
    async ({ sessionHandle }) => {
      const session = sessions.get(sessionHandle);
      if (!session) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown delegated session handle: ${sessionHandle}` }],
        };
      }
      sessions.delete(sessionHandle);
      await session.convo.close();
      return { content: [{ type: 'text', text: `Closed delegated session ${sessionHandle}.` }] };
    },
  );

  server.registerTool(
    'list_sessions',
    {
      title: 'List one-agent sessions for this request',
      description:
        'Inspect the runs already recorded under the current one-agent request, including agent, status, prompt, and result summary.',
      inputSchema: {
        agent: z
          .string()
          .optional()
          .describe('Optional agent id filter, such as codex or claude-code.'),
        includeEvents: z
          .boolean()
          .optional()
          .describe('Include normalized event transcripts for each run. Defaults to false.'),
        eventLimit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .describe('Maximum number of events per run when includeEvents is true.'),
      },
    },
    async ({ agent, includeEvents, eventLimit }) => {
      if (!ctx.requestId) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'No current one-agent request is available.' }],
        };
      }
      const limit = eventLimit ?? 40;
      const runs = (await store.runsFor(ctx.requestId))
        .filter((run) => !agent || run.agentId === agent)
        .map((run) => ({
          id: run.id,
          agentId: run.agentId,
          status: run.status,
          parent: run.parent,
          depth: run.depth,
          prompt: run.prompt,
          sessionId: run.sessionId,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          resultSummary: run.resultSummary,
          ...(includeEvents ? { events: (run.events ?? []).slice(-limit) } : {}),
        }));
      return { content: [{ type: 'text', text: JSON.stringify(runs, null, 2) }] };
    },
  );

  server.registerTool(
    'read_session',
    {
      title: 'Read one recorded one-agent session',
      description:
        'Read one run recorded under the current one-agent request, including prompt, status, summary, and recent event content.',
      inputSchema: {
        runId: z.string().describe('Run id returned by list_sessions.'),
        includeEvents: z
          .boolean()
          .optional()
          .describe('Include normalized event transcript. Defaults to true.'),
        eventLimit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('Maximum number of recent events to include.'),
      },
    },
    async ({ runId, includeEvents, eventLimit }) => {
      if (!ctx.requestId) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'No current one-agent request is available.' }],
        };
      }
      const run = (await store.runsFor(ctx.requestId)).find((candidate) => candidate.id === runId);
      if (!run) {
        return {
          isError: true,
          content: [{ type: 'text', text: `No run ${runId} exists in the current request.` }],
        };
      }
      const limit = eventLimit ?? 120;
      const payload = {
        id: run.id,
        agentId: run.agentId,
        status: run.status,
        parent: run.parent,
        depth: run.depth,
        prompt: run.prompt,
        sessionId: run.sessionId,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        resultSummary: run.resultSummary,
        ...((includeEvents ?? true) ? { events: (run.events ?? []).slice(-limit) } : {}),
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );

  await server.connect(new StdioServerTransport());
}

interface DelegatedSession {
  convo: Conversation;
  agent: string;
  cwd: string;
  requestId: string;
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
