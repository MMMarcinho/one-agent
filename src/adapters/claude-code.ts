import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentAdapter,
  AgentSession,
  DetectResult,
  SessionOpts,
  TurnInput,
} from '../core/adapter.js';
import type { AgentDescriptor, AgentEvent, McpServerConfig, PermissionMode, RunHooks } from '../core/types.js';
import { EventQueue } from './event-queue.js';
import { captureOutput, readLines, which } from './process-util.js';

/**
 * Drives Claude Code as a persistent, multi-turn session:
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *
 * The process stays alive with stdin open; each turn writes a stream-json user
 * message and reads events until the `result` message ends that turn. The same
 * backend session_id persists across turns, giving real conversation continuity.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly type = 'claude-code';

  async detect(descriptor: AgentDescriptor): Promise<DetectResult> {
    const resolved = await which(descriptor.command);
    if (!resolved) {
      return { available: false, reason: `"${descriptor.command}" not found on PATH` };
    }
    const { ok, stdout } = await captureOutput(descriptor.command, ['--version']);
    return {
      available: true,
      resolvedPath: resolved,
      version: ok ? stdout.trim().split(/\r?\n/)[0] : undefined,
    };
  }

  async openSession(descriptor: AgentDescriptor, opts: SessionOpts): Promise<AgentSession> {
    const args = buildArgs(descriptor, opts);
    const child = spawn(descriptor.command, args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...descriptor.env },
    });
    return new ClaudeCodeSession(child);
  }
}

class ClaudeCodeSession implements AgentSession {
  sessionId: string | undefined;
  private current: { queue: EventQueue } | null = null;
  private closed = false;
  private interruptTimer?: NodeJS.Timeout;
  private controlSeq = 0;
  private stderr = '';

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.child.stderr.on('data', (d) => (this.stderr += d.toString()));
    this.child.on('close', () => this.onProcessExit());
    void this.readLoop();
  }

  async *send(input: TurnInput, hooks: RunHooks): AsyncIterable<AgentEvent> {
    if (this.closed) {
      yield { kind: 'error', message: 'session is closed', fatal: true };
      yield { kind: 'done' };
      return;
    }
    const queue = new EventQueue();
    this.current = { queue };
    if (this.sessionId) queue.push({ kind: 'session', sessionId: this.sessionId });

    const onAbort = (): void => this.interrupt();
    if (hooks.signal) {
      if (hooks.signal.aborted) onAbort();
      else hooks.signal.addEventListener('abort', onAbort, { once: true });
    }

    const userMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: input.prompt }] },
    };
    this.child.stdin.write(JSON.stringify(userMessage) + '\n');

    try {
      yield* queue;
    } finally {
      hooks.signal?.removeEventListener('abort', onAbort);
      clearTimeout(this.interruptTimer);
      this.current = null;
    }
  }

  interrupt(): void {
    if (this.closed || !this.current) return;
    // Best-effort graceful interrupt; fall back to killing the process.
    const control = {
      type: 'control_request',
      request_id: `int_${++this.controlSeq}`,
      request: { subtype: 'interrupt' },
    };
    try {
      this.child.stdin.write(JSON.stringify(control) + '\n');
    } catch {
      /* ignore */
    }
    this.interruptTimer = setTimeout(() => this.child.kill('SIGTERM'), 2000);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    if (this.child.exitCode == null) {
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          this.child.kill('SIGTERM');
          res();
        }, 1500);
        this.child.on('close', () => {
          clearTimeout(t);
          res();
        });
      });
    }
  }

  private async readLoop(): Promise<void> {
    for await (const line of readLines(this.child.stdout)) {
      const event = parseLine(line);
      if (!event) continue;
      if (event.kind === 'session') {
        this.sessionId = event.sessionId;
        if (this.current) this.current.queue.push(event);
        continue;
      }
      if (!this.current) continue;
      this.current.queue.push(event);
      if (event.kind === 'done') {
        // Turn finished; keep the process alive for the next turn.
        this.current.queue.close();
      }
    }
  }

  private onProcessExit(): void {
    this.closed = true;
    if (this.current) {
      if (this.stderr.trim()) {
        this.current.queue.push({ kind: 'error', message: this.stderr.trim(), fatal: true });
      }
      this.current.queue.push({ kind: 'done' });
      this.current.queue.close();
    }
  }
}

function buildArgs(descriptor: AgentDescriptor, opts: SessionOpts): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (descriptor.model) args.push('--model', descriptor.model);

  const mode = opts.permissionMode ?? descriptor.permissionMode ?? 'acceptEdits';
  applyPermissionMode(args, mode);

  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts.systemConvention) args.push('--append-system-prompt', opts.systemConvention);

  const mcp = mcpConfig(opts.mcpServers);
  if (mcp) args.push('--mcp-config', mcp, '--strict-mcp-config');

  if (descriptor.args) args.push(...descriptor.args);
  return args;
}

function applyPermissionMode(args: string[], mode: PermissionMode): void {
  switch (mode) {
    case 'plan':
      args.push('--permission-mode', 'plan');
      break;
    case 'acceptEdits':
    case 'auto':
      args.push('--permission-mode', 'acceptEdits');
      break;
    case 'bypass':
      args.push('--dangerously-skip-permissions');
      break;
    case 'ask':
      break;
  }
}

function mcpConfig(servers?: McpServerConfig[]): string | undefined {
  if (!servers || servers.length === 0) return undefined;
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] = { command: s.command, args: s.args ?? [], env: s.env ?? {} };
  }
  return JSON.stringify({ mcpServers });
}

/** Translate one Claude Code stream-json line into a normalized event. */
function parseLine(line: string): AgentEvent | undefined {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined;
  }

  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
        return { kind: 'session', sessionId: msg.session_id };
      }
      return undefined;
    case 'assistant':
      return assistantEvent(msg);
    case 'result':
      return { kind: 'done', result: typeof msg.result === 'string' ? msg.result : undefined };
    default:
      return undefined;
  }
}

function assistantEvent(msg: Record<string, unknown>): AgentEvent | undefined {
  const message = msg.message as { content?: unknown } | undefined;
  const content = Array.isArray(message?.content) ? message!.content : [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') {
      return { kind: 'assistant', text: block.text };
    }
    if (block.type === 'tool_use' && typeof block.name === 'string') {
      return {
        kind: 'tool-call',
        name: block.name,
        input: block.input,
        id: typeof block.id === 'string' ? block.id : undefined,
      };
    }
  }
  return undefined;
}
