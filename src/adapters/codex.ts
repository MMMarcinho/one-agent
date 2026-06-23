import { spawn } from 'node:child_process';
import type { AgentAdapter, DetectResult } from '../core/adapter.js';
import type {
  AgentDescriptor,
  AgentEvent,
  McpServerConfig,
  PermissionMode,
  RunHooks,
  RunRequest,
} from '../core/types.js';
import { captureOutput, readLines, which } from './process-util.js';

/**
 * Drives the Codex CLI in headless mode:
 *   codex exec --json --sandbox <mode> "<prompt>"
 *
 * The exec JSON event shape has shifted across Codex versions, so the parser is
 * deliberately tolerant: it pulls assistant text out of the common shapes and
 * always closes the stream with a `done` event.
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

  async *run(
    descriptor: AgentDescriptor,
    request: RunRequest,
    _hooks: RunHooks,
  ): AsyncIterable<AgentEvent> {
    const args = buildArgs(descriptor, request);
    const child = spawn(descriptor.command, args, {
      cwd: request.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...descriptor.env },
    });

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));

    let sawDone = false;
    try {
      for await (const line of readLines(child.stdout)) {
        const event = parseLine(line);
        if (!event) continue;
        if (event.kind === 'done') sawDone = true;
        yield event;
      }
    } finally {
      child.kill();
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
}

function buildArgs(descriptor: AgentDescriptor, request: RunRequest): string[] {
  const args = ['exec', '--json'];
  if (descriptor.model) args.push('-m', descriptor.model);

  const mode = request.permissionMode ?? descriptor.permissionMode ?? 'acceptEdits';
  args.push('--sandbox', sandboxFor(mode));

  for (const override of mcpOverrides(request.mcpServers)) {
    args.push('-c', override);
  }

  if (descriptor.args) args.push(...descriptor.args);

  // Codex exec has no append-system-prompt flag, so fold the orchestration
  // conventions into a framed preamble ahead of the task. Prompt is positional.
  args.push(withConvention(request.prompt, request.systemConvention));
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

/** Inject MCP servers via `-c mcp_servers.<name>....` config overrides. */
function mcpOverrides(servers?: McpServerConfig[]): string[] {
  if (!servers || servers.length === 0) return [];
  const out: string[] = [];
  for (const s of servers) {
    const key = `mcp_servers.${s.name}`;
    out.push(`${key}.command=${JSON.stringify(s.command)}`);
    if (s.args && s.args.length) {
      out.push(`${key}.args=${JSON.stringify(s.args)}`);
    }
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

  // Newer shape: { type: "item.completed", item: { type, text/message } }
  if (typeof msg.type === 'string' && msg.item && typeof msg.item === 'object') {
    return fromItem(msg.item as Record<string, unknown>, msg.type);
  }

  // Older shape: { msg: { type, message/text } }
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
