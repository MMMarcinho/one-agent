import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentAdapter,
  AgentSession,
  DetectResult,
  SessionOpts,
  TurnInput,
} from '../core/adapter.js';
import type { AgentDescriptor, AgentEvent, RunHooks } from '../core/types.js';
import { EventQueue } from './event-queue.js';
import { readLines, which } from './process-util.js';

/**
 * Generic adapter for any agent that speaks the Agent Client Protocol (ACP) —
 * JSON-RPC 2.0 over stdio. Naturally multi-turn: one `session/new` followed by
 * many `session/prompt` calls on a single live process.
 */
export class AcpAdapter implements AgentAdapter {
  readonly type = 'acp';

  async detect(descriptor: AgentDescriptor): Promise<DetectResult> {
    const resolved = await which(descriptor.command);
    return resolved
      ? { available: true, resolvedPath: resolved }
      : { available: false, reason: `"${descriptor.command}" not found on PATH` };
  }

  async openSession(descriptor: AgentDescriptor, opts: SessionOpts): Promise<AgentSession> {
    const child = spawn(descriptor.command, descriptor.args ?? [], {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...descriptor.env },
    });
    const session = new AcpSession(child, opts);
    await session.initialize();
    return session;
  }
}

class AcpSession implements AgentSession {
  sessionId: string | undefined;
  private readonly conn: JsonRpcConnection;
  private hooks: RunHooks = {};
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly opts: SessionOpts,
  ) {
    this.conn = new JsonRpcConnection(child);
    this.conn.onRequest = (method, params) =>
      handleClientRequest(method, params as Record<string, unknown>, this.hooks);
  }

  async initialize(): Promise<void> {
    await this.conn.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    const res = (await this.conn.request('session/new', {
      cwd: this.opts.cwd,
      mcpServers: this.opts.mcpServers ?? [],
    })) as { sessionId?: string };
    this.sessionId = res.sessionId;
  }

  async *send(input: TurnInput, hooks: RunHooks): AsyncIterable<AgentEvent> {
    this.hooks = hooks;
    const queue = new EventQueue();
    if (this.sessionId) queue.push({ kind: 'session', sessionId: this.sessionId });

    this.conn.onNotification = (method, params) => {
      if (method === 'session/update') {
        const event = translateUpdate(params as Record<string, unknown>);
        if (event) queue.push(event);
      }
    };

    const onAbort = (): void => this.interrupt();
    if (hooks.signal) {
      if (hooks.signal.aborted) onAbort();
      else hooks.signal.addEventListener('abort', onAbort, { once: true });
    }

    const promptText = this.opts.systemConvention
      ? `<orchestration-context>\n${this.opts.systemConvention}\n</orchestration-context>\n\n${input.prompt}`
      : input.prompt;

    void (async () => {
      try {
        const result = (await this.conn.request('session/prompt', {
          sessionId: this.sessionId,
          prompt: [{ type: 'text', text: promptText }],
        })) as { stopReason?: string };
        queue.push({ kind: 'done', result: result.stopReason });
      } catch (err) {
        queue.push({ kind: 'error', message: String(err), fatal: true });
        queue.push({ kind: 'done' });
      } finally {
        queue.close();
      }
    })();

    try {
      yield* queue;
    } finally {
      hooks.signal?.removeEventListener('abort', onAbort);
      this.conn.onNotification = undefined;
    }
  }

  interrupt(): void {
    // ACP cancellation: reject the in-flight prompt so the turn unwinds.
    this.conn.dispose(new Error('turn interrupted'));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.conn.dispose(new Error('session closed'));
    this.child.kill('SIGTERM');
  }
}

function translateUpdate(params: Record<string, unknown>): AgentEvent | undefined {
  const update = (params.update ?? params) as Record<string, unknown>;
  const type = update.sessionUpdate ?? update.type;
  switch (type) {
    case 'agent_message_chunk': {
      const text = contentText(update.content);
      return text ? { kind: 'assistant', text } : undefined;
    }
    case 'agent_thought_chunk': {
      const text = contentText(update.content);
      return text ? { kind: 'thinking', text } : undefined;
    }
    case 'tool_call':
      return {
        kind: 'tool-call',
        name: String(update.title ?? update.kind ?? 'tool'),
        input: update.rawInput ?? update,
        id: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
      };
    case 'tool_call_update':
      return {
        kind: 'tool-result',
        name: String(update.title ?? 'tool'),
        output: update.content ?? update.rawOutput,
        id: typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
      };
    default:
      return undefined;
  }
}

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text;
  }
  if (Array.isArray(content)) return content.map((c) => contentText(c) ?? '').join('');
  return undefined;
}

async function handleClientRequest(
  method: string,
  params: Record<string, unknown>,
  hooks: RunHooks,
): Promise<unknown> {
  if (method === 'session/request_permission') {
    const options = (params.options as Array<{ optionId: string; kind?: string }>) ?? [];
    if (hooks.onPermission) {
      const decision = await hooks.onPermission({
        id: String(params.toolCallId ?? 'perm'),
        tool: String((params.toolCall as Record<string, unknown>)?.title ?? 'tool'),
        input: params.toolCall,
        summary: 'Agent requested permission to proceed.',
      });
      const pick = options.find((o) =>
        decision.allow ? o.kind?.includes('allow') : o.kind?.includes('reject'),
      );
      return { outcome: { outcome: 'selected', optionId: pick?.optionId ?? options[0]?.optionId } };
    }
    const allow = options.find((o) => o.kind?.includes('allow'));
    return { outcome: { outcome: 'selected', optionId: allow?.optionId ?? options[0]?.optionId } };
  }
  return {};
}

/** Minimal line-delimited JSON-RPC 2.0 connection over a child's stdio. */
class JsonRpcConnection {
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    void this.readLoop();
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  dispose(err: unknown): void {
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(err);
    }
  }

  private respond(id: unknown, result: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private async readLoop(): Promise<void> {
    for await (const line of readLines(this.child.stdout)) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const waiter = this.pending.get(msg.id as number);
        if (waiter) {
          this.pending.delete(msg.id as number);
          if (msg.error) waiter.reject(msg.error);
          else waiter.resolve(msg.result);
        }
      } else if (typeof msg.method === 'string' && msg.id !== undefined) {
        const result = (await this.onRequest?.(msg.method, msg.params)) ?? {};
        this.respond(msg.id, result);
      } else if (typeof msg.method === 'string') {
        this.onNotification?.(msg.method, msg.params);
      }
    }
  }
}
