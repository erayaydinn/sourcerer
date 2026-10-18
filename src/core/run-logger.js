import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVENTS } from './events.js';

// Writes runs/<id>/: orchestrator.log, <agent>.log (live), <agent>.json and summary.json.
export function attachRunLogger(bus, runDir) {
  const calls = [];
  const streamed = new Set();
  const agentLog = (agent, text) => appendFileSync(join(runDir, `${agent}.log`), `${text}\n`);

  for (const name of Object.keys(EVENTS).filter((name) => name !== 'agent.log')) {
    bus.on(name, (payload) => {
      const line = { ...payload };
      delete line.output; // full output goes to <agent>.log
      appendFileSync(join(runDir, 'orchestrator.log'), `${new Date().toISOString()} ${name} ${JSON.stringify(line)}\n`);
    });
  }

  bus.on('agent.started', (event) => {
    streamed.delete(event.agent);
    agentLog(event.agent, `--- round ${event.round}, attempt ${event.attempt} (${event.llm}) ---`);
  });

  bus.on('agent.log', (event) => {
    streamed.add(event.agent);
    agentLog(event.agent, event.line);
  });

  bus.on('agent.finished', (event) => {
    // Output is only repeated when nothing was streamed for this attempt.
    if (event.status === 'ok' && !streamed.has(event.agent)) agentLog(event.agent, event.output ?? '');
    if (event.status === 'failed') agentLog(event.agent, `ERROR: ${event.error}`);
    agentLog(event.agent, `--- ${event.status}, $${event.costUsd ?? '?'} (${event.costSource}), ${Math.round(event.durationMs / 1000)}s ---\n`);

    const call = {
      role: event.role, llm: event.llm, model: event.model, round: event.round, attempt: event.attempt, status: event.status,
      usage: event.usage, costUsd: event.costUsd, costSource: event.costSource, durationMs: event.durationMs,
    };
    const file = join(runDir, `${event.agent}.json`);
    const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    writeFileSync(file, JSON.stringify([...existing, call], null, 2));
    calls.push({ agent: event.agent, ...call });
  });

  bus.on('run.finished', (event) => {
    writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summarize(event, calls), null, 2));
  });
}

function summarize(event, calls) {
  const perAgent = {};
  const perLlm = {};
  for (const call of calls) {
    perAgent[call.agent] = (perAgent[call.agent] ?? 0) + (call.costUsd ?? 0);
    perLlm[call.llm] = (perLlm[call.llm] ?? 0) + (call.costUsd ?? 0);
  }
  return {
    runId: event.runId,
    status: event.status,
    error: event.error,
    totalUsd: event.totalUsd,
    perAgent,
    perLlm,
    unknownCostCalls: calls.filter((call) => call.costSource === 'unknown').length,
    rounds: event.rounds,
    reviewRounds: calls.filter((call) => call.role === 'reviewer' && call.status === 'ok').length,
    finalComments: event.finalComments,
    coderNotes: event.coderNotes,
    worktrees: event.worktrees,
  };
}
