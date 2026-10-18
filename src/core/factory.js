import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readYaml } from './config.js';
import { agentDef } from './schemas.js';

const WRITE_TOOLS = ['write_file', 'run_command'];

export function loadAgents(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yaml'))
    .sort()
    .map((file) => readYaml(join(dir, file), agentDef));
}

export function validate(defs, config) {
  const errors = [];
  const warnings = [];
  const names = new Set();

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

  for (const [name, profile] of Object.entries(config.llms)) {
    if ('keyEnv' in profile && profile.keyEnv && !process.env[profile.keyEnv]) {
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
    return match ? { ...def, llm: match.profile, model: undefined } : def;
  });
}
