# one-agent

**One entry, any agent.** Drive and orchestrate any local coding agent — Claude
Code, Codex, and anything that speaks the Agent Client Protocol (ACP) — from a
single entrypoint. Pick a directory, describe what you want, and let one-agent
route the work, manage sessions, and let agents delegate to each other under
rules *you* define.

> Status: early foundation (v0.1). The core, adapters, delegation, and session
> management are in place and runnable. See [Roadmap](#roadmap).

## Why

You may have several coding agents installed — Claude Code CLI, Codex CLI, and
more. Instead of choosing one each time, one-agent gives you a single flow
("select a directory, start coding") and decides — or lets the agents decide —
who does what, governed by a spec you write.

## How it calls agents

one-agent talks to each backend through a normalized `AgentAdapter`, using each
tool's documented headless interface:

| Backend | Mechanism |
| --- | --- |
| **Claude Code** | `claude -p --input-format stream-json --output-format stream-json` — prompt in / event stream out over stdio. |
| **Codex** | `codex exec --json --sandbox <mode>` — headless run, tolerant JSON event parsing. |
| **Any ACP agent** | JSON-RPC 2.0 over stdio (`initialize` → `session/new` → `session/prompt`), translating `session/update` notifications. The long-tail, future-proof path. |

Adding a backend means writing one adapter; nothing else changes.

## Architecture

The core is **interface-agnostic** — the CLI is a thin frontend, and a desktop
app can later reuse the exact same core.

```
src/
  core/          # interface-agnostic library (no CLI imports)
    types.ts         normalized events, runs, permission modes
    adapter.ts       the AgentAdapter contract
    registry.ts      adapters + per-agent detection
    spec.ts          the user-defined orchestration spec (YAML + zod)
    orchestrator.ts  routing, delegation policy, session recording
    session-store.ts persistent requests (需求) and their runs
  adapters/      # claude-code, codex, acp + process utils
  mcp/           # the delegation MCP server (agent-spawns-agent backbone)
  cli/           # commands, interactive session, rendering
```

## The spec — your orchestration rules

The spec is the heart of one-agent: you declare which agents exist, their roles,
who may delegate to whom, and how recursion is bounded. Generate one with
`one-agent init`:

```yaml
version: 1
defaultAgent: claude-code
agents:
  claude-code:
    type: claude-code
    permissionMode: acceptEdits
    role: General-purpose coding, repo-wide reasoning and refactors.
    canDelegateTo: [codex]
  codex:
    type: codex
    role: Fast focused edits and an independent second opinion.
    canDelegateTo: [claude-code]
routing:
  auto: false        # set true to auto-pick an agent from rules
  rules: []
delegation:
  enabled: true
  maxDepth: 2        # cap agent -> agent recursion
  audit: true
```

## Agents spawning agents

When an agent runs and the spec permits delegation, one-agent injects its own
**MCP server** into that agent. The agent then has `list_agents` and
`spawn_agent` tools. Every `spawn_agent` call is re-checked against the spec
(allowed target? within `maxDepth`?) before a sub-agent is launched. This is how
"an agent decides to launch another agent" stays governed by your rules.

### Telling agents *when* to delegate — `ONE_AGENT.md`

The spec grants the *capability*; a CLAUDE.md-style **`ONE_AGENT.md`** file
supplies the *convention*. Write, in plain language, when each agent should hand
off to which other agent. one-agent loads it and injects it into **every** agent
it launches (as an appended system prompt for Claude Code, and a framed preamble
for Codex / ACP agents), so the same convention reaches every backend regardless
of its own memory-file support. Each injected context also includes an
auto-generated roster of the agent's permitted delegation targets and their
roles. `one-agent init` scaffolds a starter `ONE_AGENT.md`.

## Auto-routing — "I don't want to pick"

Set `routing.auto: true` and use the `auto` agent (the default in the TUI when
2+ agents are available). Each request is then routed automatically among the
agents actually installed on your machine, and the choice is shown with a
reason:

```
▸ request 8f2a… · codex (auto · matched rule "/\b(test|spec)\b/i") · /repo
```

How a request is routed (deterministic `RuleRouter`):

1. **Spec rules** — the first `routing.rules` entry whose `when` matches the
   prompt + cwd and whose target is available. `when` is a substring, or a
   `/regex/flags` literal.
2. **Role heuristic** — a clear single best match between the prompt and the
   agents' `role` descriptions.
3. **Default agent**, else any available agent.

```yaml
routing:
  auto: true
  rules:
    - when: /\b(test|spec)\b/i   # send test work to codex
      use: codex
```

The `Router` interface leaves room for a model-assisted router later without
changing callers. You can still force an agent any time (`/agent codex`, or
`run -a codex`).

## Session management

A **request (需求)** is one top-level task. Driving it may start several backend
sessions across agents — including delegated ones. one-agent records each as a
**run** linked to the request, so you can browse past requests and see exactly
which agent ran which session and who delegated to whom.

```
one-agent requests          # list past 需求
one-agent show <id>         # full per-agent session breakdown for a request
```

Storage is a directory of small JSON files under `~/.one-agent` (override with
`ONE_AGENT_HOME`); each process writes only its own run files, so delegated
sub-agents in separate processes record into the same request safely.

## Desktop app (macOS)

A light, Codex-style desktop frontend — pick a directory and start coding from a
GUI. It reuses the **exact same core** as the CLI (auto-routing, delegation,
session store, cancel), via Electron whose Node main process imports the
orchestration core directly.

```
desktop/
  vite.config.ts            renderer build (React + Vite)
  renderer/                 the UI (sidebar · transcript · composer)
src/desktop/
  main/                     Electron main — IPC handlers reusing src/app.ts
  preload/                  typed window.oneAgent bridge (contextBridge)
  shared/ipc.ts             IPC contract, decoupled from core internals
```

Run it (on a Mac):

```bash
npm install
npm run desktop:dev      # Vite dev server + Electron with hot reload
# or a production-style run:
npm run desktop:start
# package a .dmg (macOS only):
npm run dist:mac
```

The window has a sidebar (directory picker, agent selector incl. **Auto**, and
recent requests), a streaming transcript, and a composer with **Send / Stop**
(Stop cancels the running request, mirroring the CLI's Ctrl-C).

> The build was developed headless; the TypeScript (main/preload), renderer
> typecheck, and Vite bundle all compile. Launching the GUI requires a Mac with
> the Electron binary installed (`npm install` fetches it outside CI sandboxes).

## Usage

```bash
npm install
npm run build

node dist/cli/index.js init          # write a starter one-agent.yaml
node dist/cli/index.js agents        # which agents are available locally
node dist/cli/index.js               # interactive: pick dir, start a request
node dist/cli/index.js run "fix the failing test" -a codex
node dist/cli/index.js requests      # review past requests
node dist/cli/index.js show <id>     # see what one request spawned
```

In a dev checkout, use `npm run dev -- <args>` (via `tsx`) instead of building.

## Roadmap

- [x] Auto-routing from spec rules (deterministic RuleRouter)
- [ ] Model-assisted routing (pluggable Router)
- [ ] Rich permission handling (interactive approval via MCP permission tools)
- [ ] ACP client `fs/*` methods and full permission flow
- [ ] Codex `app_server` backend (drive a running Codex app)
- [ ] Desktop app frontend reusing the core
- [ ] Live transcript persistence per run (not just summaries)

## Acknowledgements

Invocation approaches informed by [cc-connect](https://github.com/chenhg5/cc-connect),
which bridges many local agents (native adapters + generic ACP).
