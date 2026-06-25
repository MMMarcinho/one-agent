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
| **Codex** | Primary: `codex app-server` over localhost WebSocket JSON-RPC (`thread/start` + `turn/start`) for Codex-style persistent threads. Fallback: `codex exec --json --sandbox <mode> --skip-git-repo-check`. |
| **Any ACP agent** | JSON-RPC 2.0 over stdio (`initialize` → `session/new` → `session/prompt`), translating `session/update` notifications. The long-tail, future-proof path. |

Adding a backend means writing one adapter; nothing else changes.

## Architecture

The core is **interface-agnostic** — both the macOS desktop app and the CLI are
thin frontends over the exact same core (`src/app.ts` bootstrap).

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
**MCP server** into that agent. The agent then has:

- `list_agents` to inspect allowed targets and their roles.
- `spawn_agent` for a synchronous self-contained sub-task.
- `start_session`, `send_session_message`, and `close_session` for a persistent
  delegated conversation with another agent.
- `list_sessions` and `read_session` to inspect recorded progress, summaries,
  prompts, and event content from the current request.

Every delegated call is re-checked against the spec (allowed target? within
`maxDepth`?) before a sub-agent is launched. This is how "an agent decides to
launch another agent" stays governed by your rules.

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
npm install              # also fetches the Electron binary
npm run desktop:dev      # Vite dev server + Electron, with hot reload
```

Other commands:

```bash
npm run desktop:start    # production-style run (no dev server)
npm run dist:mac         # package a .dmg (macOS only)
```

### Using the app

1. **Pick a directory.** Use the **Open** button in the sidebar's Projects area and
   choose your project folder. one-agent loads any `one-agent.yaml` and
   `ONE_AGENT.md` found there (or falls back to built-in defaults).
2. **Choose an agent — or don't.** The composer has a compact Agent picker with
   every configured agent plus **Auto**. Leave it on **Auto** to let one-agent
   route each request to the best available agent; or choose a specific agent to
   pin it.
3. **Describe a task — and keep the conversation going.** Type in the composer
   and press **Enter** (Shift+Enter for a newline). Output streams into the
   transcript with a badge showing which agent ran (and, when auto-routed, why).
   Follow-up messages continue the **same live agent session** (Claude Code
   keeps one process alive across turns), so context carries over. Switching the
   agent or directory starts a fresh conversation; the header shows **· live**
   while one is open.
4. **Interrupt anytime.** While a request runs, the Send button becomes **Stop**
   — click it to cancel the current request without closing the app.
5. **Review past work.** Each task you run is a **request (需求)** in the
   sidebar's *Sessions* list, grouped by agent and marked with status/run count.
   A multi-agent request appears under each agent that ran part of it, with that
   agent's own run count. Click one to see every backend session it spawned
   across agents — including sub-agents one agent delegated to, indented under
   the agent that delegated them.

> Verified locally with `npm run desktop:dev`: Vite serves the renderer and
> Electron opens the desktop shell. Chromium may print harmless DevTools
> Autofill warnings during development.

## Driving Claude Code

The Claude Code adapter follows the same headless protocol the community tool
[cc-connect](https://github.com/chenhg5/cc-connect) uses, and matches it on the
essentials:

```
claude -p --input-format stream-json --output-format stream-json --verbose
       [--model …] [--permission-mode plan|acceptEdits] [--dangerously-skip-permissions]
       [--resume <sessionId>] [--append-system-prompt <conventions>]
       [--mcp-config <delegation server> --strict-mcp-config]
```

The user prompt is written to stdin as a stream-json `user` message and the
stdout event stream is normalized into one-agent's events. Session ids are
captured for the session store; delegation is injected via `--mcp-config`.

Like cc-connect, the adapter keeps the process alive with stdin open and runs
**multiple turns over one session** (each turn ends on the `result` message), so
the desktop chat has real conversation continuity. The remaining cc-connect
refinement not yet adopted is `--permission-prompt-tool stdio` for **interactive
permission approval** in the UI (tracked on the roadmap).

## Driving Codex

The Codex adapter prefers `codex app-server` for the desktop app's long-lived
project/session model. It starts a local WebSocket JSON-RPC server, initializes
the experimental API, opens a Codex thread with `thread/start`, and sends turns
with `turn/start`. Codex app-server notifications are normalized into the same
assistant/thinking/tool/error/done event stream as other backends.

If app-server is unavailable, one-agent falls back to
`codex exec --json --sandbox <mode> --skip-git-repo-check`, which fixes local
folder trust failures while preserving a working Codex path for older CLIs.

## CLI (optional)

The same core is also usable from a terminal:

```bash
npm run build
node dist/cli/index.js              # interactive: pick dir, start a request
node dist/cli/index.js run "…" -a codex
node dist/cli/index.js requests     # review past requests
node dist/cli/index.js show <id>    # what one request spawned
```

## Roadmap

- [x] Auto-routing from spec rules (deterministic RuleRouter)
- [x] Desktop app frontend (macOS, Electron) reusing the core
- [x] Persistent multi-turn Claude Code / ACP sessions (chat continuity)
- [x] True persistent Codex sessions via `codex app-server`
- [ ] Interactive permission approval (`--permission-prompt-tool stdio` / MCP)
- [ ] Model-assisted routing (pluggable Router)
- [ ] ACP client `fs/*` methods and full permission flow
- [x] Codex app-server adapter with `thread/start`, `turn/start`, and `turn/interrupt`
- [ ] Codex app-server steering/resume/read APIs (`turn/steer`, `thread/read`, `thread/turns/list`)
- [x] Live transcript persistence per run (not just summaries)

## Acknowledgements

Invocation approaches informed by [cc-connect](https://github.com/chenhg5/cc-connect),
which bridges many local agents (native adapters + generic ACP).
