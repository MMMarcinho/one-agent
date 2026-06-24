import { useEffect, useRef } from 'react';
import type { Turn } from '../ui-types';

export function Transcript({ turns }: { turns: Turn[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  if (turns.length === 0) {
    return (
      <div className="transcript empty-state">
        <div className="empty-card">
          <h2>Start coding</h2>
          <p>
            Pick a directory, then describe what you want. one-agent routes the work to a
            local agent — and lets agents delegate to each other under your rules.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="transcript">
      {turns.map((t) => (
        <div className="turn" key={t.turnId}>
          <div className="user-msg">{t.prompt}</div>

          <div className="agent-line">
            <span className={`agent-badge status-${t.status}`}>
              {t.agentId ?? 'routing…'}
            </span>
            {t.reason && <span className="agent-reason">{t.reason}</span>}
            {t.status === 'running' && <span className="spinner" />}
            {t.status === 'cancelled' && <span className="agent-reason">interrupted</span>}
          </div>

          <div className="blocks">
            {t.blocks.map((b, i) => {
              if (b.type === 'assistant') return <pre className="assistant" key={i}>{b.text}</pre>;
              if (b.type === 'thinking') return <pre className="thinking" key={i}>{b.text}</pre>;
              if (b.type === 'error') return <div className="error" key={i}>{b.message}</div>;
              return (
                <div className="tool" key={i}>
                  <span className="tool-name">⚙ {b.name}</span>
                  <span className="tool-input">{summarize(b.input)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function summarize(input: unknown): string {
  if (input == null) return '';
  const s = typeof input === 'string' ? input : JSON.stringify(input);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? flat.slice(0, 117) + '…' : flat;
}
