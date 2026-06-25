import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { AgentSession, SessionOpts, TurnInput } from '../core/adapter.js';
import type {
  AgentDescriptor,
  AgentEvent,
  McpServerConfig,
  PermissionMode,
  RunHooks,
} from '../core/types.js';
import { killOnAbort } from './process-util.js';

type JsonObject = { [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

type JsonRpcMessage = JsonObject & {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: JsonValue;
};

interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', cb: (event: unknown) => void): void;
}

type WebSocketCtor = new (url: string) => MinimalWebSocket;

interface RpcClient {
  request(method: string, params?: JsonValue): Promise<JsonValue>;
  notify(method: string, params?: JsonValue): void;
  respond(id: string | number, result: JsonValue): void;
  respondError(id: string | number, code: number, message: string): void;
  events: AsyncQueue<JsonRpcMessage>;
  close(): void;
}

export class CodexAppServerSession implements AgentSession {
  private threadId: string | undefined;
  private activeTurnId: string | undefined;
  private closed = false;

  private constructor(
    private readonly descriptor: AgentDescriptor,
    private readonly opts: SessionOpts,
    private readonly child: ChildProcess,
    private readonly rpc: RpcClient,
  ) {}

  get sessionId(): string | undefined {
    return this.threadId;
  }

  static async open(descriptor: AgentDescriptor, opts: SessionOpts): Promise<CodexAppServerSession> {
    const port = await freePort();
    const url = `ws://127.0.0.1:${port}`;
    const child = spawn(descriptor.command, ['app-server', '--listen', url], {
      cwd: opts.cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...descriptor.env },
    });

    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    try {
      const rpc = await connectJsonRpc(url);
      await rpc.request('initialize', {
        clientInfo: { name: 'one-agent', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      rpc.notify('initialized');
      return new CodexAppServerSession(descriptor, opts, child, rpc);
    } catch (err) {
      child.kill('SIGTERM');
      const detail = stderr.trim();
      throw new Error(`codex app-server unavailable: ${String(err)}${detail ? `\n${detail}` : ''}`);
    }
  }

  async *send(input: TurnInput, hooks: RunHooks): AsyncIterable<AgentEvent> {
    if (this.closed) {
      yield { kind: 'error', message: 'Codex app-server session is already closed', fatal: true };
      yield { kind: 'done' };
      return;
    }

    killOnAbort(hooks.signal, this.child);
    const abort = () => this.interrupt();
    hooks.signal?.addEventListener('abort', abort, { once: true });

    try {
      if (!this.threadId) {
        const response = await this.rpc.request(
          'thread/start',
          codexThreadStartParams(this.descriptor, this.opts),
        );
        this.threadId = threadIdFromResponse(response);
        if (!this.threadId) {
          throw new Error('codex app-server did not return a thread id');
        }
        yield { kind: 'session', sessionId: this.threadId };
      }

      const turnResponse = await this.rpc.request(
        'turn/start',
        codexTurnStartParams(this.descriptor, this.opts, this.threadId, input.prompt),
      );
      this.activeTurnId = turnIdFromResponse(turnResponse) ?? this.activeTurnId;

      let sawDone = false;
      while (!sawDone) {
        const msg = await this.rpc.events.shift();
        if (!msg) break;
        if (isServerRequest(msg)) {
          yield* this.handleServerRequest(msg, hooks);
          continue;
        }
        for (const event of codexAppServerEventsForTest(msg, this.threadId, this.activeTurnId)) {
          if (event.kind === 'done') sawDone = true;
          yield event;
        }
      }
      if (!sawDone) yield { kind: 'done' };
    } catch (err) {
      yield { kind: 'error', message: String(err), fatal: true };
      yield { kind: 'done' };
    } finally {
      this.activeTurnId = undefined;
      hooks.signal?.removeEventListener('abort', abort);
    }
  }

  interrupt(): void {
    if (this.threadId && this.activeTurnId) {
      this.rpc
        .request('turn/interrupt', { threadId: this.threadId, turnId: this.activeTurnId })
        .catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rpc.close();
    this.child.kill('SIGTERM');
  }

  private async *handleServerRequest(
    msg: JsonRpcMessage,
    hooks: RunHooks,
  ): AsyncIterable<AgentEvent> {
    const id = msg.id;
    const method = msg.method ?? 'request';
    const params = asObject(msg.params);
    if (id == null) return;

    if (method.endsWith('/requestApproval') || method === 'execCommandApproval') {
      const request = {
        id: String(id),
        tool: approvalToolName(method),
        input: params ?? msg.params ?? null,
        summary: approvalSummary(method, params),
      };
      yield { kind: 'permission-request', request };
      const decision = hooks.onPermission
        ? await hooks.onPermission(request)
        : { allow: true as const };
      this.rpc.respond(id, approvalResponse(method, decision.allow));
      return;
    }

    this.rpc.respondError(id, -32601, `one-agent cannot handle Codex request "${method}" yet`);
  }
}

export function codexThreadStartParamsForTest(
  descriptor: AgentDescriptor,
  opts: SessionOpts,
): JsonObject {
  return codexThreadStartParams(descriptor, opts);
}

export function codexTurnStartParamsForTest(
  descriptor: AgentDescriptor,
  opts: SessionOpts,
  threadId: string,
  prompt: string,
): JsonObject {
  return codexTurnStartParams(descriptor, opts, threadId, prompt);
}

export function codexAppServerEventsForTest(
  msg: JsonRpcMessage,
  threadId?: string,
  activeTurnId?: string,
): AgentEvent[] {
  if (typeof msg.method !== 'string') return [];
  const params = asObject(msg.params);
  if (!params) return [];

  const msgThreadId = stringProp(params, 'threadId');
  if (threadId && msgThreadId && msgThreadId !== threadId) return [];
  const msgTurnId = stringProp(params, 'turnId');
  if (activeTurnId && msgTurnId && msgTurnId !== activeTurnId) return [];

  switch (msg.method) {
    case 'turn/started': {
      const turn = asObject(params.turn);
      return turn ? [{ kind: 'tool-result', name: 'codex.turn', id: stringProp(turn, 'id'), output: 'started' }] : [];
    }
    case 'item/agentMessage/delta':
      return stringProp(params, 'delta') ? [{ kind: 'assistant', text: stringProp(params, 'delta')! }] : [];
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
    case 'item/plan/delta':
      return stringProp(params, 'delta') ? [{ kind: 'thinking', text: stringProp(params, 'delta')! }] : [];
    case 'item/started':
      return itemStartedEvents(params);
    case 'item/completed':
      return itemCompletedEvents(params);
    case 'turn/completed': {
      const events: AgentEvent[] = [];
      const turn = asObject(params.turn);
      const error = asObject(turn?.error);
      const message = stringProp(error, 'message') ?? stringProp(error, 'detail');
      if (message) events.push({ kind: 'error', message, fatal: true });
      events.push({ kind: 'done' });
      return events;
    }
    case 'thread/tokenUsage/updated':
      return usageEvents(params);
    case 'error':
    case 'warning':
    case 'guardianWarning':
    case 'configWarning': {
      const message =
        stringProp(params, 'message') ?? stringProp(params, 'reason') ?? JSON.stringify(params);
      return [{ kind: 'error', message, fatal: msg.method === 'error' }];
    }
    default:
      return [];
  }
}

function codexThreadStartParams(descriptor: AgentDescriptor, opts: SessionOpts): JsonObject {
  const mode = opts.permissionMode ?? descriptor.permissionMode ?? 'acceptEdits';
  const params: JsonObject = {
    cwd: opts.cwd,
    runtimeWorkspaceRoots: [opts.cwd],
    approvalPolicy: approvalPolicyFor(mode),
    approvalsReviewer: 'user',
    sandbox: sandboxModeFor(mode),
    baseInstructions: opts.systemConvention ?? null,
    serviceName: 'one-agent',
    threadSource: 'codex_app_server',
    config: configForMcp(opts.mcpServers),
  };
  if (descriptor.model) params.model = descriptor.model;
  return params;
}

function codexTurnStartParams(
  descriptor: AgentDescriptor,
  opts: SessionOpts,
  threadId: string,
  prompt: string,
): JsonObject {
  const mode = opts.permissionMode ?? descriptor.permissionMode ?? 'acceptEdits';
  const params: JsonObject = {
    threadId,
    input: [{ type: 'text', text: prompt, text_elements: [] }],
    cwd: opts.cwd,
    runtimeWorkspaceRoots: [opts.cwd],
    approvalPolicy: approvalPolicyFor(mode),
    sandboxPolicy: sandboxPolicyFor(mode, opts.cwd),
  };
  if (descriptor.model) params.model = descriptor.model;
  return params;
}

function configForMcp(servers?: McpServerConfig[]): JsonObject | null {
  if (!servers?.length) return null;
  const mcpServers: JsonObject = {};
  for (const server of servers) {
    const entry: JsonObject = { command: server.command };
    if (server.args?.length) entry.args = server.args;
    if (server.env && Object.keys(server.env).length) entry.env = server.env;
    mcpServers[server.name] = entry;
  }
  return { mcp_servers: mcpServers };
}

function sandboxModeFor(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
    case 'ask':
      return 'read-only';
    case 'acceptEdits':
    case 'auto':
      return 'workspace-write';
    case 'bypass':
      return 'danger-full-access';
  }
}

function sandboxPolicyFor(mode: PermissionMode, cwd: string): JsonObject {
  switch (mode) {
    case 'plan':
    case 'ask':
      return { type: 'readOnly', networkAccess: false };
    case 'acceptEdits':
    case 'auto':
      return {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case 'bypass':
      return { type: 'dangerFullAccess' };
  }
}

function approvalPolicyFor(mode: PermissionMode): JsonValue {
  switch (mode) {
    case 'plan':
      return 'never';
    case 'ask':
      return 'on-request';
    case 'acceptEdits':
      return 'on-request';
    case 'auto':
      return 'on-failure';
    case 'bypass':
      return 'never';
  }
}

async function connectJsonRpc(url: string): Promise<RpcClient> {
  const WebSocket = websocketCtor();
  const ws = await openSocket(WebSocket, url);
  const pending = new Map<
    string,
    { resolve: (value: JsonValue) => void; reject: (reason: unknown) => void }
  >();
  const events = new AsyncQueue<JsonRpcMessage>();
  let seq = 0;

  ws.addEventListener('message', (event) => {
    const text = messageData(event);
    const msg = parseJsonRpc(text);
    if (!msg) return;
    const id = msg.id == null ? undefined : String(msg.id);
    if (id && !msg.method) {
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
      else waiter.resolve(msg.result ?? null);
      return;
    }
    events.push(msg);
  });
  ws.addEventListener('error', (event) => events.fail(new Error(`Codex app-server WebSocket error: ${String(event)}`)));
  ws.addEventListener('close', () => events.close());

  return {
    request(method: string, params?: JsonValue): Promise<JsonValue> {
      const id = String(++seq);
      const message = { jsonrpc: '2.0', id, method, params };
      ws.send(JSON.stringify(message));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    notify(method: string, params?: JsonValue): void {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    },
    respond(id: string | number, result: JsonValue): void {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    },
    respondError(id: string | number, code: number, message: string): void {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    },
    events,
    close(): void {
      ws.close();
      events.close();
      for (const waiter of pending.values()) waiter.reject(new Error('Codex app-server closed'));
      pending.clear();
    },
  };
}

function websocketCtor(): WebSocketCtor {
  const ctor = (globalThis as unknown as { WebSocket?: WebSocketCtor }).WebSocket;
  if (!ctor) {
    throw new Error('global WebSocket is unavailable in this Node/Electron runtime');
  }
  return ctor;
}

async function openSocket(WebSocket: WebSocketCtor, url: string): Promise<MinimalWebSocket> {
  const deadline = Date.now() + 20000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await new Promise<MinimalWebSocket>((resolve, reject) => {
        const ws = new WebSocket(url);
        let settled = false;
        const fail = (reason: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.close();
          reject(reason);
        };
        const timer = setTimeout(() => fail(new Error('connect timeout')), 1000);
        ws.addEventListener('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ws);
        });
        ws.addEventListener('error', fail);
      });
    } catch (err) {
      lastError = err;
      await delay(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('could not reserve a local port'));
      });
    });
    server.on('error', reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonRpc(text: string): JsonRpcMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return asObject(parsed) ?? undefined;
  } catch {
    return undefined;
  }
}

