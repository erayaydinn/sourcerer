// Template for a new CLI recipe (gemini, opencode, aider, ...).
// 1. Save `<bin> --help` to docs/cli-help/<bin>.txt and take flags only from there.
// 2. Save one real JSON response to test/fixtures/<bin>.json and add a parse test.
// 3. Register the recipe in src/adapters/cli.js under its bin name.

export function command({ prompt, model, cwd, readDirs, allowedTools }) {
  void cwd;
  void readDirs;
  void allowedTools;
  return { args: ['--model', model, prompt], input: undefined };
}

// Optional: one stdout line -> readable log line (or null). Leave out if the CLI can't stream.
export function logLine(line) {
  return line;
}

// Return costUsd only if the CLI reports it; otherwise leave it out and
// the cost is estimated from usage and pricing.yaml (or 'unknown').
export function parse(stdout) {
  return { output: stdout, usage: null };
}
