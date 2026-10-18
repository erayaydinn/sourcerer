// Verified against docs/cli-help/cursor-agent.txt (2026.04.30) and test/fixtures/cursor-stream.jsonl.
// cursor-agent has no tool allowlist and no --add-dir: read-only agents get --mode ask,
// agents that run commands get --force (allows any command unless denied).
const WRITE_TOOLS = ['write_file', 'run_command'];

export function command({ prompt, model, cwd, allowedTools }) {
  const args = ['-p', '--output-format', 'stream-json', '--trust', '--workspace', cwd, '--model', model];
  if (!allowedTools.some((name) => WRITE_TOOLS.includes(name))) args.push('--mode', 'ask');
  else if (allowedTools.includes('run_command')) args.push('--force');
  // The prompt goes through stdin (checked with a real call), so long prompts are fine.
  return { args, input: prompt };
}

// One stream line -> readable log line, or null to skip it (thinking, tool results, ...).
export function logLine(line) {
  const event = JSON.parse(line);
  if (event.type === 'assistant') {
    return event.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('') || null;
  }
  if (event.type === 'tool_call' && event.subtype === 'started') {
    const [key, call] = Object.entries(event.tool_call)[0];
    return `→ ${key.replace(/ToolCall$/, '')} ${JSON.stringify(call.args).slice(0, 200)}`;
  }
  return null;
}

// The last line of the stream is the result. Cursor reports usage but no cost.
// inputTokens excludes cacheReadTokens (a real call had 338 input vs 50432 cache reads).
export function parse(stdout) {
  const json = JSON.parse(stdout.trim().split('\n').at(-1));
  if (json.type !== 'result') throw new Error('cursor-agent: stream ended without a result');
  if (json.is_error) throw new Error(`cursor-agent failed (${json.subtype}): ${json.result ?? ''}`);
  const usage = json.usage;
  return {
    output: json.result,
    usage: usage && {
      inputTokens: usage.inputTokens + (usage.cacheWriteTokens ?? 0),
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cacheReadTokens ?? 0,
    },
  };
}
