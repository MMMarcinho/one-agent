import type { AgentSession } from './adapter.js';
import type { SessionStore, RunRecord } from './session-store.js';
import type { AgentEvent, RunHooks } from './types.js';

/**
 * A multi-turn conversation with one agent, mapped onto the session store as a
 * single request (需求) whose turns are recorded as runs. The underlying agent
 * process stays alive across turns (for persistent backends), giving real
 * conversation continuity; each `send` is one turn.
 */
export class Conversation {
  constructor(
    private readonly session: AgentSession,
    private readonly requestId: string,
    private readonly agentId: string,
    private readonly store?: SessionStore,
    private readonly lineage: { parent: string; depth: number } = { parent: 'user', depth: 0 },
  ) {}

  get sessionId(): string | undefined {
    return this.session.sessionId;
  }

  /** Run one user turn; records it as a run under this conversation's request. */
  async *send(prompt: string, hooks: RunHooks = {}): AsyncIterable<AgentEvent> {
    const record = await this.beginRun(prompt);
    const collected: string[] = [];
    let fatal = false;
    try {
      for await (const event of this.session.send({ prompt }, hooks)) {
        await this.recordEvent(record, event);
        if (event.kind === 'session') await this.patch(record, { sessionId: event.sessionId });
        if (event.kind === 'assistant') collected.push(event.text);
        if (event.kind === 'done' && event.result) collected.push(event.result);
        if (event.kind === 'error' && event.fatal) fatal = true;
        yield event;
      }
    } finally {
      const status = hooks.signal?.aborted ? 'cancelled' : fatal ? 'error' : 'done';
      await this.finish(record, status, collected.join(''));
    }
  }

  interrupt(): void {
    this.session.interrupt();
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  private async beginRun(prompt: string): Promise<RunRecord | undefined> {
    if (!this.store) return undefined;
    return this.store.startRun({
      requestId: this.requestId,
      agentId: this.agentId,
      parent: this.lineage.parent,
      depth: this.lineage.depth,
      prompt,
    });
  }

  private async patch(
    record: RunRecord | undefined,
    patch: Parameters<SessionStore['updateRun']>[1],
  ): Promise<void> {
    if (record && this.store) await this.store.updateRun(record, patch);
  }

  private async recordEvent(
    record: RunRecord | undefined,
    event: AgentEvent,
  ): Promise<void> {
    if (record && this.store) await this.store.appendRunEvent(record, event);
  }

  private async finish(
    record: RunRecord | undefined,
    status: 'done' | 'error' | 'cancelled',
    output: string,
  ): Promise<void> {
    if (!record || !this.store || record.status !== 'running') return;
    const flat = output.replace(/\s+/g, ' ').trim();
    await this.store.updateRun(record, {
      status,
      endedAt: new Date().toISOString(),
      resultSummary: flat.length > 200 ? flat.slice(0, 197) + '…' : flat,
    });
  }
}
