import type { AgentEvent } from '../core/types.js';

/** Drain an event stream into the agent's concatenated assistant text. */
export async function collectText(stream: AsyncIterable<AgentEvent>): Promise<string> {
  const parts: string[] = [];
  for await (const event of stream) {
    if (event.kind === 'assistant') parts.push(event.text);
    else if (event.kind === 'done' && event.result) parts.push(event.result);
    else if (event.kind === 'error' && event.fatal) parts.push(`[error] ${event.message}`);
  }
  return parts.join('').trim();
}
