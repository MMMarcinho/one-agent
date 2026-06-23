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
 * Drives Claude Code in headless streaming mode:
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *
 * We write the prompt as a stream-json user message on stdin and translate the
 * stdout event stream into one-agent's normalized AgentEvent stream.
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

  async *run(
    descriptor: AgentDescriptor,
    request: RunRequest,
    _hooks: RunHooks,
  ): AsyncIterable<AgentEvent> {
    const args = buildArgs(descriptor, request);
    const child = spawn(descriptor.command, args, {
      cwd: request.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...descriptor.env },
    });

    // Send the prompt as a single stream-json user message, then close stdin
    // to signal end of input for this turn.
    const userMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: request.prompt }] },
    };
    child.stdin.write(JSON.stringify(userMessage) + '\n');
    child.stdin.end();

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));

    try {
      for await (const line of readLines(child.stdout)) {
        const event = parseLine(line);
        if (event) yield event;
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
  }
}

function buildArgs(descriptor: AgentDescriptor, request: RunRequest): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (descriptor.model) args.push('--model', descriptor.model);

  const mode = request.permissionMode ?? descriptor.permissionMode ?? 'acceptEdits';
  applyPermissionMode(args, mode);

  if (request.resumeSessionId) args.push('--resume', request.resumeSessionId);

  if (request.systemConvention) {
    args.push('--append-system-prompt', request.systemConvention);
  }

  const mcp = mcpConfig(request.mcpServers);
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
      // Default permission behaviour; interactive prompting in headless mode is
      // handled via MCP permission tools (future work).
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
      return resultEvent(msg);
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

function resultEvent(msg: Record<string, unknown>): AgentEvent {
  const usage = msg.usage as Record<string, number> | undefined;
  if (usage || typeof msg.total_cost_usd === 'number') {
    // Emit usage as a side note via the done event's result text is lossy, so
    // callers that care about tokens read the usage event separately.
  }
  return {
    kind: 'done',
    result: typeof msg.result === 'string' ? msg.result : undefined,
  };
}
