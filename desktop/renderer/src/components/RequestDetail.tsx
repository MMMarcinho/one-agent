import type { RequestDetail } from '@shared/ipc';

/**
 * Read-only view of a past request (需求): its prompt and every backend session
 * it spawned across agents, including delegated sub-runs (indented under the
 * agent that delegated them).
 */
export function RequestDetailView({
  detail,
  onClose,
}: {
  detail: RequestDetail;
  onClose: () => void;
}) {
  return (
    <div className="transcript">
      <div className="turn">
        <button className="back" onClick={onClose}>
          ← Back
        </button>
        <h2 className="detail-title">{detail.title}</h2>
        <div className="detail-meta">{new Date(detail.createdAt).toLocaleString()}</div>
        <div className="user-msg">{detail.prompt}</div>

        <div className="section-label" style={{ margin: '14px 0 8px' }}>
          Sessions
        </div>
        <div className="runs">
          {detail.runs.length === 0 && <div className="empty">No runs recorded.</div>}
          {detail.runs.map((run) => (
            <div
              className="run-row"
              key={run.id}
              style={{ marginLeft: `${run.depth * 18}px` }}
            >
              <span className={`run-mark status-${run.status}`}>{mark(run.status)}</span>
              <div className="run-body">
                <div className="run-head">
                  <span className="run-agent">{run.agentId}</span>
                  <span className="run-via">
                    {run.depth === 0 ? 'user' : `via ${run.parent}`}
                  </span>
                  {run.sessionId && (
                    <span className="run-session">session {run.sessionId.slice(0, 8)}</span>
                  )}
                </div>
                {run.resultSummary && <div className="run-summary">{run.resultSummary}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function mark(status: string): string {
  if (status === 'done') return '✓';
  if (status === 'error') return '✗';
  if (status === 'cancelled') return '⊘';
  return '·';
}
