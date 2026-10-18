import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { runAgent } from '../adapters/index.js';
import { createWorktrees, diffWorktree, ignoredFiles, taskDir, taskSlug, workspaceFor } from '../git/worktree.js';
import { addCost, createBudget, overBudget } from './cost.js';
import { emit } from './events.js';
import { coderPrompt, parseJsonBlock, planSchema, plannerPrompt, reviewSchema, reviewerPrompt } from './prompts.js';
import { attachRunLogger } from './run-logger.js';

// task -> planner -> contract -> worktrees -> review loop (coders in parallel -> tests -> diffs -> reviewer).
// `confirm(message)` resolves true to continue over budget. `run` is replaceable for tests.
// `pause(message)` (optional, for --interactive) resolves 'continue' | 'skip' | 'abort'.
// `sides` (optional, from --side) fixes which sides are worked on instead of the planner's choice.
// `signal` (optional AbortSignal) stops the run: running agents and commands are killed, logs are kept.
export async function runTask(task, { config, agents, pricing, bus, confirm, pause, sides, signal, run = runAgent, now = new Date() }) {
  const slug = taskSlug(task);
  const runId = `${stamp(now)}-${slug}`;
  const runDir = join(config.paths.runs, runId);
  mkdirSync(runDir, { recursive: true });
  attachRunLogger(bus, runDir);

  const ctx = { runId, runDir, worktrees: {}, config, pricing, bus, run, confirm, pause, signal, budget: createBudget(config.budget), gate: Promise.resolve(), stoppedBy: null, round: 0, lastComments: null, notes: {} };
  let worktrees = {};
  let status = 'failed';
  let errorText;
  emit(bus, 'run.started', { runId, task, slug, runDir, sides });

  try {
    if (sides) checkSides(sides).forEach((side) => coderFor(agents, side));
    const planner = byRole(agents, 'planner');
    const repos = config.repos;
    const planWorkspace = { cwd: runDir, readDirs: [repos.frontend.path, repos.backend.path] };
    const answer = await callAgent(ctx, planner, plannerPrompt(task, repos, sides), planWorkspace, 0);
    const plan = withSides(parseJsonBlock(answer, planSchema, 'planner'), sides);
    writeFileSync(join(runDir, 'contract.txt'), plan.contract);

    plan.sides.forEach((side) => coderFor(agents, side));
    signal?.throwIfAborted();
    worktrees = await createWorktrees(config, slug, plan.sides, { signal });
    ctx.worktrees = worktrees;
    emit(bus, 'worktrees.ready', { runId, worktrees });
    status = await reviewLoop(ctx, { task, plan, agents, worktrees, dir: taskDir(config, slug), runDir });
  } catch (error) {
    status = signal?.aborted || error?.aborted ? 'aborted' : error?.budgetStop ? 'stopped-budget' : 'failed';
    errorText = signal?.aborted ? 'stopped by user' : error instanceof Error ? error.message : String(error);
  }

  const rounds = ctx.round;
  const finalComments = ctx.lastComments;
  const coderNotes = ctx.notes;
  emit(bus, 'run.finished', {
    runId, status, totalUsd: ctx.budget.totalUsd, totalTokens: ctx.budget.totalTokens, rounds, finalComments, coderNotes, worktrees, error: errorText,
  });
  return { runId, runDir, status, rounds, finalComments, coderNotes, worktrees, error: errorText };
}

