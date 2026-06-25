import { useState, type ReactNode } from 'react';
import type { InitResult, ProjectInfo, RequestSummary } from '@shared/ipc';

interface Props {
  project: ProjectInfo | null;
  projects: ProjectInfo[];
  specInfo: InitResult | null;
  onPickDir: () => void;
  onSelectProject: (path: string) => void;
  onRenameProject: (id: string, alias: string) => void | Promise<void>;
  history: RequestSummary[];
  onSelectRequest: (id: string) => void;
  onNewChat: () => void;
}

export function Sidebar({
  project,
  projects,
  specInfo,
  onPickDir,
  onSelectProject,
  onRenameProject,
  history,
  onSelectRequest,
  onNewChat,
}: Props) {
  const [editingProject, setEditingProject] = useState<{ id: string; alias: string } | null>(null);
  const grouped = groupHistory(history);

  const submitAlias = () => {
    if (!editingProject) return;
    const { id, alias } = editingProject;
    setEditingProject(null);
    void onRenameProject(id, alias);
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-dot" />
        <span>one-agent</span>
      </div>
      {specInfo && (
        <div className="spec-line">
          <span className="badge" title={specInfo.specPath}>
            {specInfo.usingBuiltin ? 'built-in spec' : 'one-agent.yaml'}
          </span>
          {specInfo.conventionsPath && <span className="badge">ONE_AGENT.md</span>}
        </div>
      )}

      <Section
        label="Projects"
        action={
          <button className="icon-action" onClick={onPickDir} title="Open project" type="button">
            Open
          </button>
        }
      >
        {projects.length === 0 && <div className="empty">Open a folder to start</div>}
        <ul className="projects">
          {projects.map((p) => (
            <li key={p.id}>
              {editingProject?.id === p.id ? (
                <input
                  autoFocus
                  className="project-alias-input"
                  value={editingProject.alias}
                  onBlur={submitAlias}
                  onChange={(e) => setEditingProject({ id: p.id, alias: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitAlias();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingProject(null);
                    }
                  }}
                />
              ) : (
                <button
                  className={`project-item${project?.id === p.id ? ' active' : ''}`}
                  title={`${p.path}\nDouble-click to rename`}
                  onClick={() => onSelectProject(p.path)}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    setEditingProject({ id: p.id, alias: p.alias });
                  }}
                  type="button"
                >
                  <span className="project-name">{p.alias}</span>
                  <span className="project-path">{formatSessionTime(p.lastSessionAt)}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        label="Sessions"
        action={
          <button
            className="icon-action"
            onClick={onNewChat}
            disabled={!project}
            title="New session"
            type="button"
          >
            +
          </button>
        }
      >
        {history.length === 0 && <div className="empty">No sessions yet</div>}
        <div className="history-groups">
          {grouped.map((group) => (
            <div className="history-group" key={group.agent}>
              <div className="history-group-label">{group.agent}</div>
              <ul className="history">
                {group.items.slice(0, 40).map((r) => (
                  <li key={`${r.id}:${r.agent}`}>
                    <button
                      className="history-item"
                      title={r.title}
                      onClick={() => onSelectRequest(r.id)}
                    >
                      <div className="history-topline">
                        <span className="history-title">{r.title}</span>
                        <span className={`history-status status-${dominantStatus(r.agentStatuses)}`}>
                          {dominantStatus(r.agentStatuses)}
                        </span>
                      </div>
                      <div className="history-agents">
                        {new Date(r.agentLatestAt).toLocaleString()} · {r.agentRunCount} run
                        {r.agentRunCount === 1 ? '' : 's'}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
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
  action?: ReactNode;
  children: ReactNode;
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

function formatSessionTime(iso?: string): string {
  if (!iso) return 'No sessions';
  return formatRelativeTime(iso);
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const ms = Date.now() - date.getTime();
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

interface HistoryEntry extends RequestSummary {
  agent: string;
  agentStatuses: RequestSummary['statuses'];
  agentRunCount: number;
  agentLatestAt: string;
}

function groupHistory(history: RequestSummary[]): Array<{ agent: string; items: HistoryEntry[] }> {
  const map = new Map<string, HistoryEntry[]>();
  for (const item of history) {
    const agentRuns =
      item.agentRuns.length > 0
        ? item.agentRuns
        : [{ agentId: 'unassigned', statuses: item.statuses, runCount: item.runCount, latestAt: item.latestAt }];
    for (const run of agentRuns) {
      const bucket = map.get(run.agentId) ?? [];
      bucket.push({
        ...item,
        agent: run.agentId,
        agentStatuses: run.statuses,
        agentRunCount: run.runCount,
        agentLatestAt: run.latestAt,
      });
      map.set(run.agentId, bucket);
    }
  }
  return [...map.entries()].map(([agent, items]) => ({
    agent,
    items: items.sort((a, b) => b.agentLatestAt.localeCompare(a.agentLatestAt)),
  }));
}

function dominantStatus(statuses: RequestSummary['statuses']): string {
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('cancelled')) return 'cancelled';
  if (statuses.includes('done')) return 'done';
  return 'new';
}
