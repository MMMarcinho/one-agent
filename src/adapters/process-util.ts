import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/** Resolve a binary on PATH without throwing. Returns its path or undefined. */
export async function which(command: string): Promise<string | undefined> {
  if (!command) return undefined;
  // Absolute/relative paths are returned as-is if they look like a path.
  const isPath = command.includes('/') || command.includes('\\');
  const probe = isPath ? command : await whichViaShell(command);
  return probe;
}

function whichViaShell(command: string): Promise<string | undefined> {
  return new Promise((resolveP) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(finder, [command], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolveP(undefined));
    child.on('close', (code) => {
      if (code === 0 && out.trim()) resolveP(out.trim().split(/\r?\n/)[0]);
      else resolveP(undefined);
    });
  });
}

/** Run a command to completion and capture stdout. Best-effort, never throws. */
export function captureOutput(
  command: string,
  args: string[],
  timeoutMs = 4000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolveP({ ok: false, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ ok: code === 0, stdout, stderr });
    });
  });
}

/** Async iterator over newline-delimited lines from a stream. */
export async function* readLines(stream: Readable): AsyncGenerator<string> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length > 0) yield line;
  }
}
