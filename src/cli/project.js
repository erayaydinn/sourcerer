import { loadConfig, loadEnv } from '../core/config.js';
import { applyLlmOverrides, loadAgents, validate } from '../core/factory.js';

// Loads config + agents (with --llm overrides) and validates them.
export function loadProject(root, llmPairs = []) {
  loadEnv(root);
  const config = loadConfig(root);
  const defs = applyLlmOverrides(loadAgents(config.paths.agents), llmPairs);
  return { config, defs, ...validate(defs, config) };
}

// Prints warnings and errors; returns false if there were errors.
export function reportProblems({ errors, warnings }, print) {
  for (const warning of warnings) print(`warning: ${warning}`);
  for (const error of errors) print(`error: ${error}`);
  return errors.length === 0;
}

export function table(rows, print) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => String(row[i]).length)));
  for (const row of rows) print(row.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd());
}

export const usd = (n) => `$${n.toFixed(4)}`;
