import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentAdapter, DetectResult } from '../core/adapter.js';
import type { AgentDescriptor, AgentEvent, RunHooks, RunRequest } from '../core/types.js';
import { killOnAbort, readLines, which } from './process-util.js';

/**
 * Generic adapter for any agent that speaks the Agent Client Protocol (ACP) —
 * JSON-RPC 2.0 over stdio. This is the long-tail path: an agent only needs an
 * ACP entrypoint to be drivable by one-agent without bespoke code.
 *
 * Flow: initialize -> session/new -> session/prompt, translating the agent's
 * `session/update` notifications into normalized events. Client-side methods
 * (fs access, permission) are answered with conservative defaults for now.
 */
export class AcpAdapter implements AgentAdapter {
  readonly type = 'acp';

  async detect(descriptor: AgentDescriptor): Promise<DetectResult> {
    const resolved = await which(descriptor.command);
    return resolved
      ? { available: true, resolvedPath: resolved }
      : { available: false, reason: `"${descriptor.command}" not found on PATH` };
  }

  async *run(
    descriptor: AgentDescriptor,
    request: RunRequest,
    hooks: RunHooks,
  ): AsyncIterable<AgentEvent> {
    const child = spawn(descriptor.command, descriptor.args ?? [], {
      cwd: request.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...descriptor.env },
    });
    killOnAbort(hooks.signal, child);

    const conn = new JsonRpcConnection(child);
    const queue = new EventQueue();

    // On cancellation, reject any in-flight JSON-RPC call so the driver below
    // unwinds promptly instead of awaiting a response the killed agent won't send.
    const onAbort = () => conn.dispose(new Error('run aborted'));
    if (hooks.signal) {
      if (hooks.signal.aborted) onAbort();
      else hooks.signal.addEventListener('abort', onAbort, { once: true });
    }

    conn.onNotification = (method, params) => {
      if (method === 'session/update') {
        const event = translateUpdate(params as Record<string, unknown>);
        if (event) queue.push(event);
      }
    };
    conn.onRequest = async (method, params) => {
      return handleClientRequest(method, params as Record<string, unknown>, hooks);
    };

    (async () => {
      try {
        await conn.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        });
        const session = (await conn.request('session/new', {
          cwd: request.cwd,
          mcpServers: request.mcpServers ?? [],
        })) as { sessionId?: string };
        if (session.sessionId) queue.push({ kind: 'session', sessionId: session.sessionId });

        const promptText = request.systemConvention
          ? `<orchestration-context>\n${request.systemConvention}\n</orchestration-context>\n\n${request.prompt}`
          : request.prompt;
        const result = (await conn.request('session/prompt', {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: promptText }],
        })) as { stopReason?: string };
        queue.push({ kind: 'done', result: result.stopReason });
      } catch (err) {
        queue.push({ kind: 'error', message: String(err), fatal: true });
        queue.push({ kind: 'done' });
      } finally {
        queue.close();
        child.kill();
      }
    })();

    yield* queue;
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
  if (Array.isArray(content)) {
    return content.map((c) => contentText(c) ?? '').join('');
  }
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
    // Conservative default: allow once if any allow-option exists.
    const allow = options.find((o) => o.kind?.includes('allow'));
    return {
      outcome: { outcome: 'selected', optionId: allow?.optionId ?? options[0]?.optionId },
    };
  }
  // fs/read_text_file, fs/write_text_file, etc. left to extend.
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

  private respond(id: unknown, result: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  /** Reject all pending requests; used when the run is cancelled. */
  dispose(err: unknown): void {
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      waiter.reject(err);
    }
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

/** Push-based async iterable so producers and the consumer can decouple. */
class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly buffer: AgentEvent[] = [];
  private resolver?: () => void;
  private closed = false;

  push(event: AgentEvent): void {
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
