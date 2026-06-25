import type {
  AgentEvent,
  InitResult,
  OneAgentAPI,
  ProjectInfo,
  RequestDetail,
  RequestSummary,
  RunEventMsg,
} from '@shared/ipc';

const now = new Date().toISOString();
const project: ProjectInfo = {
  id: 'dev-project',
  path: '/Users/marco/github/one-agent',
  name: 'one-agent',
  alias: 'One Agent',
  lastUsedAt: now,
  lastSessionAt: new Date(Date.now() - 4 * 60_000).toISOString(),
};

const projects: ProjectInfo[] = [
  project,
  {
    id: 'dev-aizo',
    path: '/Users/marco/github/aizo',
    name: 'aizo',
    alias: 'Aizo',
    lastUsedAt: new Date(Date.now() - 3600_000).toISOString(),
    lastSessionAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  },
];

const summaries: RequestSummary[] = [
  {
    id: 'req-codex',
    title: 'Add Codex app-server session support',
    createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    latestAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    agents: ['codex'],
    agentRuns: [
      {
        agentId: 'codex',
        statuses: ['done'],
        runCount: 2,
        latestAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      },
    ],
    statuses: ['done'],
    runCount: 2,
  },
  {
    id: 'req-mixed',
    title: 'Review sidebar sessions and delegated run transcript',
    createdAt: new Date(Date.now() - 42 * 60_000).toISOString(),
    latestAt: new Date(Date.now() - 33 * 60_000).toISOString(),
    agents: ['claude-code', 'codex'],
    agentRuns: [
      {
        agentId: 'claude-code',
        statuses: ['done'],
        runCount: 1,
        latestAt: new Date(Date.now() - 38 * 60_000).toISOString(),
      },
      {
        agentId: 'codex',
        statuses: ['done'],
        runCount: 2,
        latestAt: new Date(Date.now() - 33 * 60_000).toISOString(),
      },
    ],
    statuses: ['done'],
    runCount: 3,
  },
  {
    id: 'req-claude',
    title: 'Polish desktop transcript display',
    createdAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    latestAt: new Date(Date.now() - 74 * 60_000).toISOString(),
    agents: ['claude-code'],
    agentRuns: [
      {
        agentId: 'claude-code',
        statuses: ['cancelled'],
        runCount: 1,
        latestAt: new Date(Date.now() - 74 * 60_000).toISOString(),
      },
    ],
    statuses: ['cancelled'],
    runCount: 1,
  },
];

const details: Record<string, RequestDetail> = {
  'req-codex': {
    id: 'req-codex',
    title: summaries[0].title,
    prompt: 'Add Codex app-server session support and keep exec fallback.',
    cwd: project.path,
    createdAt: summaries[0].createdAt,
    runs: [
      {
        id: 'run-codex-1',
        agentId: 'codex',
        parent: 'user',
        depth: 0,
        prompt: 'Probe app-server and implement adapter.',
        status: 'done',
        startedAt: summaries[0].createdAt,
        endedAt: summaries[0].latestAt,
        sessionId: '019efa03-6e49-7580-b421-c0daa5d4dba8',
        resultSummary: 'Implemented app-server handshake, thread/start, turn/start, and fallback.',
        events: [
          { at: now, event: { kind: 'session', sessionId: '019efa03-6e49-7580-b421-c0daa5d4dba8' } },
          { at: now, event: { kind: 'thinking', text: 'Checking Codex app-server protocol fields.' } },
          { at: now, event: { kind: 'assistant', text: 'Codex now opens persistent project threads.' } },
          { at: now, event: { kind: 'done' } },
        ],
      },
    ],
  },
  'req-mixed': {
    id: 'req-mixed',
    title: summaries[1].title,
    prompt: 'Review sidebar sessions and delegated run transcript.',
    cwd: project.path,
    createdAt: summaries[1].createdAt,
    runs: [
      {
        id: 'run-mixed-1',
        agentId: 'claude-code',
        parent: 'user',
        depth: 0,
        prompt: 'Polish session list.',
        status: 'done',
        startedAt: summaries[1].createdAt,
        resultSummary: 'Grouped sessions by agent and added status metadata.',
      },
      {
        id: 'run-mixed-2',
        agentId: 'codex',
        parent: 'claude-code',
        depth: 1,
        prompt: 'Check event transcript behavior.',
        status: 'done',
        startedAt: summaries[1].latestAt,
        resultSummary: 'Delegated run transcript renders with preserved lineage.',
      },
    ],
  },
  'req-claude': {
    id: 'req-claude',
    title: summaries[2].title,
    prompt: 'Polish desktop transcript display.',
    cwd: project.path,
    createdAt: summaries[2].createdAt,
    runs: [
      {
        id: 'run-claude-1',
        agentId: 'claude-code',
        parent: 'user',
        depth: 0,
        prompt: 'Improve transcript UI.',
        status: 'cancelled',
        startedAt: summaries[2].createdAt,
        endedAt: summaries[2].latestAt,
        resultSummary: 'Interrupted during UI iteration.',
      },
    ],
  },
};

