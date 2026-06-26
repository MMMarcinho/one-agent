import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentInfo } from '@shared/ipc';

interface Props {
  running: boolean;
  disabled: boolean;
  agents: AgentInfo[];
  activeAgent: string;
  onSelectAgent: (id: string) => void;
  continued: boolean;
  onSend: (prompt: string) => void | Promise<void>;
  onStop: () => void;
}

export function Composer({
  running,
  disabled,
  agents,
  activeAgent,
  onSelectAgent,
  continued,
  onSend,
  onStop,
}: Props) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    setText('');
    void onSend(trimmed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <div className="composer-shell">
        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder={disabled ? 'Choose a directory to begin…' : 'Ask one-agent to work on a task…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
        />
        <div className="composer-bar">
          <AgentPicker
            agents={agents}
            activeAgent={activeAgent}
            onSelectAgent={onSelectAgent}
            continued={continued}
          />
          <div className="composer-actions">
            {running ? (
              <button className="send stop" onClick={onStop} type="button" aria-label="Stop">
                Stop
              </button>
            ) : (
              <button
                className="send"
                onClick={submit}
                disabled={disabled || !text.trim()}
                type="button"
                aria-label="Send"
                title="Send"
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentPicker({
  agents,
  activeAgent,
  onSelectAgent,
  continued,
}: {
  agents: AgentInfo[];
  activeAgent: string;
  onSelectAgent: (id: string) => void;
  continued: boolean;
}) {
  const [open, setOpen] = useState(false);
  const availableCount = useMemo(() => agents.filter((a) => a.available).length, [agents]);
  const active = activeAgent === 'auto' ? undefined : agents.find((a) => a.id === activeAgent);

  return (
    <div className="composer-agent">
      <div className="agent-picker">
        <button
          className="agent-button"
          onClick={() => setOpen((v) => !v)}
          title="Choose agent for this message"
          type="button"
        >
          <span className="agent-button-dot" />
          <span>{activeAgent === 'auto' ? 'Auto' : activeAgent}</span>
        </button>
        {continued && (
          <span className="composer-live" title="continuing the current conversation">
            live
          </span>
        )}
        {open && (
          <div className="agent-popover">
            <button
              className={`agent-option${activeAgent === 'auto' ? ' active' : ''}`}
              onClick={() => {
                onSelectAgent('auto');
                setOpen(false);
              }}
              disabled={availableCount === 0}
              type="button"
            >
              <span className="agent-option-name">Auto</span>
              <span className="agent-option-sub">{availableCount} available agents</span>
            </button>
            {agents.map((a) => (
              <button
                className={`agent-option${activeAgent === a.id ? ' active' : ''}`}
                key={a.id}
                onClick={() => {
                  if (!a.available) return;
                  onSelectAgent(a.id);
                  setOpen(false);
                }}
                disabled={!a.available}
                type="button"
              >
                <span className={`status-dot${a.available ? ' on' : ''}`} />
                <span className="agent-option-copy">
                  <span className="agent-option-name">{a.id}</span>
                  <span className="agent-option-sub">
                    {a.available ? (a.role ?? a.type) : (a.reason ?? 'unavailable')}
                  </span>
                </span>
              </button>
            ))}
            {active?.canDelegateTo && active.canDelegateTo.length > 0 && (
              <div className="agent-delegates">can delegate to {active.canDelegateTo.join(', ')}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
