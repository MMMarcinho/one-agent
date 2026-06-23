import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Bootstrapped } from './bootstrap.js';
import { executeRequest } from './run.js';
import { ui } from './render.js';

/**
 * The interactive flow: pick a directory (already resolved), confirm the active
 * agent, then loop — each line the user enters is a new request driven to
 * completion. Mirrors the "select a directory, start coding" experience.
 */
export async function interactiveSession(
  boot: Bootstrapped,
  opts: { cwd: string; agentId?: string },
): Promise<void> {
  const detected = await boot.registry.detectAll(boot.spec);
  const available = [...detected.entries()].filter(([, d]) => d.available).map(([id]) => id);

  stdout.write(ui.banner() + '\n');
  stdout.write(ui.dim(`directory: ${opts.cwd}\n`));
  if (boot.conventionsPath) {
    stdout.write(ui.dim(`conventions: ${boot.conventionsPath}\n`));
  }
  if (boot.usingBuiltin) {
    stdout.write(ui.warn('no one-agent.yaml found — using built-in defaults. ') + ui.dim('Run `one-agent init` to customize.\n'));
  }

  if (available.length === 0) {
    stdout.write(ui.err('No agents are available on this machine.\n'));
    for (const [id, d] of detected) {
      stdout.write(ui.dim(`  · ${id}: ${d.reason ?? 'unavailable'}\n`));
    }
    return;
  }

  const active =
    opts.agentId && available.includes(opts.agentId)
      ? opts.agentId
      : available.includes(boot.spec.defaultAgent)
        ? boot.spec.defaultAgent
        : available[0];

  stdout.write(
    ui.dim(`available: ${available.join(', ')}  ·  active: `) + ui.label(active) + '\n',
  );
  stdout.write(
    ui.dim(
      'commands: /agent <id> switch · /agents list · /quit exit\n' +
        'Ctrl-C interrupts the running request (it does not exit). anything else = a request\n\n',
    ),
  );

  const rl = createInterface({ input: stdin, output: stdout });
  let current = active;

  // Ctrl-C cancels the in-flight request without tearing down the session.
  let activeRun: AbortController | null = null;
  rl.on('SIGINT', () => {
    if (activeRun) {
      activeRun.abort();
      stdout.write(ui.warn('\n⊘ interrupting current request…\n'));
    } else {
      stdout.write(ui.dim('\n(type /quit to exit)\n'));
    }
  });

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const line = (await rl.question(ui.label(`one-agent(${current})› `))).trim();
      if (!line) continue;
      if (line === '/quit' || line === '/exit') break;
      if (line === '/agents') {
        stdout.write(ui.dim(`available: ${available.join(', ')}\n`));
        continue;
      }
      if (line.startsWith('/agent ')) {
        const next = line.slice(7).trim();
        if (available.includes(next)) {
          current = next;
          stdout.write(ui.ok(`switched to ${next}\n`));
        } else {
          stdout.write(ui.err(`"${next}" is not available (${available.join(', ')})\n`));
        }
        continue;
      }
      activeRun = new AbortController();
      try {
        await executeRequest(boot.orchestrator, boot.store, {
          prompt: line,
          cwd: opts.cwd,
          agentId: current,
          signal: activeRun.signal,
        });
      } finally {
        activeRun = null;
      }
    }
  } finally {
    rl.close();
  }
}
