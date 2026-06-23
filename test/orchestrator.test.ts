import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/core/orchestrator.js';
import { AgentRegistry } from '../src/core/registry.js';
import { SessionStore } from '../src/core/session-store.js';
import { builtinSpec } from '../src/core/spec.js';
import type { AgentAdapter, DetectResult } from '../src/core/adapter.js';
import type { AgentEvent } from '../src/core/types.js';

/** A fake adapter that emits a scripted, deterministic event stream. */
class FakeAdapter implements AgentAdapter {
  constructor(public readonly type: string) {}
  async detect(): Promise<DetectResult> {
    return { available: true, resolvedPath: `/fake/${this.type}` };
  }
  async *run(): AsyncIterable<AgentEvent> {
    yield { kind: 'session', sessionId: `sess-${this.type}-1` };
    yield { kind: 'assistant', text: `hello from ${this.type}` };
    yield { kind: 'done', result: 'ok' };
  }
}

function fixture() {
  const spec = builtinSpec();
  const registry = new AgentRegistry()
    .register(new FakeAdapter('claude-code'))
    .register(new FakeAdapter('codex'));
  return { spec, registry };
}

test('records a request and its run with the backend session id', async () => {
  const { spec, registry } = fixture();
  const store = new SessionStore(await mkdtemp(join(tmpdir(), 'oa-')));
  const orch = new Orchestrator(spec, registry, { store });

  const req = await store.createRequest({ prompt: 'do a thing', cwd: '/repo' });
  const events: AgentEvent[] = [];
  for await (const e of orch.run({ agentId: 'claude-code', cwd: '/repo', prompt: 'do a thing', requestId: req.id })) {
    events.push(e);
  }

  assert.ok(events.some((e) => e.kind === 'assistant'));
  const runs = await store.runsFor(req.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agentId, 'claude-code');
  assert.equal(runs[0].sessionId, 'sess-claude-code-1');
  assert.equal(runs[0].status, 'done');
  assert.equal(runs[0].depth, 0);
});

test('enforces delegation depth via spec.maxDepth', async () => {
  const { spec, registry } = fixture();
  spec.delegation.maxDepth = 1;
  const orch = new Orchestrator(spec, registry, {});

  const events: AgentEvent[] = [];
  for await (const e of orch.run({
    agentId: 'codex',
    cwd: '/repo',
    prompt: 'sub task',
    delegation: { depth: 2, parent: 'claude-code', rootRunId: 'r', requestId: 'q' },
  })) {
    events.push(e);
  }
  const err = events.find((e) => e.kind === 'error');
  assert.ok(err && err.kind === 'error' && /exceeds maxDepth/.test(err.message));
});

test('delegation policy follows the spec graph', async () => {
  const { spec, registry } = fixture();
  const orch = new Orchestrator(spec, registry, {});
  assert.equal(orch.canDelegate('claude-code', 'codex').ok, true);
  spec.agents['claude-code'].canDelegateTo = [];
  assert.equal(orch.canDelegate('claude-code', 'codex').ok, false);
});

test('routing falls back to the default agent', async () => {
  const { spec, registry } = fixture();
  const orch = new Orchestrator(spec, registry, {});
  assert.equal(orch.route({ prompt: 'anything', cwd: '/x' }), 'claude-code');
  assert.equal(orch.route({ agentId: 'codex', prompt: 'x', cwd: '/x' }), 'codex');
});