export function installDevBridge(): void {
  if (!import.meta.env.DEV || window.oneAgent) return;

  const listeners = new Set<(msg: RunEventMsg) => void>();
  const emit = (msg: RunEventMsg) => listeners.forEach((listener) => listener(msg));

  const api: OneAgentAPI = {
    async init(): Promise<InitResult> {
      return {
        cwd: project.path,
        project,
        usingBuiltin: true,
        defaultAgent: 'claude-code',
        routingAuto: true,
        agents: [
          {
            id: 'claude-code',
            type: 'claude-code',
            role: 'General-purpose coding and repo-wide reasoning.',
            available: true,
            isDefault: true,
            canDelegateTo: ['codex'],
          },
          {
            id: 'codex',
            type: 'codex',
            role: 'Focused edits and second opinion.',
            available: true,
            isDefault: false,
            canDelegateTo: ['claude-code'],
          },
        ],
      };
    },
    async pickDirectory() {
      return project.path;
    },
    async listProjects() {
      return projects;
    },
    async renameProject(id, alias) {
      const found = projects.find((item) => item.id === id);
      if (!found) return null;
      found.alias = alias.trim() || found.name;
      return found;
    },
    async listAgents() {
      return (await api.init()).agents;
    },
    async listRequests() {
      return summaries;
    },
    async getRequest(id: string) {
      return details[id] ?? null;
    },
    async startConversation(input) {
      const conversationId = `dev-${input.turnId}`;
      streamDemo(conversationId, input.turnId, input.agentId ?? 'auto', emit);
      return { conversationId, agentId: input.agentId === 'codex' ? 'codex' : 'claude-code', reason: 'dev mock route' };
    },
    async sendMessage(input) {
      streamDemo(input.conversationId, input.turnId, 'claude-code', emit);
    },
    async cancelTurn() {},
    async closeConversation() {},
    onRunEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  window.oneAgent = api;
}

function streamDemo(
  conversationId: string,
  turnId: string,
  agentId: string,
  emit: (msg: RunEventMsg) => void,
): void {
  const resolved = agentId === 'codex' ? 'codex' : 'claude-code';
  emit({ conversationId, turnId, kind: 'routed', agentId: resolved, reason: 'dev mock route' });
  const events: AgentEvent[] = [
    { kind: 'thinking', text: 'Reading project context and checking available agents.' },
    { kind: 'tool-call', name: 'list_sessions', input: { includeEvents: true } },
    { kind: 'assistant', text: 'This is a browser-only development preview. Electron uses the real preload bridge.' },
    { kind: 'done' },
  ];
  events.forEach((event, index) => {
    window.setTimeout(() => {
      emit({ conversationId, turnId, kind: 'event', event });
      if (event.kind === 'done') {
        emit({ conversationId, turnId, kind: 'finished', cancelled: false });
      }
    }, 140 * (index + 1));
  });
}
