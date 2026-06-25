import { BrowserWindow, dialog, ipcMain } from 'electron';
import { homedir } from 'node:os';
import type { Conversation } from '../../core/conversation.js';
import { bootstrap, type Bootstrapped } from '../../app.js';
import type { ProjectRecord } from '../../core/session-store.js';
import {
  IPC,
  type AgentInfo,
  type InitResult,
  type ProjectInfo,
  type SendMessageInput,
  type StartConversationInput,
} from '../shared/ipc.js';

/** Per-directory bootstrap cache (spec + orchestrator + store). */
const boots = new Map<string, Promise<Bootstrapped>>();

interface LiveConversation {
  convo: Conversation;
  cwd: string;
  agentId: string;
  reason: string;
  /** Controls the in-flight turn, so the UI can interrupt it. */
  turnController?: AbortController;
}
/** Open conversations keyed by conversationId (= store requestId). */
const conversations = new Map<string, LiveConversation>();

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

async function projectInfo(boot: Bootstrapped, project: ProjectRecord): Promise<ProjectInfo> {
  return {
    id: project.id,
    path: project.path,
    name: project.name,
    alias: project.alias,
    lastUsedAt: project.lastUsedAt,
    lastSessionAt: await boot.store.latestSessionAtForProject(project.id),
  };
}

export function registerIpc(): void {
  ipcMain.handle(IPC.init, async (_e, startDir?: string): Promise<InitResult> => {
    const home = homedir();
    const homeBoot = await bootFor(home);
    const existingProject = startDir ? undefined : (await homeBoot.store.listProjects())[0];
    const cwd = startDir || existingProject?.path || home;
    const boot = await bootFor(cwd);
    const project = startDir
      ? await boot.store.ensureProject(cwd)
      : existingProject;
    return {
      cwd,
      project: project ? await projectInfo(boot, project) : null,
      specPath: boot.specPath,
      conventionsPath: boot.conventionsPath,
      usingBuiltin: boot.usingBuiltin,
      defaultAgent: boot.spec.defaultAgent,
      routingAuto: boot.spec.routing.auto,
      agents: await agentInfos(boot),
    };
  });

  ipcMain.handle(IPC.listProjects, async () => {
    const boot = await bootFor(homedir());
    const projects = await boot.store.listProjects();
    const infos = await Promise.all(projects.map((project) => projectInfo(boot, project)));
    return infos.sort((a, b) =>
      (b.lastSessionAt ?? b.lastUsedAt).localeCompare(a.lastSessionAt ?? a.lastUsedAt),
    );
  });

  ipcMain.handle(IPC.renameProject, async (_e, id: string, alias: string) => {
    const boot = await bootFor(homedir());
    const project = await boot.store.updateProjectAlias(id, alias);
    return project ? projectInfo(boot, project) : null;
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

  ipcMain.handle(IPC.listRequests, async (_e, projectId: string) => {
    const boot = await bootFor(homedir());
    const requests = await boot.store.requestsForProject(projectId);
    const out = [];
    for (const r of requests) {
      const runs = await boot.store.runsFor(r.id);
      const endedOrStarted = runs
        .map((x) => x.endedAt ?? x.startedAt)
        .sort((a, b) => b.localeCompare(a))[0];
      const byAgent = new Map<string, typeof runs>();
      for (const run of runs) {
        const bucket = byAgent.get(run.agentId) ?? [];
        bucket.push(run);
        byAgent.set(run.agentId, bucket);
      }
      const agentRuns = [...byAgent.entries()].map(([agentId, agentRunsForRequest]) => {
        const latestAt =
          agentRunsForRequest
            .map((x) => x.endedAt ?? x.startedAt)
            .sort((a, b) => b.localeCompare(a))[0] ?? r.createdAt;
        return {
          agentId,
          latestAt,
          statuses: [...new Set(agentRunsForRequest.map((x) => x.status))],
          runCount: agentRunsForRequest.length,
        };
      });
      out.push({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt,
        latestAt: endedOrStarted ?? r.createdAt,
        agents: [...new Set(runs.map((x) => x.agentId))],
        agentRuns,
        statuses: [...new Set(runs.map((x) => x.status))],
        runCount: runs.length,
      });
    }
    return out.sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  });

  ipcMain.handle(IPC.getRequest, async (_e, id: string) => {
    const boot = await bootFor(homedir());
    const req = await boot.store.getRequest(id);
    if (!req) return null;
    const runs = await boot.store.runsFor(id);
    return { ...req, runs };
  });

  ipcMain.handle(IPC.startConversation, async (_e, input: StartConversationInput) => {
    const boot = await bootFor(input.cwd);
    const decision = await boot.orchestrator.resolveAgent({
      agentId: input.agentId,
      prompt: input.prompt,
      cwd: input.cwd,
    });
    const request = await boot.store.createRequest({
      prompt: input.prompt,
      cwd: input.cwd,
      projectId: input.projectId,
    });
    const convo = await boot.orchestrator.openConversation({
      agentId: decision.agentId,
      cwd: input.cwd,
      requestId: request.id,
      permissionMode: input.mode,
    });
    conversations.set(request.id, {
      convo,
      cwd: input.cwd,
      agentId: decision.agentId,
      reason: decision.reason,
    });

    void runTurn(request.id, input.turnId, input.prompt);
    return { conversationId: request.id, agentId: decision.agentId, reason: decision.reason };
  });

  ipcMain.handle(IPC.sendMessage, async (_e, input: SendMessageInput) => {
    if (!conversations.has(input.conversationId)) return;
    void runTurn(input.conversationId, input.turnId, input.prompt);
  });

  ipcMain.handle(IPC.cancelTurn, async (_e, conversationId: string) => {
    const live = conversations.get(conversationId);
    live?.turnController?.abort();
    live?.convo.interrupt();
  });

  ipcMain.handle(IPC.closeConversation, async (_e, conversationId: string) => {
    const live = conversations.get(conversationId);
    if (!live) return;
    conversations.delete(conversationId);
    live.turnController?.abort();
    await live.convo.close();
  });
}

/** Stream one turn of a conversation to the renderer. */
async function runTurn(conversationId: string, turnId: string, prompt: string): Promise<void> {
  const live = conversations.get(conversationId);
  if (!live) return;
  const controller = new AbortController();
  live.turnController = controller;

  broadcast(IPC.runEvent, {
    conversationId,
    turnId,
    kind: 'routed',
    agentId: live.agentId,
    reason: live.reason,
  });
  try {
    for await (const event of live.convo.send(prompt, { signal: controller.signal })) {
      broadcast(IPC.runEvent, { conversationId, turnId, kind: 'event', event });
    }
  } catch (err) {
    broadcast(IPC.runEvent, {
      conversationId,
      turnId,
      kind: 'event',
      event: { kind: 'error', message: String(err), fatal: true },
    });
  } finally {
    if (live.turnController === controller) live.turnController = undefined;
    broadcast(IPC.runEvent, {
      conversationId,
      turnId,
      kind: 'finished',
      cancelled: controller.signal.aborted,
    });
  }
}
