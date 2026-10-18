import { createAgent } from '../core/factory.js';
import { loadProject, reportProblems } from './project.js';

export function validateCommand({ root, llm }, print) {
  const project = loadProject(root, llm);
  if (!reportProblems(project, print)) return 1;
  for (const agent of project.defs.map((def) => createAgent(def, project.config))) {
    print(`${agent.name} (${agent.role}) -> ${agent.llm}: ${agent.profile.provider}/${agent.model}`);
  }
  return 0;
}
