import { createInterface } from 'node:readline/promises';
import { execa } from 'execa';
import { CLI_BINS } from '../adapters/cli.js';
import { WORKSPACE_FILE, loadSettings } from '../core/config.js';
import { toolVersion } from './doctor.js';
import { loadProject, table } from './project.js';
import { deleteIn, editWorkspace } from './workspace-file.js';

const API_TYPES = ['openai-compat', 'anthropic'];
// Sensible defaults per kind; edit sourcerer.yaml to change them.
const CAPABILITIES = {
  claude: { editsFiles: true, toolUse: true, jsonOutput: true, reportsCost: true },
  'cursor-agent': { editsFiles: true, toolUse: true, jsonOutput: true },
  'openai-compat': { toolUse: true, jsonOutput: true },
  anthropic: { editsFiles: true, toolUse: true, jsonOutput: true },
};
const KNOWN_PROVIDER = { claude: 'anthropic', anthropic: 'anthropic' };

const kindOf = (profile) => (profile.type === 'cli' ? profile.bin : profile.type);

// Profiles from the package and sourcerer.yaml, with who uses them.
export async function modelsListCommand({ root }, print) {
  const { defs, config } = loadProject(root, [], { allowMissingRepos: true });
  const { user } = loadSettings(root);
  const rows = [];
  for (const [name, profile] of Object.entries(config.llms)) {
    const installed = profile.type === 'cli' ? ((await toolVersion(profile.bin)) ? 'yes' : 'NO') : 'api';
    const users = defs.flatMap((def) => [def.llm === name ? def.name : null, def.fallbackLlm === name ? `${def.name} (fallback)` : null]).filter(Boolean);
    rows.push([name, kindOf(profile), profile.provider, profile.model, user.llms?.[name] ? WORKSPACE_FILE : 'package', installed, users.join(', ') || '-']);
  }
  table([['PROFILE', 'KIND', 'PROVIDER', 'MODEL', 'FROM', 'INSTALLED', 'USED BY'], ...rows], print);
  return 0;
}

// Adds (or replaces) a profile in sourcerer.yaml. Missing values are asked for when interactive.
// The model name is always typed by the user; for cursor-agent its own model list is shown.
export async function modelsAddCommand(name, options, print, ask = interactiveAsk()) {
  const question = async (label, fallback) => {
    if (!ask) throw new Error(`missing ${label}: pass it as a flag (see \`sourcerer models add --help\`)`);
    return (await ask(`${label}${fallback ? ` [${fallback}]` : ''}: `)) || fallback || '';
  };
  try {
    const { config } = loadProject(options.root, [], { allowMissingRepos: true });
    const profileName = name || await question('profile name');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(profileName)) throw new Error(`profile name "${profileName}" should be lowercase letters, digits and dashes`);

    const kind = options.cli ?? options.api ?? await question(`kind (${[...CLI_BINS, ...API_TYPES].join(', ')})`);
    if (!CLI_BINS.includes(kind) && !API_TYPES.includes(kind)) throw new Error(`unknown kind "${kind}": CLIs with an adapter are ${CLI_BINS.join(', ')}; APIs are ${API_TYPES.join(', ')}`);

    if (kind === 'cursor-agent' && !options.model && ask) await showCursorModels(print);
    if (kind === 'claude' && !options.model && ask) print('claude takes the aliases listed under --model in `claude --help` (e.g. opus, sonnet) or a full model name.');
    const model = options.model ?? await question('model (type the exact name)');
    if (!model) throw new Error('a model name is required');
    const provider = options.provider ?? await question('provider (the vendor behind the model, e.g. anthropic, openai, xai)', KNOWN_PROVIDER[kind]);
    if (!provider) throw new Error('a provider is required');

    const profile = CLI_BINS.includes(kind) ? { type: 'cli', bin: kind, provider, model } : { type: kind, provider, model };
    if (kind === 'openai-compat') profile.baseURL = options.baseUrl ?? await question('baseURL (e.g. https://api.openai.com/v1)');
    if (API_TYPES.includes(kind)) {
      const keyEnv = options.keyEnv ?? (ask ? await question('env variable with the API key (empty for none)') : undefined);
      if (keyEnv) profile.keyEnv = keyEnv;
      const max = options.maxOutputTokens ?? (kind === 'anthropic' ? await question('maxOutputTokens') : undefined);
      if (max) profile.maxOutputTokens = Number(max);
    }
    profile.capabilities = CAPABILITIES[kind];

    if (config.llms[profileName] && !options.force) {
      const answer = ask ? await ask(`profile "${profileName}" exists; replace it? [y/N] `) : '';
      if (answer.toLowerCase() !== 'y') throw new Error(`profile "${profileName}" exists (use --force to replace it)`);
    }
    editWorkspace(options.root, (doc) => doc.setIn(['llms', profileName], doc.createNode(profile)));
    print(`saved profile ${profileName} (${kind}, ${provider}/${model}) in ${WORKSPACE_FILE}`);
    print(`capabilities: ${Object.keys(profile.capabilities).join(', ')} (edit ${WORKSPACE_FILE} to change)`);
    print(`use it: sourcerer use <agent|role> ${profileName}`);
    return 0;
  } finally {
    ask?.close?.();
  }
}

export function modelsRemoveCommand(name, { root }, print) {
  const { user } = loadSettings(root);
  if (!user.llms?.[name]) {
    throw new Error(`"${name}" is not defined in ${WORKSPACE_FILE}${loadSettings(root).base.llms?.[name] ? ' (it is a package profile; you can override it but not remove it)' : ''}`);
  }
  const { defs } = loadProject(root, [], { allowMissingRepos: true });
  const users = defs.filter((def) => def.llm === name || def.fallbackLlm === name).map((def) => def.name);
  if (users.length) throw new Error(`"${name}" is used by ${users.join(', ')}: point them elsewhere first (sourcerer use)`);
  editWorkspace(root, (doc) => deleteIn(doc, ['llms', name]));
  print(`removed profile ${name}`);
  return 0;
}

async function showCursorModels(print) {
  const result = await execa('cursor-agent', ['models'], { reject: false, timeout: 30_000, all: true });
  const lines = (result.all ?? '').split('\n').filter((line) => / - /.test(line));
  if (lines.length) print(`cursor-agent models on this account:\n${lines.map((line) => `  ${line.trim()}`).join('\n')}`);
}

function interactiveAsk() {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (text) => (await rl.question(text)).trim();
  ask.close = () => rl.close();
  return ask;
}