function messageData(event: unknown): string {
  const data = asObject(event)?.data;
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  return String(data ?? '');
}

function threadIdFromResponse(value: JsonValue): string | undefined {
  const root = asObject(value);
  const thread = asObject(root?.thread);
  return stringProp(thread, 'id') ?? stringProp(thread, 'sessionId');
}

function turnIdFromResponse(value: JsonValue): string | undefined {
  const root = asObject(value);
  const turn = asObject(root?.turn);
  return stringProp(turn, 'id') ?? stringProp(root, 'turnId');
}

function itemStartedEvents(params: JsonObject): AgentEvent[] {
  const item = asObject(params.item);
  if (!item) return [];
  const type = stringProp(item, 'type');
  const id = stringProp(item, 'id');
  if (type === 'commandExecution') {
    return [{ kind: 'tool-call', id, name: 'shell', input: stringProp(item, 'command') ?? item }];
  }
  if (type === 'mcpToolCall') {
    return [
      {
        kind: 'tool-call',
        id,
        name: `${stringProp(item, 'server') ?? 'mcp'}.${stringProp(item, 'tool') ?? 'tool'}`,
        input: item.arguments ?? item,
      },
    ];
  }
  if (type === 'dynamicToolCall') {
    return [
      {
        kind: 'tool-call',
        id,
        name: `${stringProp(item, 'namespace') ?? 'tool'}.${stringProp(item, 'tool') ?? 'call'}`,
        input: item.arguments ?? item,
      },
    ];
  }
  return [];
}

