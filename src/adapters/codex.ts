import { spawn, type ChildProcess } from 'node:child_process';
import type {
  AgentAdapter,
  AgentSession,
  DetectResult,
  SessionOpts,
  TurnInput,
} from '../core/adapter.js';
import type { AgentDescriptor, AgentEvent, McpServerConfig, PermissionMode, RunHooks } from '../core/types.js';
import { captureOutput, killOnAbort, readLines, which } from './process-util.js';

/**
 * Drives the Codex CLI. Codex `exec` is one-shot, so this is a pseudo-session:
 * each turn spawns `codex exec --json` afresh. The uniform AgentSession shape
 * keeps the orchestrator simple; true persistent multi-turn continuity would
 * use `codex proto` / the app server (tracked on the roadmap).
 */
export class CodexAdapter implements AgentAdapter {
  readonly type = 'codex';

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
    return new CodexSession(descriptor, opts);
  }
}

class CodexSession implements AgentSession {
  sessionId: string | undefined;
  private active?: ChildProcess;

  constructor(
    private readonly descriptor: AgentDescriptor,
    private readonly opts: SessionOpts,
  ) {}

  async *send(input: TurnInput, hooks: RunHooks): AsyncIterable<AgentEvent> {
    const args = buildArgs(this.descriptor, this.opts, input);
    const child = spawn(this.descriptor.command, args, {
      cwd: this.opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...this.descriptor.env },
    });
    this.active = child;
    killOnAbort(hooks.signal, child);

    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    let sawDone = false;
    try {
      for await (const line of readLines(child.stdout!)) {
        const event = parseLine(line);
        if (!event) continue;
        if (event.kind === 'session') this.sessionId = event.sessionId;
        if (event.kind === 'done') sawDone = true;
        yield event;
      }
    } finally {
      child.kill();
      this.active = undefined;
    }

    const code: number = await new Promise((res) => {
      if (child.exitCode != null) return res(child.exitCode);
      child.on('close', (c) => res(c ?? 0));
    });
    if (code !== 0 && stderr.trim()) {
      yield { kind: 'error', message: stderr.trim(), fatal: true };
    }
    if (!sawDone) yield { kind: 'done' };
  }

  interrupt(): void {
    this.active?.kill('SIGTERM');
  }

  async close(): Promise<void> {
    this.active?.kill('SIGTERM');
  }
}

function buildArgs(descriptor: AgentDescriptor, opts: SessionOpts, input: TurnInput): string[] {
  const args = ['exec', '--json'];
  if (descriptor.model) args.push('-m', descriptor.model);

  const mode = opts.permissionMode ?? descriptor.permissionMode ?? 'acceptEdits';
  args.push('--sandbox', sandboxFor(mode));

  for (const override of mcpOverrides(opts.mcpServers)) {
    args.push('-c', override);
  }

  if (descriptor.args) args.push(...descriptor.args);
  args.push(withConvention(input.prompt, opts.systemConvention));
  return args;
}

function withConvention(prompt: string, convention?: string): string {
  if (!convention) return prompt;
  return `<orchestration-context>\n${convention}\n</orchestration-context>\n\n${prompt}`;
}

function sandboxFor(mode: PermissionMode): string {
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

function mcpOverrides(servers?: McpServerConfig[]): string[] {
  if (!servers || servers.length === 0) return [];
  const out: string[] = [];
  for (const s of servers) {
    const key = `mcp_servers.${s.name}`;
    out.push(`${key}.command=${JSON.stringify(s.command)}`);
    if (s.args && s.args.length) out.push(`${key}.args=${JSON.stringify(s.args)}`);
    for (const [k, v] of Object.entries(s.env ?? {})) {
      out.push(`${key}.env.${k}=${JSON.stringify(v)}`);
    }
  }
  return out;
}

function parseLine(line: string): AgentEvent | undefined {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof msg.type === 'string' && msg.item && typeof msg.item === 'object') {
    return fromItem(msg.item as Record<string, unknown>, msg.type);
  }

  const inner = (msg.msg ?? msg) as Record<string, unknown>;
  const innerType = inner.type;
  if (innerType === 'agent_message' || innerType === 'assistant_message') {
    const text = pickText(inner);
    if (text) return { kind: 'assistant', text };
  }
  if (innerType === 'agent_reasoning' || innerType === 'reasoning') {
    const text = pickText(inner);
    if (text) return { kind: 'thinking', text };
  }
  if (
    innerType === 'task_complete' ||
    innerType === 'turn_complete' ||
    msg.type === 'turn.completed'
  ) {
    return { kind: 'done', result: pickText(inner) };
  }
  return undefined;
}

function fromItem(item: Record<string, unknown>, envelopeType: string): AgentEvent | undefined {
  const itemType = item.type;
  const text = pickText(item);
  if (itemType === 'assistant_message' || itemType === 'agent_message') {
    return text ? { kind: 'assistant', text } : undefined;
  }
  if (itemType === 'reasoning') {
    return text ? { kind: 'thinking', text } : undefined;
  }
  if (envelopeType === 'turn.completed') {
    return { kind: 'done', result: text };
  }
  return undefined;
}

function pickText(obj: Record<string, unknown>): string | undefined {
  for (const key of ['message', 'text', 'content', 'result']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length) return v;
  }
  return undefined;
}
