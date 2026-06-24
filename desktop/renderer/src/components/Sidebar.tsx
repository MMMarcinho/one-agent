import type { AgentInfo, InitResult, RequestSummary } from '@shared/ipc';

interface Props {
  cwd: string;
  specInfo: InitResult | null;
  agents: AgentInfo[];
  activeAgent: string;
  onPickDir: () => void;
  onSelectAgent: (id: string) => void;
  history: RequestSummary[];
  onNewChat: () => void;
}

export function Sidebar({
  cwd,
  specInfo,
  agents,
  activeAgent,
  onPickDir,
  onSelectAgent,
  history,
  onNewChat,
}: Props) {
  const folder = cwd.split('/').filter(Boolean).pop() ?? cwd;
  const availableCount = agents.filter((a) => a.available).length;

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-dot" />
        one-agent
      </div>

      <button className="new-chat" onClick={onNewChat}>
        + New request
      </button>

      <Section label="Directory">
        <button className="dir-button" onClick={onPickDir} title={cwd}>
          <span className="dir-name">{folder || 'Choose a folder…'}</span>
          <span className="dir-change">Change</span>
        </button>
        {specInfo && (
          <div className="badges">
            <span className="badge" title={specInfo.specPath}>
              {specInfo.usingBuiltin ? 'built-in spec' : 'one-agent.yaml'}
            </span>
            {specInfo.conventionsPath && <span className="badge">ONE_AGENT.md</span>}
          </div>
        )}
      </Section>

      <Section label="Agent">
        <AgentRow
          id="auto"
          title="Auto"
          subtitle={`route automatically · ${availableCount} available`}
          available={availableCount > 0}
          active={activeAgent === 'auto'}
          onClick={() => onSelectAgent('auto')}
        />
        {agents.map((a) => (
          <AgentRow
            key={a.id}
            id={a.id}
            title={a.id}
            subtitle={a.available ? a.role : (a.reason ?? 'unavailable')}
            available={a.available}
            active={activeAgent === a.id}
            onClick={() => a.available && onSelectAgent(a.id)}
          />
        ))}
      </Section>

      <Section label="Recent requests">
        {history.length === 0 && <div className="empty">No requests yet</div>}
        <ul className="history">
          {history.slice(0, 30).map((r) => (
            <li key={r.id} className="history-item" title={r.title}>
              <div className="history-title">{r.title}</div>
              <div className="history-agents">{r.agents.join(' · ') || '—'}</div>
            </li>
          ))}
        </ul>
      </Section>
    </aside>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="section">
      <div className="section-label">{label}</div>
      {children}
    </div>
  );
}

function AgentRow({
  title,
  subtitle,
  available,
  active,
  onClick,
}: {
  id: string;
  title: string;
  subtitle?: string;
  available: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`agent-row${active ? ' active' : ''}${available ? '' : ' disabled'}`}
      onClick={onClick}
      disabled={!available}
    >
      <span className={`status-dot${available ? ' on' : ''}`} />
      <span className="agent-meta">
        <span className="agent-name">{title}</span>
        {subtitle && <span className="agent-sub">{subtitle}</span>}
      </span>
    </button>
  );
}