function itemCompletedEvents(params: JsonObject): AgentEvent[] {
  const item = asObject(params.item);
  if (!item) return [];
  const type = stringProp(item, 'type');
  const id = stringProp(item, 'id');
  if (type === 'commandExecution') {
    return [
      {
        kind: 'tool-result',
        id,
        name: 'shell',
        output: stringProp(item, 'aggregatedOutput') ?? item.exitCode ?? null,
      },
    ];
  }
  if (type === 'mcpToolCall') {
    return [
      {
        kind: 'tool-result',
        id,
        name: `${stringProp(item, 'server') ?? 'mcp'}.${stringProp(item, 'tool') ?? 'tool'}`,
        output: item.result ?? item.error ?? null,
      },
    ];
  }
  if (type === 'dynamicToolCall') {
    return [
      {
        kind: 'tool-result',
        id,
        name: `${stringProp(item, 'namespace') ?? 'tool'}.${stringProp(item, 'tool') ?? 'call'}`,
        output: item.contentItems ?? item.success ?? null,
      },
    ];
  }
  return [];
}

function usageEvents(params: JsonObject): AgentEvent[] {
  const usage = asObject(params.usage) ?? asObject(params.tokenUsage) ?? params;
  const inputTokens = numberProp(usage, 'inputTokens') ?? numberProp(usage, 'input_tokens');
  const outputTokens = numberProp(usage, 'outputTokens') ?? numberProp(usage, 'output_tokens');
  if (inputTokens == null && outputTokens == null) return [];
  return [{ kind: 'usage', inputTokens, outputTokens }];
}

