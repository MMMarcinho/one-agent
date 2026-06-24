import type { AgentInfo, InitResult, ProjectInfo, RequestSummary } from '@shared/ipc';

interface Props {
  project: ProjectInfo | null;
  projects: ProjectInfo[];
  specInfo: InitResult | null;
  agents: AgentInfo[];
  activeAgent: string;
  onPickDir: () => void;
  onSelectProject: (path: string) => void;
  onSelectAgent: (id: string) => void;
  history: RequestSummary[];
  onSelectRequest: (id: string) => void;
  onNewChat: () => void;
}

export function Sidebar({
  project,
  projects,
  specInfo,
  agents,
  activeAgent,
  onPickDir,
  onSelectProject,
  onSelectAgent,
  history,
  onSelectRequest,
  onNewChat,
}: Props) {
  const availableCount = agents.filter((a) => a.available).length;

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-dot" />
        one-agent
      </div>

      <Section label="Projects" action={<button className="link" onClick={onPickDir}>+ Open</button>}>
        {projects.length === 0 && <div className="empty">Open a folder to start</div>}
        <ul className="projects">
          {projects.map((p) => (
            <li key={p.id}>
              <button
                className={`project-item${project?.id === p.id ? ' active' : ''}`}
                title={p.path}
                onClick={() => onSelectProject(p.path)}
              >
                <span className="project-name">{p.name}</span>
                <span className="project-path">{shorten(p.path)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <button className="new-chat" onClick={onNewChat} disabled={!project}>
        + New session
      </button>

      <Section label="Agent">
        <AgentRow
          title="Auto"
          subtitle={`route automatically · ${availableCount} available`}
          available={availableCount > 0}
          active={activeAgent === 'auto'}
          onClick={() => onSelectAgent('auto')}
        />
        {agents.map((a) => (
          <AgentRow
            key={a.id}
            title={a.id}
            subtitle={a.available ? a.role : (a.reason ?? 'unavailable')}
            available={a.available}
            active={activeAgent === a.id}
            onClick={() => a.available && onSelectAgent(a.id)}
          />
        ))}
        {specInfo && (
          <div className="badges">
            <span className="badge" title={specInfo.specPath}>
              {specInfo.usingBuiltin ? 'built-in spec' : 'one-agent.yaml'}
            </span>
            {specInfo.conventionsPath && <span className="badge">ONE_AGENT.md</span>}
          </div>
        )}
      </Section>

      <Section label="Sessions">
        {history.length === 0 && <div className="empty">No sessions yet</div>}
        <ul className="history">
          {history.slice(0, 40).map((r) => (
            <li key={r.id}>
              <button
                className="history-item"
                title={r.title}
                onClick={() => onSelectRequest(r.id)}
              >
                <div className="history-title">{r.title}</div>
                <div className="history-agents">{r.agents.join(' · ') || '—'}</div>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </aside>
  );
}

function Section({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="section">
      <div className="section-head">
        <div className="section-label">{label}</div>
        {action}
      </div>
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

function shorten(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 2 ? path : '…/' + parts.slice(-2).join('/');
}
