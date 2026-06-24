import { useCallback, useEffect, useState } from 'react';
import type {
  AgentInfo,
  InitResult,
  ProjectInfo,
  RequestDetail,
  RequestSummary,
  RunEventMsg,
} from '@shared/ipc';
import type { Block, Turn } from './ui-types';
import { Sidebar } from './components/Sidebar';
import { Transcript } from './components/Transcript';
import { Composer } from './components/Composer';
import { RequestDetailView } from './components/RequestDetail';

export function App() {
  const [init, setInit] = useState<InitResult | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgent, setActiveAgent] = useState<string>('auto');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [history, setHistory] = useState<RequestSummary[]>([]);
  const [running, setRunning] = useState<string | null>(null); // turnId
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);

  const refreshProjects = useCallback(() => {
    window.oneAgent.listProjects().then(setProjects);
  }, []);
  const refreshHistory = useCallback((projectId?: string) => {
    if (projectId) window.oneAgent.listRequests(projectId).then(setHistory);
  }, []);

  const endConversation = useCallback(() => {
    if (conversationId) window.oneAgent.closeConversation(conversationId);
    setConversationId(null);
  }, [conversationId]);

  const loadDir = useCallback(
    async (dir?: string) => {
      const res = await window.oneAgent.init(dir);
      setInit(res);
      setProject(res.project);
      setAgents(res.agents);
      const firstAvailable = res.agents.find((a) => a.available);
      const def = res.agents.find((a) => a.isDefault && a.available);
      const availableCount = res.agents.filter((a) => a.available).length;
      setActiveAgent(
        res.routingAuto && availableCount > 1 ? 'auto' : (def?.id ?? firstAvailable?.id ?? 'auto'),
      );
      refreshProjects();
      refreshHistory(res.project.id);
    },
    [refreshProjects, refreshHistory],
  );

  useEffect(() => {
    void loadDir();
  }, [loadDir]);

  // Single subscription to streamed run events; dispatch by turnId.
  useEffect(() => {
    return window.oneAgent.onRunEvent((msg: RunEventMsg) => {
      setTurns((prev) => applyEvent(prev, msg));
      if (msg.kind === 'finished') {
        setRunning((r) => (r === msg.turnId ? null : r));
        refreshHistory(project?.id);
        refreshProjects();
      }
    });
  }, [refreshHistory, refreshProjects, project?.id]);

  const switchProject = useCallback(
    async (path: string) => {
      endConversation();
      setTurns([]);
      setDetail(null);
      await loadDir(path);
    },
    [endConversation, loadDir],
  );

  const pickDir = useCallback(async () => {
    const dir = await window.oneAgent.pickDirectory();
    if (dir) await switchProject(dir);
  }, [switchProject]);

  const selectAgent = useCallback(
    (id: string) => {
      if (id !== activeAgent) endConversation(); // a conversation is bound to one agent
      setActiveAgent(id);
    },
    [activeAgent, endConversation],
  );

  const newChat = useCallback(() => {
    endConversation();
    setTurns([]);
    setDetail(null);
  }, [endConversation]);

  const send = useCallback(
    async (prompt: string) => {
      if (!project) return;
      const turnId = crypto.randomUUID();
      setDetail(null);
      setRunning(turnId);
      setTurns((prev) => [...prev, { turnId, prompt, blocks: [], status: 'running' }]);

      if (conversationId) {
        await window.oneAgent.sendMessage({ conversationId, prompt, turnId });
      } else {
        const res = await window.oneAgent.startConversation({
          cwd: project.path,
          projectId: project.id,
          prompt,
          agentId: activeAgent,
          turnId,
        });
        setConversationId(res.conversationId);
      }
    },
    [project, activeAgent, conversationId],
  );

  const stop = useCallback(() => {
    if (conversationId) window.oneAgent.cancelTurn(conversationId);
  }, [conversationId]);

  return (
    <div className="app">
      <Sidebar
        project={project}
        projects={projects}
        specInfo={init}
        agents={agents}
        activeAgent={activeAgent}
        onPickDir={pickDir}
        onSelectProject={switchProject}
        onSelectAgent={selectAgent}
        history={history}
        onSelectRequest={(id) => window.oneAgent.getRequest(id).then(setDetail)}
        onNewChat={newChat}
      />
      <main className="main">
        <Header project={project} activeAgent={activeAgent} continued={!!conversationId} />
        {detail ? (
          <RequestDetailView detail={detail} onClose={() => setDetail(null)} />
        ) : (
          <Transcript turns={turns} />
        )}
        <Composer running={!!running} disabled={!project} onSend={send} onStop={stop} />
      </main>
    </div>
  );
}

function Header({
  project,
  activeAgent,
  continued,
}: {
  project: ProjectInfo | null;
  activeAgent: string;
  continued: boolean;
}) {
  return (
    <header className="header">
      <div className="header-dir" title={project?.path}>
        {project?.name ?? 'No project'}
      </div>
      <div className="header-agent">
        {activeAgent === 'auto' ? 'Auto' : activeAgent}
        {continued && (
          <span className="header-cont" title="conversation in progress">
            {' '}
            · live
          </span>
        )}
      </div>
    </header>
  );
}

/** Pure reducer: fold a streamed event into the matching turn (by turnId). */
function applyEvent(turns: Turn[], msg: RunEventMsg): Turn[] {
  return turns.map((t) => {
    if (t.turnId !== msg.turnId) return t;
    if (msg.kind === 'routed') {
      return { ...t, agentId: msg.agentId, reason: msg.reason };
    }
    if (msg.kind === 'finished') {
      return {
        ...t,
        status: t.status === 'running' ? (msg.cancelled ? 'cancelled' : 'done') : t.status,
      };
    }
    const ev = msg.event;
    const blocks = [...t.blocks];
    switch (ev.kind) {
      case 'assistant':
        appendText(blocks, 'assistant', ev.text);
        break;
      case 'thinking':
        appendText(blocks, 'thinking', ev.text);
        break;
      case 'tool-call':
        blocks.push({ type: 'tool', name: ev.name, input: ev.input });
        break;
      case 'error':
        blocks.push({ type: 'error', message: ev.message });
        return { ...t, blocks, status: ev.fatal ? 'error' : t.status };
      default:
        break;
    }
    return { ...t, blocks };
  });
}

function appendText(blocks: Block[], type: 'assistant' | 'thinking', text: string): void {
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) {
    last.text += (last.text ? '\n' : '') + text;
  } else {
    blocks.push({ type, text });
  }
}
