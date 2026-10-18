import { EventEmitter } from 'node:events';
import { z } from 'zod';

const runId = z.string();
const agent = z.string();
const round = z.number();
const usage = z.object({ inputTokens: z.number(), outputTokens: z.number(), cachedTokens: z.number() }).nullable();
const comments = z.object({ frontend: z.array(z.string()), backend: z.array(z.string()), general: z.array(z.string()) });

// Every event name and its payload. emit() rejects anything else.
export const EVENTS = {
  'run.started': z.object({ runId, task: z.string(), slug: z.string(), runDir: z.string(), sides: z.array(z.string()).optional() }),
  'agent.started': z.object({ runId, agent, role: z.string(), llm: z.string(), model: z.string(), round, attempt: z.number() }),
  'agent.finished': z.object({
    runId,
    agent,
    role: z.string(),
    llm: z.string(),
    model: z.string(),
    round,
    attempt: z.number(),
    status: z.enum(['ok', 'failed']),
    output: z.string().optional(),
    error: z.string().optional(),
    usage,
    costUsd: z.number().nullable(),
    costSource: z.enum(['reported', 'estimated', 'unknown']),
    durationMs: z.number(),
  }),
  'agent.log': z.object({ runId, agent, line: z.string() }),
  'worktrees.ready': z.object({ runId, worktrees: z.record(z.string(), z.string()) }),
  'tests.finished': z.object({ runId, side: z.string(), round, passed: z.boolean(), file: z.string() }),
  'diff.ready': z.object({ runId, side: z.string(), round, file: z.string(), filesChanged: z.number() }),
  'review.requested': z.object({ runId, agent, round, sides: z.array(z.string()) }),
  'review.finished': z.object({ runId, agent, round, verdict: z.enum(['approve', 'request-changes']), comments }),
  'cost.updated': z.object({
    runId, totalUsd: z.number(), perAgent: z.record(z.string(), z.number()),
    totalTokens: z.number(), perAgentTokens: z.record(z.string(), z.number()),
  }),
  'run.finished': z.object({
    runId,
    status: z.enum(['approved', 'changes-requested', 'tests-failed', 'unreviewed', 'aborted', 'failed', 'stopped-budget']),
    totalUsd: z.number(),
    totalTokens: z.number(),
    rounds: z.number(),
    finalComments: comments.nullable(),
    coderNotes: z.record(z.string(), z.string()),
    worktrees: z.record(z.string(), z.string()),
    error: z.string().optional(),
  }),
};

export function createBus() {
  return new EventEmitter();
}

export function emit(bus, name, payload) {
  bus.emit(name, EVENTS[name].parse(payload));
}
