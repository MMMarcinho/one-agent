/**
 * Persistent session management.
 *
 * A Request (需求) is one top-level user task. Driving it may start several
 * backend sessions across different agents — Claude Code, Codex, and any agents
 * they delegate to. Every such session is recorded as a Run linked to the
 * request, so the user can later browse past requests and see exactly which
 * agent ran which session (and which runs were delegated by whom).
 *
 * Storage is a directory of small JSON files. Each process writes only its own
 * run files, so delegated sub-agents running in separate processes record into
 * the same request without write contention.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface RequestRecord {
  id: string;
  /** Short title (first line of the prompt). */
  title: string;
  prompt: string;
  cwd: string;
  createdAt: string;
}

export interface RunRecord {
  id: string;
  requestId: string;
  agentId: string;
  /** Backend session id, once the adapter reports one. */
  sessionId?: string;
  /** Who started this run: "user" or the delegating agent id. */
  parent: string;
  /** Delegation depth (0 = user-initiated). */
  depth: number;
  prompt: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  /** Short summary of the run's result/output. */
  resultSummary?: string;
}

export class SessionStore {
  private readonly requestsDir: string;
  private readonly runsDir: string;

  constructor(root?: string) {
    const base = resolve(
      root ?? process.env.ONE_AGENT_HOME ?? join(homedir(), '.one-agent'),
    );
    this.requestsDir = join(base, 'requests');
    this.runsDir = join(base, 'runs');
  }

  /** The directory this store persists to (propagated to child processes). */
  get root(): string {
    return resolve(this.requestsDir, '..');
  }

  async createRequest(input: { prompt: string; cwd: string }): Promise<RequestRecord> {
    await this.ensure();
    const record: RequestRecord = {
      id: randomUUID(),
      title: titleOf(input.prompt),
      prompt: input.prompt,
      cwd: input.cwd,
      createdAt: new Date().toISOString(),
    };
    await writeFile(this.requestPath(record.id), JSON.stringify(record, null, 2));
    return record;
  }

  async startRun(input: {
    requestId: string;
    agentId: string;
    parent: string;
    depth: number;
    prompt: string;
  }): Promise<RunRecord> {
    await this.ensure();
    const record: RunRecord = {
      id: randomUUID(),
      requestId: input.requestId,
      agentId: input.agentId,
      parent: input.parent,
      depth: input.depth,
      prompt: input.prompt,
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    await this.writeRun(record);
    return record;
  }

  async updateRun(
    record: RunRecord,
    patch: Partial<Pick<RunRecord, 'sessionId' | 'status' | 'resultSummary' | 'endedAt'>>,
  ): Promise<RunRecord> {
    Object.assign(record, patch);
    await this.writeRun(record);
    return record;
  }

  async listRequests(): Promise<RequestRecord[]> {
    const files = await this.safeList(this.requestsDir);
    const records: RequestRecord[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      records.push(JSON.parse(await readFile(join(this.requestsDir, file), 'utf8')));
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getRequest(id: string): Promise<RequestRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.requestPath(id), 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** All runs belonging to a request, ordered chronologically. */
  async runsFor(requestId: string): Promise<RunRecord[]> {
    const files = await this.safeList(this.runsDir);
    const runs: RunRecord[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const run: RunRecord = JSON.parse(await readFile(join(this.runsDir, file), 'utf8'));
      if (run.requestId === requestId) runs.push(run);
    }
    return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  private async ensure(): Promise<void> {
    await mkdir(this.requestsDir, { recursive: true });
    await mkdir(this.runsDir, { recursive: true });
  }

  private async writeRun(record: RunRecord): Promise<void> {
    await writeFile(join(this.runsDir, `${record.id}.json`), JSON.stringify(record, null, 2));
  }

  private requestPath(id: string): string {
    return join(this.requestsDir, `${id}.json`);
  }

  private async safeList(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }
}

function titleOf(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/)[0]?.trim() ?? '';
  return firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine || '(empty)';
}