// Each round: run coders that have work -> their tests -> (if green) diffs + reviewer.
// Failing tests skip the reviewer and go straight back to that coder. Returns the final status.
async function reviewLoop(ctx, { task, plan, agents, worktrees, dir, runDir }) {
  const { repos, review: { maxRounds, testOutputChars, contextChars = 4000 } } = ctx.config;
  const reviewer = byRole(agents, 'reviewer');
  const tests = {};
  let feedback = Object.fromEntries(plan.sides.map((side) => [side, null]));

  for (let round = 1; ; round++) {
    ctx.signal?.throwIfAborted();
    ctx.round = round;
    await allOrThrow(Object.entries(feedback).map(([side, sideFeedback]) => {
      const coder = coderFor(agents, side);
      const workspace = workspaceFor(coder, worktrees, dir);
      return callAgent(ctx, coder, coderPrompt(task, plan, side, workspace, sideFeedback), workspace, round)
        .then((output) => { ctx.notes[side] = output.slice(-contextChars); });
    }));

    const failing = {};
    for (const side of Object.keys(feedback).filter((side) => repos[side].test)) {
      const result = await runTests(repos[side].test, worktrees[side], ctx.signal);
      const file = join(runDir, `${side}.r${round}.test.txt`);
      writeFileSync(file, result.output);
      tests[side] = { command: repos[side].test.run.join(' '), passed: result.passed };
      emit(ctx.bus, 'tests.finished', { runId: ctx.runId, side, round, passed: result.passed, file });
      if (!result.passed) failing[side] = { round: round + 1, comments: [], testOutput: result.output.slice(-testOutputChars) };
    }
    if (Object.keys(failing).length) {
      if (round >= maxRounds) return 'tests-failed';
      if (await pausePoint(ctx, `tests failed (${Object.keys(failing).join(', ')}); start fix round ${round + 1}?`) === 'skip') return 'tests-failed';
      feedback = failing;
      continue;
    }

    const context = {};
    for (const side of plan.sides) {
      const { diff, filesChanged } = await diffWorktree(worktrees[side], repos[side].base);
      const file = join(runDir, `${side}.r${round}.diff`);
      writeFileSync(file, diff);
      const ignored = await ignoredFiles(worktrees[side], contextChars);
      context[side] = { diff, test: tests[side] ?? null, ignored, notes: ctx.notes[side] };
      emit(ctx.bus, 'diff.ready', { runId: ctx.runId, side, round, file, filesChanged });
    }

    if (await pausePoint(ctx, `diffs for round ${round} are ready; run the reviewer?`) === 'skip') return 'unreviewed';
    emit(ctx.bus, 'review.requested', { runId: ctx.runId, agent: reviewer.name, round, sides: plan.sides });
    const prompt = reviewerPrompt(task, plan, context, ctx.lastComments);
    writeFileSync(join(runDir, `reviewer.r${round}.prompt.txt`), prompt);
    const answer = await callAgent(ctx, reviewer, prompt, workspaceFor(reviewer, worktrees, dir), round);
    const review = parseJsonBlock(answer, reviewSchema, 'reviewer');
    writeFileSync(join(runDir, `review.r${round}.json`), JSON.stringify(review, null, 2));
    emit(ctx.bus, 'review.finished', { runId: ctx.runId, agent: reviewer.name, round, ...review });

    ctx.lastComments = review.comments;
    if (review.verdict === 'approve') return 'approved';
    if (round >= maxRounds) return 'changes-requested';
    if (await pausePoint(ctx, `reviewer requested changes; start fix round ${round + 1}?`) === 'skip') return 'changes-requested';
    feedback = feedbackFor(plan.sides, review.comments, round + 1);
  }
}

// Only active with --interactive. 'abort' ends the run; the caller handles 'skip'.
async function pausePoint(ctx, message) {
  if (!ctx.pause) return 'continue';
  const choice = await ctx.pause(message);
  if (choice === 'abort') throw Object.assign(new Error('aborted by user'), { aborted: true });
  return choice;
}

// Sides with their own comments rerun (plus general ones); if there are only general comments, every side reruns.
function feedbackFor(sides, comments, round) {
  const named = sides.filter((side) => comments[side].length);
  const targets = named.length ? named : sides;
  return Object.fromEntries(targets.map((side) => [side, { round, comments: [...comments[side], ...comments.general] }]));
}

async function runTests(test, cwd, signal) {
  const [bin, ...args] = test.run;
  const result = await execa(bin, args, { cwd, reject: false, all: true, timeout: test.timeoutSec * 1000, cancelSignal: signal });
  signal?.throwIfAborted();
  const output = result.timedOut ? `timed out after ${test.timeoutSec}s\n${result.all ?? ''}` : (result.all ?? '');
  return { passed: result.exitCode === 0 && !result.timedOut, output };
}

