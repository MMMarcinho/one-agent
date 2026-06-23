import type { Orchestrator } from '../core/orchestrator.js';
import type { SessionStore } from '../core/session-store.js';
import type { PermissionMode } from '../core/types.js';
import { renderEvent, ui } from './render.js';

/**
 * Execute one user request (需求): create the request record, route to an
 * agent, stream the run to the terminal, then surface the per-agent session
 * breakdown the request produced.
 */
export async function executeRequest(
  orchestrator: Orchestrator,
  store: SessionStore,
  opts: { prompt: string; cwd: string; agentId?: string; mode?: PermissionMode },
): Promise<void> {
  const agentId = orchestrator.route({
    agentId: opts.agentId,
    prompt: opts.prompt,
    cwd: opts.cwd,
  });
  const request = await store.createRequest({ prompt: opts.prompt, cwd: opts.cwd });

  process.stdout.write(
    ui.dim(`\n▸ request ${request.id.slice(0, 8)} · ${agentId} · ${opts.cwd}\n`),
  );

  let fatal = false;
  for await (const event of orchestrator.run(
    {
      agentId,
      cwd: opts.cwd,
      prompt: opts.prompt,
      permissionMode: opts.mode,
      requestId: request.id,
    },
    {},
  )) {
    if (!renderEvent(event, agentId)) fatal = true;
  }

  await printSessionBreakdown(store, request.id, !fatal);
}

/** Show every backend session a request spawned, across agents and delegation. */
export async function printSessionBreakdown(
  store: SessionStore,
  requestId: string,
  ok = true,
): Promise<void> {
  const runs = await store.runsFor(requestId);
  if (runs.length === 0) return;
  process.stdout.write(ui.dim('\n  sessions for this request:\n'));
  for (const run of runs) {
    const indent = '  '.repeat(run.depth + 1);
    const via = run.depth === 0 ? 'user' : `via ${run.parent}`;
    const sid = run.sessionId ? run.sessionId.slice(0, 8) : '—';
    const mark =
      run.status === 'done' ? ui.ok('✓') : run.status === 'error' ? ui.err('✗') : '·';
    process.stdout.write(
      `${indent}${mark} ${ui.label(run.agentId)} ${ui.dim(`[${via}]`)} ${ui.dim('session ' + sid)}\n`,
    );
  }
  process.stdout.write(ok ? '' : ui.warn('  (request ended with errors)\n'));
}
