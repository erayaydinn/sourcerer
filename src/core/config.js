import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';
import { z } from 'zod';
import { interpolate } from './env.js';
import { factoryConfig } from './schemas.js';

// The installed package: its config/ and agents/ are the defaults every workspace starts from.
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// A workspace holds only your choices in this file, plus .env, runs/ and worktrees/.
export const WORKSPACE_FILE = 'sourcerer.yaml';

// Environment variables that override settings. Precedence: --llm > env > sourcerer.yaml > package.
export const ENV_SETTINGS = [
  ['SOURCERER_FRONTEND', ['repos', 'frontend', 'path']],
  ['SOURCERER_BACKEND', ['repos', 'backend', 'path']],
  ['SOURCERER_MAX_COST_PER_RUN', ['budget', 'maxCostPerRun']],
  ['SOURCERER_MAX_COST_PER_AGENT', ['budget', 'maxCostPerAgent']],
  ['SOURCERER_MAX_TOKENS_PER_RUN', ['budget', 'maxTokensPerRun']],
  ['SOURCERER_MAX_TOKENS_PER_AGENT', ['budget', 'maxTokensPerAgent']],
  ['SOURCERER_MAX_ROUNDS', ['review', 'maxRounds']],
];

const SECTIONS = ['repos', 'paths', 'budget', 'review', 'rag', 'security', 'tools', 'llms', 'agents', 'pricing'];

// Parsed YAML with ${VAR} / ${VAR:-default} filled from the environment.
export function readYamlData(file) {
  const missing = [];
  const data = interpolate(parse(readFileSync(file, 'utf8')), process.env, missing);
  if (missing.length) throw new Error(`${file}: environment variable not set: ${missing.join(', ')} (set it in .env)`);
  return data;
}

export function readYaml(file, schema) {
  const result = schema.safeParse(readYamlData(file));
  if (!result.success) throw new Error(`${file}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

// Values this process took from a .env file, so a later load (REPL, another root) can replace them.
const fromEnvFile = new Set();

// Shell variables win over .env. Values that came from a .env are refreshed on every load.
export function loadEnv(rootDir) {
  const file = resolve(rootDir, '.env');
  const values = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  for (const name of fromEnvFile) {
    if (!(name in values)) {
      delete process.env[name];
      fromEnvFile.delete(name);
    }
  }
  for (const [name, value] of Object.entries(values)) {
    if (name in process.env && !fromEnvFile.has(name)) continue;
    process.env[name] = value;
    fromEnvFile.add(name);
  }
}

// The old layout kept full copies of config/ and agents/ in the workspace.
export function isLegacyWorkspace(dir) {
  if (!existsSync(join(dir, 'config', 'factory.config.yaml'))) return false;
  return realpathSync(dir) !== realpathSync(PACKAGE_DIR);
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Objects merge key by key; arrays and scalars replace.
export function deepMerge(base, extra) {
  if (extra === undefined) return structuredClone(base);
  if (!isObject(base) || !isObject(extra)) return structuredClone(extra);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) out[key] = key in out ? deepMerge(out[key], value) : structuredClone(value);
  }
  return out;
}

// Package defaults + the workspace's sourcerer.yaml, before env overrides and validation.
// LLM profiles and prices replace by name; everything else merges.
export function loadSettings(rootDir) {
  const base = readYamlData(join(PACKAGE_DIR, 'config', 'factory.config.yaml'));
  const file = join(rootDir, WORKSPACE_FILE);
  const user = (existsSync(file) ? readYamlData(file) : null) ?? {};
  const unknown = Object.keys(user).filter((key) => !SECTIONS.includes(key));
  if (unknown.length) throw new Error(`${file}: unknown section(s) ${unknown.join(', ')} (allowed: ${SECTIONS.join(', ')})`);
  const merged = deepMerge(base, { ...user, llms: undefined, pricing: undefined });
  merged.llms = { ...base.llms, ...user.llms };
  merged.pricing = { ...base.pricing, ...user.pricing };
  return { merged, user, base };
}

function setPath(target, path, value) {
  let node = target;
  for (const key of path.slice(0, -1)) node = node[key] = isObject(node[key]) ? node[key] : {};
  node[path.at(-1)] = value;
}

// allowMissingRepos: for commands that only look at profiles/agents (models, use, agents) before
// repo paths are set; missing paths then point at the workspace itself.
export function loadConfig(rootDir, { allowMissingRepos = false } = {}) {
  loadEnv(rootDir);
  if (isLegacyWorkspace(rootDir)) {
    throw new Error(`${rootDir} uses the old layout (full copies of config/ and agents/). Run \`sourcerer migrate\` to keep only your changes in ${WORKSPACE_FILE}.`);
  }
  const { merged } = loadSettings(rootDir);
  for (const [name, path] of ENV_SETTINGS) if (process.env[name]) setPath(merged, path, process.env[name]);
  for (const side of ['frontend', 'backend']) {
    if (!merged.repos?.[side]?.path && allowMissingRepos) merged.repos[side].path = rootDir;
    if (!merged.repos?.[side]?.path) {
      throw new Error(`the ${side} repo path is not set: add SOURCERER_${side.toUpperCase()} to ${join(rootDir, '.env')} (or run \`sourcerer setup\`)`);
    }
  }
  const result = factoryConfig.safeParse(merged);
  if (!result.success) throw new Error(`config (package defaults + ${join(rootDir, WORKSPACE_FILE)}):\n${z.prettifyError(result.error)}`);
  const config = result.data;
  for (const repo of Object.values(config.repos)) repo.path = resolve(rootDir, repo.path);
  for (const key of ['runs', 'worktrees']) config.paths[key] = resolve(rootDir, config.paths[key]);
  return config;
}
