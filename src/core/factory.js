import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_DIR, WORKSPACE_FILE, readYaml } from './config.js';
import { agentDef } from './schemas.js';
import { sandboxActive } from './sandbox.js';
import { UNCONFINED_BINS } from './security.js';

const WRITE_TOOLS = ['write_file', 'run_command'];
// Role variables override every agent of that role (above sourcerer.yaml, below --llm).
export const ROLE_ENV = { planner: 'PLANNER', coder: 'CODER', reviewer: 'REVIEWER' };

function readAgentDir(dir, source) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.yaml')).sort()
    .map((file) => ({ def: readYaml(join(dir, file), agentDef), source }));
}

// Package agents; a workspace agents/<name>.yaml replaces the agent of that name (or adds one);
// then sourcerer.yaml `agents:` choices; then SOURCERER_<ROLE>_LLM / _MODEL.
// Each def gets `sources` ({ llm, model }) saying where the value came from.
export function loadAgents(rootDir, config) {
  const byName = new Map();
  for (const { def, source } of [...readAgentDir(join(PACKAGE_DIR, 'agents'), 'package'), ...readAgentDir(join(rootDir, 'agents'), 'agents/')]) {
    byName.set(def.name, { ...def, sources: { llm: source, model: def.model ? source : null } });
  }
  for (const def of byName.values()) {
    const choice = config.agents?.[def.name] ?? {};
    if (choice.llm && choice.llm !== def.llm) Object.assign(def, { llm: choice.llm, model: undefined, sources: { llm: WORKSPACE_FILE, model: null } });
    if (choice.model) Object.assign(def, { model: choice.model, sources: { ...def.sources, model: WORKSPACE_FILE } });
    if (choice.fallbackLlm) def.fallbackLlm = choice.fallbackLlm;

    const key = ROLE_ENV[def.role];
    const envLlm = process.env[`SOURCERER_${key}_LLM`];
    const envModel = process.env[`SOURCERER_${key}_MODEL`];
    if (envLlm && envLlm !== def.llm) Object.assign(def, { llm: envLlm, model: undefined, sources: { llm: `SOURCERER_${key}_LLM`, model: null } });
    if (envModel) Object.assign(def, { model: envModel, sources: { ...def.sources, model: `SOURCERER_${key}_MODEL` } });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function validate(defs, config) {
  const errors = [];
  const warnings = [];
  const names = new Set();

  let sandboxed = false;
  try {
    sandboxed = sandboxActive(config.security);
  } catch (error) {
    errors.push(error.message);
  }
  for (const def of defs) {
    if (names.has(def.name)) errors.push(`duplicate agent name "${def.name}"`);
    names.add(def.name);

    for (const key of ['llm', 'fallbackLlm']) {
      const profileName = def[key];
      if (!profileName) continue;
      const profile = config.llms[profileName];
      if (!profile) errors.push(`${def.name}: unknown ${key} profile "${profileName}"`);
      else if (def.role === 'coder' && !profile.capabilities.editsFiles) {
        errors.push(`${def.name}: coder ${key} "${profileName}" has editsFiles: false`);
      }
    }

    // The OS sandbox confines any CLI; without it, CLIs that cannot limit themselves are refused.
    const strict = config.security && (config.security.commandAllowlist || config.security.confineFiles) && !config.security.trustUnconfinedCli && !sandboxed;
    for (const key of ['llm', 'fallbackLlm']) {
      const profile = config.llms[def[key]];
      if (strict && profile?.type === 'cli' && UNCONFINED_BINS.includes(profile.bin)) {
        errors.push(`${def.name}: ${key} "${def[key]}" uses ${profile.bin}, which cannot be limited to its folder or a command list `
          + '(it can read any file and run any command) and the sandbox is off. Turn on security.sandbox, use another profile, or set security.trustUnconfinedCli: true');
      }
    }

    if (def.role === 'coder' && !def.repo) errors.push(`${def.name}: coder needs a repo`);
    if (def.role === 'reviewer') {
      const bad = def.tools.filter((tool) => WRITE_TOOLS.includes(tool));
      if (bad.length) errors.push(`${def.name}: reviewer must be read-only, remove ${bad.join(', ')}`);
    }
  }

  const providerOf = (def) => config.llms[def.llm]?.provider;
  const coders = defs.filter((def) => def.role === 'coder');
  for (const reviewer of defs.filter((def) => def.role === 'reviewer')) {
    for (const coder of coders) {
      if (providerOf(reviewer) && providerOf(reviewer) === providerOf(coder)) {
        warnings.push(`${reviewer.name} and ${coder.name} both use provider "${providerOf(coder)}"`);
      }
    }
  }

  const used = new Set(defs.flatMap((def) => [def.llm, def.fallbackLlm].filter(Boolean)));
  for (const [name, profile] of Object.entries(config.llms)) {
    if (used.has(name) && 'keyEnv' in profile && profile.keyEnv && !process.env[profile.keyEnv]) {
      warnings.push(`llm "${name}": env var ${profile.keyEnv} is not set`);
    }
  }

  return { errors, warnings };
}

export function createAgent(def, config) {
  const profile = config.llms[def.llm];
  return {
    ...def,
    profile,
    model: def.model ?? profile.model,
    cwd: def.repo ? config.repos[def.repo].path : null,
    fallback: def.fallbackLlm ? config.llms[def.fallbackLlm] : null,
  };
}

// "--llm reviewer=gpt-api": the key is an agent name or a role; a name wins over a role.
// The agent's own model override is dropped because it belonged to the old profile.
export function applyLlmOverrides(defs, pairs) {
  const overrides = pairs.map((pair) => {
    const [key, profile, extra] = pair.split('=');
    if (!key || !profile || extra !== undefined) throw new Error(`--llm expects <role|agent>=<profile>, got "${pair}"`);
    if (!defs.some((def) => def.name === key || def.role === key)) throw new Error(`--llm: no agent or role named "${key}"`);
    return { key, profile };
  });
  return defs.map((def) => {
    const match = overrides.find((o) => o.key === def.name) ?? overrides.find((o) => o.key === def.role);
    return match ? { ...def, llm: match.profile, model: undefined, sources: { llm: '--llm', model: null } } : def;
  });
}
