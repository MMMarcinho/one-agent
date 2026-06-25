import type { AgentEvent, RequestDetail } from '@shared/ipc';

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
                {run.events && run.events.length > 0 && (
                  <details className="run-transcript">
                    <summary>{run.events.length} events</summary>
                    <div className="run-events">
                      <div className="run-prompt">{run.prompt}</div>
                      {run.events.map((entry, index) => (
                        <RunEventView event={entry.event} key={`${entry.at}-${index}`} />
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RunEventView({ event }: { event: AgentEvent }) {
  if (event.kind === 'assistant') {
    return <pre className="run-event run-event-assistant">{event.text}</pre>;
  }
  if (event.kind === 'thinking') {
    return <pre className="run-event run-event-thinking">{event.text}</pre>;
  }
  if (event.kind === 'tool-call') {
    return (
      <div className="run-event run-event-tool">
        <span className="run-event-kicker">tool</span>
        <span className="run-event-name">{event.name}</span>
        <span className="run-event-input">{summarize(event.input)}</span>
      </div>
    );
  }
  if (event.kind === 'tool-result') {
    return (
      <div className="run-event run-event-tool">
        <span className="run-event-kicker">result</span>
        <span className="run-event-name">{event.name}</span>
        <span className="run-event-input">{summarize(event.output)}</span>
      </div>
    );
  }
  if (event.kind === 'permission-request') {
    return (
      <div className="run-event run-event-tool">
        <span className="run-event-kicker">permission</span>
        <span className="run-event-input">{summarize(event.request)}</span>
      </div>
    );
  }
  if (event.kind === 'usage') {
    const parts = [
      event.inputTokens != null ? `input ${event.inputTokens}` : '',
      event.outputTokens != null ? `output ${event.outputTokens}` : '',
      event.costUsd != null ? `$${event.costUsd.toFixed(4)}` : '',
    ].filter(Boolean);
    return <div className="run-event run-event-usage">{parts.join(' · ') || 'usage'}</div>;
  }
  if (event.kind === 'error') {
    return <div className="run-event run-event-error">{event.message}</div>;
  }
  if (event.kind === 'session') {
    return <div className="run-event run-event-meta">session {event.sessionId}</div>;
  }
  return <div className="run-event run-event-meta">{event.result ?? 'done'}</div>;
}

function summarize(input: unknown): string {
  if (input == null) return '';
  const s = typeof input === 'string' ? input : JSON.stringify(input);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 180 ? flat.slice(0, 177) + '...' : flat;
}

function mark(status: string): string {
  if (status === 'done') return '✓';
  if (status === 'error') return '✗';
  if (status === 'cancelled') return '⊘';
  return '·';
}
