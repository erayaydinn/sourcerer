import { WORKSPACE_FILE } from '../core/config.js';
import { createAgent } from '../core/factory.js';
import { loadProject, table } from './project.js';
import { deleteIn, editWorkspace } from './workspace-file.js';

// Which profile and model each agent uses, and where each value comes from.
export function agentsCommand({ root }, print) {
  const { defs, config } = loadProject(root, [], { allowMissingRepos: true });
  const rows = defs.map((def) => {
    const agent = createAgent(def, config);
    const modelFrom = def.sources?.model ?? 'profile';
    return [def.name, def.role, def.llm, def.sources?.llm ?? '-', agent.model, modelFrom, def.fallbackLlm ?? '-'];
  });
  table([['AGENT', 'ROLE', 'PROFILE', 'FROM', 'MODEL', 'FROM', 'FALLBACK'], ...rows], print);
  return 0;
}

// Saves an agent's (or a whole role's) profile/model/fallback in sourcerer.yaml.
// Without --model the per-agent model is cleared: it belonged to the previous profile.
export function useCommand(target, profile, { root, model, fallback }, print) {
  const { defs, config } = loadProject(root, [], { allowMissingRepos: true });
  const targets = defs.filter((def) => def.name === target || def.role === target);
  if (!targets.length) throw new Error(`no agent or role "${target}" (agents: ${defs.map((d) => d.name).join(', ')}; roles: planner, coder, reviewer)`);
  for (const name of [profile, fallback].filter(Boolean)) {
    if (!config.llms[name]) throw new Error(`unknown profile "${name}" (see \`sourcerer models\`, or add one with \`sourcerer models add\`)`);
  }
  const project = editWorkspace(root, (doc) => {
    for (const def of targets) {
      doc.setIn(['agents', def.name, 'llm'], profile);
      if (model) doc.setIn(['agents', def.name, 'model'], model);
      else deleteIn(doc, ['agents', def.name, 'model']);
      if (fallback) doc.setIn(['agents', def.name, 'fallbackLlm'], fallback);
    }
  });
  for (const def of targets) {
    const now = project.defs.find((d) => d.name === def.name);
    const agent = createAgent(now, project.config);
    print(`${def.name} -> ${now.llm} (${agent.model})${now.fallbackLlm ? `, fallback ${now.fallbackLlm}` : ''}`);
    for (const kind of ['llm', 'model']) {
      const source = now.sources?.[kind];
      if (source?.startsWith('SOURCERER_')) print(`  note: ${source} is set in .env or the shell and overrides this; remove it to use ${WORKSPACE_FILE}`);
    }
  }
  for (const warning of project.warnings) print(`warning: ${warning}`);
  return 0;
}
