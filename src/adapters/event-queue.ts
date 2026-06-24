import type { AgentEvent } from '../core/types.js';

/**
 * Push-based async iterable that decouples a producer (a stdout reader loop or
 * a JSON-RPC notification handler) from the consumer iterating one turn's
 * events. Closing drains nothing further; pushes after close are ignored.
 */
export class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly buffer: AgentEvent[] = [];
  private resolver?: () => void;
  private closed = false;

  push(event: AgentEvent): void {
    if (this.closed) return;
    this.buffer.push(event);
    this.resolver?.();
    this.resolver = undefined;
  }

  close(): void {
    this.closed = true;
    this.resolver?.();
    this.resolver = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
    while (true) {
      if (this.buffer.length) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((res) => (this.resolver = res));
    }
  }
}
