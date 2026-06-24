import { useState, type KeyboardEvent } from 'react';

interface Props {
  running: boolean;
  disabled: boolean;
  onSend: (prompt: string) => void;
  onStop: () => void;
}

export function Composer({ running, disabled, onSend, onStop }: Props) {
  const [text, setText] = useState('');

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    onSend(trimmed);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        className="composer-input"
        placeholder={disabled ? 'Choose a directory to begin…' : 'Describe a task…  (Enter to send, Shift+Enter for newline)'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        rows={1}
      />
      {running ? (
        <button className="send stop" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button className="send" onClick={submit} disabled={disabled || !text.trim()}>
          Send
        </button>
      )}
    </div>
  );
}
