import { addUsage, emptyUsage, priceUsage } from '../core/cost.js';
import { runTool, toolSpecs } from '../tools/index.js';

// Built-in agent loop for API adapters: call the model, run its tool calls, repeat.
export async function runLoop(api, profile, opts) {
  const { prompt, system, cwd, readDirs, sources, model, allowedTools, timeoutSec, maxTurns, toolConfig, pricing, onLog = () => {} } = opts;
  const started = Date.now();
  const deadline = started + timeoutSec * 1000;
  const client = api.createClient(profile);
  const tools = toolSpecs(allowedTools);
  const ctx = { cwd, readDirs, sources, allowedTools, toolConfig };
  const usage = emptyUsage();
  const messages = [{ role: 'user', content: prompt }];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error(`timed out after ${timeoutSec}s`);

    const reply = await api.call({ client, profile, model, system, messages, tools, timeoutMs });
    addUsage(usage, reply.usage);
    messages.push(reply.assistantMessage);
    if (reply.text) onLog(reply.text);
    for (const call of reply.toolCalls) onLog(`→ ${call.name} ${JSON.stringify(call.args).slice(0, 200)}`);

    if (!reply.toolCalls.length) {
      return { output: reply.text, usage, ...priceUsage(model, usage, pricing), durationMs: Date.now() - started };
    }
    const results = await Promise.all(reply.toolCalls.map((toolCall) => runTool(toolCall.name, toolCall.args, ctx)));
    messages.push(...api.toolResults(reply.toolCalls, results));
  }
  throw new Error(`reached maxTurns (${maxTurns})`);
}
