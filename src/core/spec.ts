/**
 * The "spec" — the user-defined orchestration rules.
 *
 * This is the heart of one-agent's value: the user declares which agents exist,
 * what each is for, who may delegate to whom, and how routing/recursion are
 * bounded. The orchestrator enforces whatever is declared here.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const permissionMode = z.enum(['plan', 'ask', 'acceptEdits', 'auto', 'bypass']);
const adapterType = z.enum(['claude-code', 'codex', 'acp']);

const agentSpec = z.object({
  type: adapterType,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  model: z.string().optional(),
  permissionMode: permissionMode.optional(),
  role: z.string().optional(),
  env: z.record(z.string()).optional(),
  canDelegateTo: z.array(z.string()).optional(),
});

const routingRule = z.object({
  /** Plain-language or glob hint matched against the task/cwd. */
  when: z.string(),
  /** Agent id to route to when the rule matches. */
  use: z.string(),
});

export const specSchema = z.object({
  version: z.literal(1),
  /** Agent used when no rule matches and the user doesn't pick one. */
  defaultAgent: z.string(),
  /** Override the conventions file path (default: ONE_AGENT.md, auto-discovered). */
  conventionsFile: z.string().optional(),
  agents: z.record(agentSpec),
  routing: z
    .object({
      /** If true, the default agent may be auto-selected by rules. */
      auto: z
        .boolean()
        .nullish()
        .transform((v) => v ?? false),
      rules: z
        .array(routingRule)
        .nullish()
        .transform((v) => v ?? []),
    })
    .nullish()
    .transform((v) => v ?? { auto: false, rules: [] }),
  delegation: z
    .object({
      enabled: z
        .boolean()
        .nullish()
        .transform((v) => v ?? true),
      /** Hard cap on agent->agent recursion depth. */
      maxDepth: z
        .number()
        .int()
        .min(0)
        .nullish()
        .transform((v) => v ?? 2),
      /** Record every delegated run for inspection. */
      audit: z
        .boolean()
        .nullish()
        .transform((v) => v ?? true),
    })
    .nullish()
    .transform((v) => v ?? { enabled: true, maxDepth: 2, audit: true }),
});

export type Spec = z.infer<typeof specSchema>;
export type AgentSpec = z.infer<typeof agentSpec>;

/** Default binary names per adapter type. */
const DEFAULT_COMMAND: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  acp: '',
};

const SPEC_FILENAMES = ['one-agent.yaml', 'one-agent.yml', '.one-agent.yaml'];

/** Locate a spec file by walking up from `startDir`, else fall back to home. */
export function findSpecPath(startDir: string): string | undefined {
  let dir = resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const name of SPEC_FILENAMES) {
      const candidate = resolve(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) {
    for (const name of SPEC_FILENAMES) {
      const candidate = resolve(home, '.config', 'one-agent', name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function loadSpec(path: string): Promise<Spec> {
  const raw = await readFile(path, 'utf8');
  const data = parseYaml(raw);
  const parsed = specSchema.safeParse(data);
  if (!parsed.success) {
    throw new SpecError(path, parsed.error.issues.map(formatIssue).join('\n'));
  }
  validateReferences(parsed.data, path);
  return parsed.data;
}

/**
 * A minimal built-in spec used when the user has none yet: detect-and-run the
 * common agents with sane defaults so the tool is useful out of the box.
 */
export function builtinSpec(): Spec {
  return specSchema.parse({
    version: 1,
    defaultAgent: 'claude-code',
    agents: {
      'claude-code': {
        type: 'claude-code',
        permissionMode: 'acceptEdits',
        role: 'General-purpose coding, repo-wide reasoning and refactors.',
        canDelegateTo: ['codex'],
      },
      codex: {
        type: 'codex',
        permissionMode: 'acceptEdits',
        role: 'Fast focused edits and an independent second opinion.',
        canDelegateTo: ['claude-code'],
      },
    },
    routing: { auto: false, rules: [] },
    delegation: { enabled: true, maxDepth: 2, audit: true },
  });
}

/** Resolve the effective launch command for an agent. */
export function commandFor(id: string, spec: AgentSpec): string {
  return spec.command ?? DEFAULT_COMMAND[spec.type] ?? id;
}

export class SpecError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(`Invalid spec at ${path}:\n${message}`);
    this.name = 'SpecError';
  }
}

function validateReferences(spec: Spec, path: string): void {
  const ids = new Set(Object.keys(spec.agents));
  const problems: string[] = [];
  if (!ids.has(spec.defaultAgent)) {
    problems.push(`defaultAgent "${spec.defaultAgent}" is not a defined agent.`);
  }
  for (const [id, agent] of Object.entries(spec.agents)) {
    for (const target of agent.canDelegateTo ?? []) {
      if (!ids.has(target)) {
        problems.push(`agent "${id}" may delegate to unknown agent "${target}".`);
      }
    }
  }
  for (const rule of spec.routing.rules) {
    if (!ids.has(rule.use)) {
      problems.push(`routing rule "${rule.when}" uses unknown agent "${rule.use}".`);
    }
  }
  if (problems.length) throw new SpecError(path, problems.join('\n'));
}

function formatIssue(issue: z.ZodIssue): string {
  const where = issue.path.join('.') || '<root>';
  return `  - ${where}: ${issue.message}`;
}
