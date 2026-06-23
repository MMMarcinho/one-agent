import type { AgentEvent } from '../core/types.js';

const colors = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;
const c = enabled
  ? colors
  : (Object.fromEntries(
      Object.keys(colors).map((k) => [k, (s: string) => s]),
    ) as typeof colors);

/** Pretty-print one normalized event to stdout. Returns false on fatal error. */
export function renderEvent(event: AgentEvent, agentId: string): boolean {
  switch (event.kind) {
    case 'session':
      process.stdout.write(c.dim(`  · session ${event.sessionId}\n`));
      return true;
    case 'thinking':
      process.stdout.write(c.dim(event.text));
      return true;
    case 'assistant':
      process.stdout.write(event.text);
      return true;
    case 'tool-call':
      process.stdout.write(c.cyan(`\n  ⚙ ${agentId} → ${event.name}`) + c.dim(summarize(event.input)) + '\n');
      return true;
    case 'tool-result':
      return true;
    case 'permission-request':
      process.stdout.write(c.yellow(`\n  ? permission: ${event.request.summary}\n`));
      return true;
    case 'usage':
      return true;
    case 'error':
      process.stdout.write(c.red(`\n  ✖ ${event.message}\n`));
      return !event.fatal;
    case 'done':
      process.stdout.write('\n');
      return true;
  }
}

function summarize(input: unknown): string {
  if (input == null) return '';
  const s = typeof input === 'string' ? input : JSON.stringify(input);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? ` ${flat.slice(0, 77)}…` : ` ${flat}`;
}

export const ui = {
  banner: () => c.magenta('one-agent') + c.dim(' — one entry, any agent'),
  label: (s: string) => c.cyan(s),
  dim: (s: string) => c.dim(s),
  ok: (s: string) => c.green(s),
  warn: (s: string) => c.yellow(s),
  err: (s: string) => c.red(s),
};
