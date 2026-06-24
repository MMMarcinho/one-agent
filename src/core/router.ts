/**
 * Agent routing — deciding *which* agent handles a request when the user hasn't
 * picked one ("I don't want to choose"). The router only ever selects among
 * agents that are actually available on the machine, and every decision carries
 * a human-readable reason so the choice is transparent.
 *
 * RuleRouter is deterministic: explicit spec rules first, then a light
 * role-keyword heuristic, then the default agent. The Router interface leaves
 * room for a future model-assisted router without touching callers.
 */
import type { Spec } from './spec.js';

export interface RoutingContext {
  spec: Spec;
  prompt: string;
  cwd: string;
  /** Agent ids that detection found available on this machine. */
  available: string[];
}

export interface RoutingDecision {
  agentId: string;
  reason: string;
}

export interface Router {
  choose(ctx: RoutingContext): RoutingDecision | Promise<RoutingDecision>;
}

export class RuleRouter implements Router {
  choose(ctx: RoutingContext): RoutingDecision {
    const has = (id: string): boolean => ctx.available.includes(id);

    // 1. Explicit spec rules win, but only if their target is available.
    for (const rule of ctx.spec.routing.rules) {
      if (has(rule.use) && ruleMatches(rule.when, ctx)) {
        return { agentId: rule.use, reason: `matched rule "${rule.when}"` };
      }
    }

    // 2. Soft heuristic: a clear single best match between the prompt and the
    //    agents' role descriptions.
    const winner = bestRoleMatch(ctx);
    if (winner) {
      return { agentId: winner, reason: `best role match for the task` };
    }

    // 3. Fall back to the default agent, else any available agent.
    if (has(ctx.spec.defaultAgent)) {
      return { agentId: ctx.spec.defaultAgent, reason: 'default agent' };
    }
    if (ctx.available.length > 0) {
      return { agentId: ctx.available[0], reason: 'only available agent' };
    }
    throw new Error('no available agents to route to');
  }
}

/** Match a rule's `when` against the prompt and cwd: `/regex/flags` or substring. */
function ruleMatches(when: string, ctx: RoutingContext): boolean {
  const haystack = `${ctx.prompt}\n${ctx.cwd}`;
  const re = parseRegex(when);
  if (re) return re.test(haystack);
  return haystack.toLowerCase().includes(when.toLowerCase());
}

function parseRegex(pattern: string): RegExp | undefined {
  const match = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (!match) return undefined;
  try {
    return new RegExp(match[1], match[2]);
  } catch {
    return undefined;
  }
}

/**
 * Score each available agent by how many distinct words of its role description
 * appear in the prompt. Returns the agent id only when there is a strict single
 * winner with a non-zero score, so the heuristic never overrides the default on
 * a tie or a weak signal.
 */
function bestRoleMatch(ctx: RoutingContext): string | undefined {
  const promptWords = new Set(tokenize(ctx.prompt));
  let best: { id: string; score: number } | undefined;
  let tie = false;

  for (const id of ctx.available) {
    const role = ctx.spec.agents[id]?.role ?? '';
    const roleWords = new Set(tokenize(role));
    let score = 0;
    for (const w of roleWords) if (promptWords.has(w)) score += 1;
    if (!best || score > best.score) {
      best = { id, score };
      tie = false;
    } else if (best && score === best.score) {
      tie = true;
    }
  }
  if (!best || best.score === 0 || tie) return undefined;
  return best.id;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with', 'is',
  'an', 'second', 'opinion', 'general', 'purpose', 'fast', 'focused',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}
