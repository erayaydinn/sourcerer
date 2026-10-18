import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WORKSPACE_FILE, isLegacyWorkspace } from '../core/config.js';
import { PACKAGE_DIR, defaultWorkspace } from './root.js';

export const WORKSPACE_TEMPLATE = `# Your Sourcerer settings: only what differs from the package defaults.
# Prompts, default profiles and limits come from the installed package, so updates reach you.
# Precedence: --llm > .env / shell variables > this file > package defaults.
# Edit by hand, or with: sourcerer models add | sourcerer use <agent|role> <profile> | sourcerer setup
#
# llms:      extra or replaced LLM profiles (see \`sourcerer models\`)
# agents:    per agent: { llm, model, fallbackLlm } (see \`sourcerer agents\`)
# repos:     per side: { base, setup, test, docs } (paths usually go in .env)
# budget:    maxCostPerRun, maxCostPerAgent, maxTokensPerRun, maxTokensPerAgent
# review:    maxRounds
# pricing:   <model>: { input, output, cachedInput }  (USD per 1M tokens)
`;

// Creates a workspace: sourcerer.yaml (your choices), .env and .env.example. Never overwrites.
// Target: [dir] > --root > SOURCERER_ROOT > ~/.config/sourcerer.
export function initCommand(dir, { root }, print) {
  const target = resolve(dir ?? root ?? process.env.SOURCERER_ROOT ?? defaultWorkspace());
  mkdirSync(target, { recursive: true });
  if (isLegacyWorkspace(target)) print(`note: ${target} has the old layout; run \`sourcerer migrate\` after this`);
  const files = [
    [WORKSPACE_FILE, () => writeFileSync(join(target, WORKSPACE_FILE), WORKSPACE_TEMPLATE)],
    ['.env.example', () => copyFileSync(join(PACKAGE_DIR, '.env.example'), join(target, '.env.example'))],
    ['.env', () => copyFileSync(join(PACKAGE_DIR, '.env.example'), join(target, '.env'))],
  ];
  for (const [name, create] of files) {
    if (existsSync(join(target, name))) {
      print(`skip   ${name} (exists)`);
      continue;
    }
    create();
    print(`create ${name}`);
  }
  print(`\nworkspace: ${target}`);
  print('next: set SOURCERER_FRONTEND and SOURCERER_BACKEND in .env (or run `sourcerer setup`), then `sourcerer validate`');
  return 0;
}
