#!/usr/bin/env node
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { bootstrap } from './bootstrap.js';
import { interactiveSession } from './session.js';
import { executeRequest, printSessionBreakdown } from './run.js';
import { ui } from './render.js';
import { EXAMPLE_SPEC } from './example-spec.js';
import { EXAMPLE_CONVENTIONS } from '../core/conventions.js';
import type { PermissionMode } from '../core/types.js';

const program = new Command();
program
  .name('one-agent')
  .description('One entry, any agent. Drive and orchestrate local coding agents.')
  .version('0.1.0');

program
  .command('start', { isDefault: true })
  .description('Start an interactive session in a directory.')
  .option('-C, --cwd <dir>', 'working directory', process.cwd())
  .option('-a, --agent <id>', 'agent to start with')
  .action(async (opts) => {
    const cwd = resolve(opts.cwd);
    const boot = await bootstrap(cwd);
    await interactiveSession(boot, { cwd, agentId: opts.agent });
  });

program
  .command('run [prompt...]')
  .description('Run a single request non-interactively.')
  .option('-C, --cwd <dir>', 'working directory', process.cwd())
  .option('-a, --agent <id>', 'agent to use (else routed by spec)')
  .option('-m, --mode <mode>', 'permission mode: plan|ask|acceptEdits|auto|bypass')
  .action(async (promptParts: string[], opts) => {
    const prompt = promptParts.join(' ').trim();
    if (!prompt) {
      ui.err && process.stderr.write(ui.err('error: a prompt is required\n'));
      process.exitCode = 1;
      return;
    }
    const cwd = resolve(opts.cwd);
    const boot = await bootstrap(cwd);
    await executeRequest(boot.orchestrator, boot.store, {
      prompt,
      cwd,
      agentId: opts.agent,
      mode: opts.mode as PermissionMode | undefined,
    });
  });

program
  .command('agents')
  .description('List configured agents and whether they are available locally.')
  .option('-C, --cwd <dir>', 'working directory', process.cwd())
  .action(async (opts) => {
    const boot = await bootstrap(resolve(opts.cwd));
    const detected = await boot.registry.detectAll(boot.spec);
    process.stdout.write(ui.banner() + '\n');
    for (const desc of boot.registry.describe(boot.spec)) {
      const d = detected.get(desc.id)!;
      const status = d.available ? ui.ok('● available') : ui.err('○ ' + (d.reason ?? 'unavailable'));
      const tags = [desc.type, desc.id === boot.spec.defaultAgent ? 'default' : '']
        .filter(Boolean)
        .join(', ');
      process.stdout.write(`  ${ui.label(desc.id)} ${ui.dim('(' + tags + ')')}  ${status}\n`);
      if (desc.role) process.stdout.write(ui.dim(`      ${desc.role}\n`));
      if (desc.canDelegateTo?.length) {
        process.stdout.write(ui.dim(`      delegates → ${desc.canDelegateTo.join(', ')}\n`));
      }
    }
  });

program
  .command('requests')
  .description('List past requests (需求).')
  .action(async () => {
    const boot = await bootstrap(process.cwd());
    const requests = await boot.store.listRequests();
    if (requests.length === 0) {
      process.stdout.write(ui.dim('no requests yet.\n'));
      return;
    }
    for (const r of requests) {
      const runs = await boot.store.runsFor(r.id);
      const agents = [...new Set(runs.map((x) => x.agentId))].join(', ') || '—';
      process.stdout.write(
        `${ui.label(r.id.slice(0, 8))} ${ui.dim(r.createdAt)} ${ui.dim('[' + agents + ']')}\n  ${r.title}\n`,
      );
    }
  });

program
  .command('show <requestId>')
  .description('Show a request and every agent session it spawned.')
  .action(async (requestId: string) => {
    const boot = await bootstrap(process.cwd());
    const all = await boot.store.listRequests();
    const match = all.find((r) => r.id === requestId || r.id.startsWith(requestId));
    if (!match) {
      process.stderr.write(ui.err(`no request matching "${requestId}"\n`));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(ui.banner() + '\n');
    process.stdout.write(`${ui.label(match.id)}\n  ${match.title}\n  ${ui.dim(match.cwd)}\n  ${ui.dim(match.createdAt)}\n`);
    await printSessionBreakdown(boot.store, match.id);
    const runs = await boot.store.runsFor(match.id);
    for (const run of runs) {
      if (run.resultSummary) {
        process.stdout.write(ui.dim(`\n  ${run.agentId}: ${run.resultSummary}\n`));
      }
    }
  });

program
  .command('init')
  .description('Write a starter one-agent.yaml spec and ONE_AGENT.md conventions file.')
  .option('-C, --cwd <dir>', 'directory to write into', process.cwd())
  .action(async (opts) => {
    await writeIfAbsent(resolve(opts.cwd, 'one-agent.yaml'), EXAMPLE_SPEC);
    await writeIfAbsent(resolve(opts.cwd, 'ONE_AGENT.md'), EXAMPLE_CONVENTIONS);
  });

async function writeIfAbsent(path: string, content: string): Promise<void> {
  if (existsSync(path)) {
    process.stdout.write(ui.warn(`skip (exists): ${path}\n`));
    return;
  }
  await writeFile(path, content);
  process.stdout.write(ui.ok(`wrote ${path}\n`));
}

program
  .command('mcp')
  .description('Run the one-agent delegation MCP server (used internally by spawned agents).')
  .action(async () => {
    const { startDelegationServer } = await import('../mcp/delegation-server.js');
    await startDelegationServer();
  });

program.parseAsync().catch((err) => {
  process.stderr.write(ui.err(`\nfatal: ${err?.message ?? err}\n`));
  process.exitCode = 1;
});
