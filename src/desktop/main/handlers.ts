import { BrowserWindow, dialog, ipcMain } from 'electron';
import { homedir } from 'node:os';
import { bootstrap, type Bootstrapped } from '../../app.js';
import { IPC, type AgentInfo, type InitResult, type StartRequestInput } from '../shared/ipc.js';

/** Per-directory bootstrap cache (spec + orchestrator + store). */
const boots = new Map<string, Promise<Bootstrapped>>();
/** In-flight requests, so the UI can cancel them. */
const activeRuns = new Map<string, AbortController>();

function bootFor(cwd: string): Promise<Bootstrapped> {
  let b = boots.get(cwd);
  if (!b) {
    b = bootstrap(cwd);
    boots.set(cwd, b);
  }
  return b;
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

async function agentInfos(boot: Bootstrapped): Promise<AgentInfo[]> {
  const detected = await boot.registry.detectAll(boot.spec);
  return boot.registry.describe(boot.spec).map((d) => {
    const det = detected.get(d.id);
    return {
      id: d.id,
      type: d.type,
      role: d.role,
      available: det?.available ?? false,
      reason: det?.reason,
      isDefault: d.id === boot.spec.defaultAgent,
      canDelegateTo: d.canDelegateTo,
    };
  });
}

export function registerIpc(): void {
  ipcMain.handle(IPC.init, async (_e, startDir?: string): Promise<InitResult> => {
    const cwd = startDir || homedir();
    const boot = await bootFor(cwd);
    return {
      cwd,
      specPath: boot.specPath,
      conventionsPath: boot.conventionsPath,
      usingBuiltin: boot.usingBuiltin,
      defaultAgent: boot.spec.defaultAgent,
      routingAuto: boot.spec.routing.auto,
      agents: await agentInfos(boot),
    };
  });

  ipcMain.handle(IPC.pickDirectory, async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle(IPC.listAgents, async (_e, cwd: string): Promise<AgentInfo[]> => {
    return agentInfos(await bootFor(cwd));
  });

  ipcMain.handle(IPC.listRequests, async () => {
    const boot = await bootFor(homedir());
    const requests = await boot.store.listRequests();
    const out = [];
    for (const r of requests) {
      const runs = await boot.store.runsFor(r.id);
      out.push({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt,
        agents: [...new Set(runs.map((x) => x.agentId))],
      });
    }
    return out;
  });

  ipcMain.handle(IPC.getRequest, async (_e, id: string) => {
    const boot = await bootFor(homedir());
    const req = await boot.store.getRequest(id);
    if (!req) return null;
    const runs = await boot.store.runsFor(id);
    return { ...req, runs };
  });

  ipcMain.handle(IPC.startRequest, async (_e, input: StartRequestInput) => {
    const boot = await bootFor(input.cwd);
    const decision = await boot.orchestrator.resolveAgent({
      agentId: input.agentId,
      prompt: input.prompt,
      cwd: input.cwd,
    });
    const request = await boot.store.createRequest({ prompt: input.prompt, cwd: input.cwd });
    const controller = new AbortController();
    activeRuns.set(request.id, controller);

    // Stream asynchronously; the renderer already has the requestId to listen.
    void streamRun(boot, {
      requestId: request.id,
      agentId: decision.agentId,
      reason: decision.reason,
      input,
      signal: controller.signal,
    });

    return { requestId: request.id };
  });

  ipcMain.handle(IPC.cancelRequest, async (_e, requestId: string) => {
    activeRuns.get(requestId)?.abort();
  });
}

async function streamRun(
  boot: Bootstrapped,
  ctx: {
    requestId: string;
    agentId: string;
    reason: string;
    input: StartRequestInput;
    signal: AbortSignal;
  },
): Promise<void> {
  broadcast(IPC.runEvent, {
    requestId: ctx.requestId,
    kind: 'routed',
    agentId: ctx.agentId,
    reason: ctx.reason,
  });
  try {
    for await (const event of boot.orchestrator.run(
      {
        agentId: ctx.agentId,
        cwd: ctx.input.cwd,
        prompt: ctx.input.prompt,
        permissionMode: ctx.input.mode,
        requestId: ctx.requestId,
      },
      { signal: ctx.signal },
    )) {
      broadcast(IPC.runEvent, { requestId: ctx.requestId, kind: 'event', event });
    }
  } catch (err) {
    broadcast(IPC.runEvent, {
      requestId: ctx.requestId,
      kind: 'event',
      event: { kind: 'error', message: String(err), fatal: true },
    });
  } finally {
    activeRuns.delete(ctx.requestId);
    broadcast(IPC.runEvent, {
      requestId: ctx.requestId,
      kind: 'finished',
      cancelled: ctx.signal.aborted,
    });
  }
}
