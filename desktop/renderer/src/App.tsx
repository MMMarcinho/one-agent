import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentInfo, InitResult, RequestSummary, RunEventMsg } from '@shared/ipc';
import type { Block, Turn } from './ui-types';
import { Sidebar } from './components/Sidebar';
import { Transcript } from './components/Transcript';
import { Composer } from './components/Composer';

export function App() {
  const [init, setInit] = useState<InitResult | null>(null);
  const [cwd, setCwd] = useState<string>('');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgent, setActiveAgent] = useState<string>('auto');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [history, setHistory] = useState<RequestSummary[]>([]);
  const [running, setRunning] = useState<string | null>(null);

  const refreshHistory = useCallback(() => {
    window.oneAgent.listRequests().then(setHistory);
  }, []);

  const loadDir = useCallback(
    async (dir?: string) => {
      const res = await window.oneAgent.init(dir);
      setInit(res);
      setCwd(res.cwd);
      setAgents(res.agents);
      const firstAvailable = res.agents.find((a) => a.available);
      const def = res.agents.find((a) => a.isDefault && a.available);
      const availableCount = res.agents.filter((a) => a.available).length;
      setActiveAgent(
        res.routingAuto && availableCount > 1
          ? 'auto'
          : (def?.id ?? firstAvailable?.id ?? 'auto'),
      );
      refreshHistory();
    },
    [refreshHistory],
  );

  useEffect(() => {
    void loadDir();
  }, [loadDir]);

  // Single subscription to streamed run events; dispatch by requestId.
  useEffect(() => {
    return window.oneAgent.onRunEvent((msg: RunEventMsg) => {
      setTurns((prev) => applyEvent(prev, msg));
      if (msg.kind === 'finished') {
        setRunning(null);
        refreshHistory();
      }
    });
  }, [refreshHistory]);

  const pickDir = useCallback(async () => {
    const dir = await window.oneAgent.pickDirectory();
    if (dir) {
      setTurns([]);
      await loadDir(dir);
    }
  }, [loadDir]);

  const send = useCallback(
    async (prompt: string) => {
      const { requestId } = await window.oneAgent.startRequest({
        cwd,
        prompt,
        agentId: activeAgent,
      });
      setRunning(requestId);
      setTurns((prev) => [
        ...prev,
        { requestId, prompt, agentId: undefined, reason: undefined, blocks: [], status: 'running' },
      ]);
    },
    [cwd, activeAgent],
  );

  const stop = useCallback(() => {
    if (running) window.oneAgent.cancelRequest(running);
  }, [running]);

  return (
    <div className="app">
      <Sidebar
        cwd={cwd}
        specInfo={init}
        agents={agents}
        activeAgent={activeAgent}
        onPickDir={pickDir}
        onSelectAgent={setActiveAgent}
        history={history}
        onNewChat={() => setTurns([])}
      />
      <main className="main">
        <Header cwd={cwd} activeAgent={activeAgent} />
        <Transcript turns={turns} />
        <Composer running={!!running} disabled={!cwd} onSend={send} onStop={stop} />
      </main>
    </div>
  );
}

function Header({ cwd, activeAgent }: { cwd: string; activeAgent: string }) {
  const folder = cwd.split('/').filter(Boolean).pop() ?? cwd;
  return (
    <header className="header">
      <div className="header-dir" title={cwd}>
        {folder || 'No directory'}
      </div>
      <div className="header-agent">{activeAgent === 'auto' ? 'Auto' : activeAgent}</div>
    </header>
  );
}

/** Pure reducer: fold a streamed event into the matching turn. */
function applyEvent(turns: Turn[], msg: RunEventMsg): Turn[] {
  return turns.map((t) => {
    if (t.requestId !== msg.requestId) return t;
    if (msg.kind === 'routed') {
      return { ...t, agentId: msg.agentId, reason: msg.reason };
    }
    if (msg.kind === 'finished') {
      return { ...t, status: t.status === 'running' ? (msg.cancelled ? 'cancelled' : 'done') : t.status };
    }
    // kind === 'event'
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