function approvalToolName(method: string): string {
  if (method.includes('commandExecution') || method === 'execCommandApproval') return 'shell';
  if (method.includes('fileChange') || method === 'applyPatchApproval') return 'file-change';
  return 'permission';
}

function approvalSummary(method: string, params: JsonObject | undefined): string {
  const command = stringProp(params, 'command');
  if (command) return command;
  const reason = stringProp(params, 'reason');
  if (reason) return reason;
  return `Codex requests approval for ${method}`;
}

function approvalResponse(method: string, allow: boolean): JsonObject {
  if (method.includes('commandExecution') || method.includes('fileChange')) {
    return { decision: allow ? 'accept' : 'decline' };
  }
  if (method === 'execCommandApproval') {
    return { decision: allow ? 'approved' : 'denied' };
  }
  if (method === 'applyPatchApproval') {
    return { decision: allow ? 'approved' : 'denied' };
  }
  return { approved: allow };
}

function isServerRequest(msg: JsonRpcMessage): boolean {
  return msg.id != null && typeof msg.method === 'string';
}

function asObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function stringProp(obj: JsonObject | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberProp(obj: JsonObject | undefined, key: string): number | undefined {
  const value = obj?.[key];
  return typeof value === 'number' ? value : undefined;
}

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T | undefined) => void> = [];
  private error: Error | undefined;
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  async shift(): Promise<T | undefined> {
    if (this.error) throw this.error;
    const value = this.values.shift();
    if (value) return value;
    if (this.ended) return undefined;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }

  fail(error: Error): void {
    this.error = error;
    this.close();
  }
}
