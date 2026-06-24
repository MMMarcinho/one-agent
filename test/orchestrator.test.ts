import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/core/orchestrator.js';
import { AgentRegistry } from '../src/core/registry.js';
import { SessionStore } from '../src/core/session-store.js';
import { builtinSpec } from '../src/core/spec.js';
import type { AgentAdapter, AgentSession, DetectResult } from '../src/core/adapter.js';
import type { AgentEvent, RunHooks } from '../src/core/types.js';

/** A fake adapter whose session emits a scripted, deterministic event stream. */
class FakeAdapter implements AgentAdapter {
  constructor(public readonly type: string) {}
  async detect(): Promise<DetectResult> {
    return { available: true, resolvedPath: `/fake/${this.type}` };
  }
  async openSession(): Promise<AgentSession> {
    const type = this.type;
    return {
      sessionId: undefined,
      async *send(): AsyncIterable<AgentEvent> {
        yield { kind: 'session', sessionId: `sess-${type}-1` };
        yield { kind: 'assistant', text: `hello from ${type}` };
        yield { kind: 'done', result: 'ok' };
      },
      interrupt() {},
      async close() {},
    };
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

/** An adapter whose session blocks until the turn is aborted. */
class SlowAdapter implements AgentAdapter {
  readonly type = 'claude-code';
  async detect(): Promise<DetectResult> {
    return { available: true };
  }
  async openSession(): Promise<AgentSession> {
    return {
      sessionId: 'slow-1',
      async *send(_input: unknown, hooks: RunHooks): AsyncIterable<AgentEvent> {
        yield { kind: 'session', sessionId: 'slow-1' };
        yield { kind: 'assistant', text: 'working…' };
        await new Promise<void>((res) => {
          if (hooks.signal?.aborted) return res();
          hooks.signal?.addEventListener('abort', () => res(), { once: true });
        });
        yield { kind: 'done' };
      },
      interrupt() {},
      async close() {},
    };
  }
}

test('Ctrl-C / abort cancels a run and records it as cancelled', async () => {
  const spec = builtinSpec();
  const registry = new AgentRegistry().register(new SlowAdapter());
  const store = new SessionStore(await mkdtemp(join(tmpdir(), 'oa-')));
  const orch = new Orchestrator(spec, registry, { store });

  const req = await store.createRequest({ prompt: 'long task', cwd: '/repo' });
  const controller = new AbortController();
  const seen: AgentEvent[] = [];
  for await (const e of orch.run(
    { agentId: 'claude-code', cwd: '/repo', prompt: 'long task', requestId: req.id },
    { signal: controller.signal },
  )) {
    seen.push(e);
    if (e.kind === 'assistant') controller.abort(); // simulate Ctrl-C mid-run
  }

  assert.ok(seen.some((e) => e.kind === 'done'));
  const runs = await store.runsFor(req.id);
  assert.equal(runs[0].status, 'cancelled');
});

test('RuleRouter: explicit rule wins when its target is available', async () => {
  const { RuleRouter } = await import('../src/core/router.js');
  const spec = builtinSpec();
  spec.routing = { auto: true, rules: [{ when: '/\\btest\\b/i', use: 'codex' }] };
  const router = new RuleRouter();
  const d = router.choose({
    spec,
    prompt: 'please add a unit test',
    cwd: '/repo',
    available: ['claude-code', 'codex'],
  });
  assert.equal(d.agentId, 'codex');
  assert.match(d.reason, /rule/);
});

test('RuleRouter: skips a rule whose target is unavailable, falls to default', async () => {
  const { RuleRouter } = await import('../src/core/router.js');
  const spec = builtinSpec();
  spec.routing = { auto: true, rules: [{ when: 'test', use: 'codex' }] };
  const d = new RuleRouter().choose({
    spec,
    prompt: 'add a test',
    cwd: '/repo',
    available: ['claude-code'], // codex not installed
  });
  assert.equal(d.agentId, 'claude-code');
  assert.equal(d.reason, 'default agent');
});

test('orchestrator.resolveAgent respects an explicit choice without routing', async () => {
  const { spec, registry } = fixture();
  const orch = new Orchestrator(spec, registry, {});
  const d = await orch.resolveAgent({ agentId: 'codex', prompt: 'x', cwd: '/x' });
  assert.equal(d.agentId, 'codex');
  assert.equal(d.reason, 'selected by you');
});

test('orchestrator.resolveAgent auto-routes among available agents', async () => {
  const { spec, registry } = fixture();
  spec.routing = { auto: true, rules: [{ when: 'test', use: 'codex' }] };
  const orch = new Orchestrator(spec, registry, {});
  const d = await orch.resolveAgent({ agentId: 'auto', prompt: 'write a test', cwd: '/x' });
  assert.equal(d.agentId, 'codex');
});

test('Conversation records each turn as a run under one request', async () => {
  const { spec, registry } = fixture();
  const store = new SessionStore(await mkdtemp(join(tmpdir(), 'oa-')));
  const orch = new Orchestrator(spec, registry, { store });

  const req = await store.createRequest({ prompt: 'turn one', cwd: '/repo' });
  const convo = await orch.openConversation({
    agentId: 'claude-code',
    cwd: '/repo',
    requestId: req.id,
  });
  for await (const _ of convo.send('turn one')) void _;
  for await (const _ of convo.send('turn two')) void _;
  await convo.close();

  const runs = await store.runsFor(req.id);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].prompt, 'turn one');
  assert.equal(runs[1].prompt, 'turn two');
  assert.ok(runs.every((r) => r.status === 'done'));
});

test('buildConvention surfaces the delegation roster plus user conventions', async () => {
  const { registry } = fixture();
  void registry;
  const { buildConvention } = await import('../src/core/conventions.js');
  const spec = builtinSpec();
  const descriptor = {
    id: 'claude-code',
    type: 'claude-code' as const,
    command: 'claude',
    canDelegateTo: ['codex'],
  };
  const text = buildConvention(spec, descriptor, 'Delegate tests to codex.');
  assert.ok(text && text.includes('spawn_agent'));
  assert.ok(text!.includes('`codex`'));
  assert.ok(text!.includes('Delegate tests to codex.'));

  // No targets => no orchestration header; only user text if present.
  const none = buildConvention(spec, { ...descriptor, canDelegateTo: [] }, undefined);
  assert.equal(none, undefined);
});
