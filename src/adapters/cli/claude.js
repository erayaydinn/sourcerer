// Verified against docs/cli-help/claude.txt (2.1.302) and test/fixtures/claude-stream.jsonl.
// stream-json with --print requires --verbose (checked with a real call).
// Edit/Write scoped to ./** was verified to block writes in --add-dir folders.
const TOOL_NAMES = {
  read_file: ['Read'],
  write_file: ['Edit(./**)', 'Write(./**)'],
  run_command: ['Bash'],
  search_code: ['Grep', 'Glob'],
  find_symbol: ['Grep'],
  search_docs: ['Grep'],
  web_search: ['WebSearch'],
  web_fetch: ['WebFetch'],
};

export function command({ prompt, model, allowedTools, readDirs = [] }) {
  const tools = [...new Set(allowedTools.flatMap((name) => TOOL_NAMES[name] ?? []))];
  // dontAsk denies every tool that is not in --allowedTools.
  const args = ['-p', '--verbose', '--output-format', 'stream-json', '--no-session-persistence', '--permission-mode', 'dontAsk', '--model', model];
  if (readDirs.length) args.push('--add-dir', ...readDirs);
  // --allowedTools is variadic, so the prompt goes through stdin.
  if (tools.length) args.push('--allowedTools', ...tools);
  return { args, input: prompt };
}

// One stream line -> readable log line, or null to skip it.
export function logLine(line) {
  const event = JSON.parse(line);
  if (event.type !== 'assistant') return null;
  return event.message.content
    .map((block) => block.type === 'text' ? block.text : block.type === 'tool_use' ? `→ ${block.name} ${JSON.stringify(block.input).slice(0, 200)}` : '')
    .filter(Boolean)
    .join('\n') || null;
}

// The last line of the stream is the result (same shape as --output-format json).
// A failed result still reports its cost, so the error carries it (error.cost) for the budget.
export function parse(stdout) {
  const json = JSON.parse(stdout.trim().split('\n').at(-1));
  if (json.type !== 'result') throw new Error('claude: stream ended without a result');
  const usage = json.usage ?? {};
  const cost = {
    usage: {
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      cachedTokens: usage.cache_read_input_tokens ?? 0,
    },
    costUsd: json.total_cost_usd,
  };
  if (json.is_error) {
    const error = new Error(`claude failed (${json.api_error ?? json.subtype}): ${json.result ?? ''}`);
    error.cost = { ...cost, costSource: typeof cost.costUsd === 'number' ? 'reported' : 'unknown' };
    error.rateLimited = json.api_error_status === 429 || /usage_limit|rate_limit/.test(json.api_error ?? '');
    throw error;
  }
  return { output: json.result, ...cost };
}