// One call with a single retry on fallbackLlm. Budget is checked after every successful call.
async function callAgent(ctx, agent, prompt, workspace, round = 1) {
  const attempts = [{ llm: agent.llm, profile: agent.profile, model: agent.model }];
  if (agent.fallback) attempts.push({ llm: agent.fallbackLlm, profile: agent.fallback, model: agent.fallback.model });

  let lastError;
  for (const [index, attempt] of attempts.entries()) {
    const base = { runId: ctx.runId, agent: agent.name, role: agent.role, llm: attempt.llm, model: attempt.model, round, attempt: index + 1 };
    emit(ctx.bus, 'agent.started', base);
    const started = Date.now();
    let result;
    const onLog = (line) => emit(ctx.bus, 'agent.log', { runId: ctx.runId, agent: agent.name, line });
    try {
      result = await ctx.run({ ...agent, profile: attempt.profile, model: attempt.model },
        { prompt, ...workspace, sources: ragSources(agent, ctx), config: ctx.config, pricing: ctx.pricing, onLog, signal: ctx.signal });
    } catch (error) {
      lastError = error;
      if (ctx.signal?.aborted) {
        emit(ctx.bus, 'agent.finished', {
          ...base, status: 'failed', error: 'stopped by user', usage: null, costUsd: null, costSource: 'unknown', durationMs: Date.now() - started,
        });
        throw error; // no fallback attempt after a stop
      }
      // A failed call can still have cost money (the CLI reports it); count it.
      const cost = error?.cost;
      const next = attempts[index + 1];
      const sameAccount = next && attempt.profile.type === 'cli' && next.profile.type === 'cli' && next.profile.bin === attempt.profile.bin;
      if (error?.rateLimited && sameAccount) error.message += ` (fallback ${next.llm} skipped: same ${next.profile.bin} account)`;
      emit(ctx.bus, 'agent.finished', {
        ...base, status: 'failed', error: error instanceof Error ? error.message : String(error),
        usage: cost?.usage ?? null, costUsd: cost?.costUsd ?? null, costSource: cost?.costSource ?? 'unknown', durationMs: Date.now() - started,
      });
      if (typeof cost?.costUsd === 'number' || cost?.usage) await chargeBudget(ctx, agent.name, cost.costUsd, cost.usage);
      if (error?.rateLimited && sameAccount) break;
      continue;
    }
    emit(ctx.bus, 'agent.finished', { ...base, status: 'ok', ...result });
    await chargeBudget(ctx, agent.name, result.costUsd, result.usage);
    return result.output;
  }
  throw lastError;
}

// What the search tools may see, from the agent's rag.scope. A side's worktree is used
// once it exists, otherwise the base repo (the planner runs before worktrees).
// No scope means the tools fall back to the workspace.
function ragSources(agent, ctx) {
  const scope = agent.rag?.scope ?? [];
  if (!scope.length) return undefined;
  const dirOf = (side) => ctx.worktrees[side] ?? ctx.config.repos[side].path;
  const sides = ['frontend', 'backend'];
  return {
    code: sides.filter((side) => scope.includes(side)).map((side) => ({ name: side, dir: dirOf(side) })),
    docs: scope.includes('docs') ? sides.map((side) => ({ name: side, dir: dirOf(side), paths: ctx.config.repos[side].docs ?? [] })) : [],
    contract: scope.includes('contract') ? join(ctx.runDir, 'contract.txt') : null,
  };
}

// Questions are queued so parallel coders never ask at the same time.
function chargeBudget(ctx, agentName, costUsd, usage) {
  addCost(ctx.budget, agentName, costUsd, usage);
  emit(ctx.bus, 'cost.updated', {
    runId: ctx.runId, totalUsd: ctx.budget.totalUsd, perAgent: { ...ctx.budget.perAgent },
    totalTokens: ctx.budget.totalTokens, perAgentTokens: { ...ctx.budget.perAgentTokens },
  });
  ctx.gate = ctx.gate.then(async () => {
    const message = ctx.stoppedBy ?? overBudget(ctx.budget, agentName);
    if (!message) return;
    if (ctx.stoppedBy || !(await ctx.confirm(`${message}. Continue?`))) {
      ctx.stoppedBy = message;
      throw Object.assign(new Error(message), { budgetStop: true });
    }
  });
  const result = ctx.gate;
  ctx.gate = ctx.gate.catch(() => {});
  return result;
}

// Waits for every coder, then throws the first failure.
async function allOrThrow(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

// --side values: frontend and/or backend, at least one.
export function checkSides(sides) {
  const bad = sides.filter((side) => !['frontend', 'backend'].includes(side));
  if (bad.length || !sides.length) throw new Error(`--side expects frontend and/or backend, got "${bad.join(', ') || 'nothing'}"`);
  return [...new Set(sides)];
}

// --side wins over the planner's choice, but the planner must have written instructions for it.
function withSides(plan, sides) {
  if (!sides) return plan;
  const missing = sides.filter((side) => !plan.instructions[side]);
  if (missing.length) throw new Error(`planner wrote no instructions for ${missing.join(', ')} (required by --side)`);
  return { ...plan, sides: checkSides(sides) };
}

function byRole(agents, role) {
  const found = agents.find((agent) => agent.role === role);
  if (!found) throw new Error(`no ${role} agent`);
  return found;
}

function coderFor(agents, side) {
  const found = agents.find((agent) => agent.role === 'coder' && agent.repo === side);
  if (!found) throw new Error(`planner chose ${side}, but there is no ${side} coder`);
  return found;
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
