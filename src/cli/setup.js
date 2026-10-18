import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseEnv } from 'node:util';
import { execa } from 'execa';
import { parse } from 'yaml';
import { WORKSPACE_FILE, isLegacyWorkspace, loadSettings } from '../core/config.js';
import { doctorCommand, isGitRepo, toolVersion } from './doctor.js';
import { initCommand } from './init.js';
import { PACKAGE_DIR, defaultWorkspace, resolveRoot } from './root.js';
import { deleteIn, editWorkspace } from './workspace-file.js';

const ROLES = ['planner', 'coder', 'reviewer'];

// [label, config path, whole numbers only, optional]
const LIMITS = [
  ['max cost per run (USD)', ['budget', 'maxCostPerRun'], false, false],
  ['max cost per agent (USD)', ['budget', 'maxCostPerAgent'], false, false],
  ['max rounds (coder passes per task)', ['review', 'maxRounds'], true, false],
  ['max tokens per run (input + output)', ['budget', 'maxTokensPerRun'], true, true],
  ['max tokens per agent (input + output)', ['budget', 'maxTokensPerAgent'], true, true],
];

// Interactive and safe to re-run: Enter keeps the value in brackets.
// Machine-specific values (repo paths, key names) go to .env; choices (roles, limits) to sourcerer.yaml.
export async function setupCommand({ root: flag, refresh }, print, ask) {
  const rl = ask ? null : createInterface({ input: process.stdin, output: process.stdout });
  const question = ask ?? (async (text) => (await rl.question(text)).trim());
  try {
    const root = workspaceFor(flag);
    if (isLegacyWorkspace(root)) {
      print(`${root} uses the old layout: run \`sourcerer migrate\` first, then setup again.`);
      return 1;
    }
    const changes = [];
    if (!existsSync(join(root, WORKSPACE_FILE))) {
      initCommand(root, {}, print);
      changes.push(`${WORKSPACE_FILE} created`);
    }
    const env = envFile(join(root, '.env'), changes);
    privatePermissions(root, changes);

    print('\nRepos (saved in .env)');
    for (const side of ['frontend', 'backend']) await askRepo(side, env, question, print);

    const { merged, user } = loadSettings(root);
    const llms = merged.llms;
    const installed = await detectBins(llms);
    print('\nLLM profiles (package + sourcerer.yaml; add more with `sourcerer models add`):');
    for (const [name, p] of Object.entries(llms)) {
      const where = p.type === 'cli' ? `${p.bin}, ${installed.has(p.bin) ? 'installed' : 'NOT installed'}` : p.type;
      print(`  ${name.padEnd(16)} ${where.padEnd(28)} ${p.provider}/${p.model}`);
    }

    const edits = [];
    const chosen = [];
    print(`\nRoles (saved in ${WORKSPACE_FILE}; per agent: \`sourcerer use <agent> <profile>\`)`);
    for (const role of ROLES) chosen.push(await askRole(role, root, merged, llms, question, print, edits));

    print(`\nLimits (saved in ${WORKSPACE_FILE})`);
    for (const limit of LIMITS) await askLimit(limit, merged, user, question, print, edits);

    if (edits.length) {
      editWorkspace(root, (doc) => {
        for (const { path, value } of edits) {
          if (value === undefined) deleteIn(doc, path);
          else doc.setIn(path, value);
        }
      });
      changes.push(...edits.map(({ path }) => `${WORKSPACE_FILE} ${path.join('.')}`));
    }

    for (const { profile } of chosen) {
      const keyEnv = llms[profile].keyEnv;
      if (keyEnv && !(keyEnv in env.read())) env.set(keyEnv, '');
      if (keyEnv) print(`  ${profile} needs ${keyEnv}: type the key into ${env.file} yourself`);
    }

    await gitignore(root, changes, print);
    await saveCliHelp(root, installed, refresh, changes);
    pricingRows(root, chosen, llms, loadSettings(root).merged.pricing, changes, print);

    print(`\nChanged:${changes.length ? '' : ' nothing'}`);
    for (const change of changes) print(`  ${change}`);
    print('\nDoctor:');
    return doctorCommand({ root }, print);
  } finally {
    rl?.close();
  }
}

// Only you can read the workspace (runs, index and prompts hold code) and .env (keys).
function privatePermissions(root, changes) {
  for (const [path, mode] of [[root, 0o700], [join(root, '.env'), 0o600]]) {
    if (existsSync(path) && (statSync(path).mode & 0o077)) {
      chmodSync(path, mode);
      changes.push(`permissions ${mode.toString(8)} on ${path === root ? 'the workspace' : '.env'}`);
    }
  }
}

function workspaceFor(flag) {
  if (flag) return resolve(flag);
  if (process.env.SOURCERER_ROOT) return resolve(process.env.SOURCERER_ROOT);
  try {
    return resolveRoot();
  } catch {
    return defaultWorkspace();
  }
}

// Line-based .env editing that keeps comments. Only names are ever reported, never values.
function envFile(file, changes) {
  if (!existsSync(file)) {
    copyFileSync(join(PACKAGE_DIR, '.env.example'), file);
    chmodSync(file, 0o600);
    changes.push('.env created from .env.example');
  }
  return {
    file,
    read: () => parseEnv(readFileSync(file, 'utf8')),
    set(name, value) {
      const text = readFileSync(file, 'utf8');
      const line = new RegExp(`^${name}=.*$`, 'm');
      const next = line.test(text) ? text.replace(line, `${name}=${value}`) : `${text.replace(/\n?$/, '\n')}${name}=${value}\n`;
      writeFileSync(file, next);
      changes.push(`.env ${name}`);
    },
  };
}

async function askRepo(side, env, question, print) {
  const name = `SOURCERER_${side.toUpperCase()}`;
  let current = env.read()[name] ?? '';
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await question(`${side} repo path${current ? ` [${current}]` : ''}: `)) || current;
    if (!answer) {
      print(`  skipped ${name}`);
      return;
    }
    const path = resolve(answer.replace(/^~(?=\/|$)/, homedir()));
    if (await isGitRepo(path)) {
      if (path !== current) env.set(name, path);
      return;
    }
    print(`  ${path}: ${existsSync(path) ? 'not a git repo' : 'does not exist'}`);
    if (answer === current) current = '';
  }
}

async function detectBins(llms) {
  const bins = new Set(Object.values(llms).filter((p) => p.type === 'cli').map((p) => p.bin));
  const installed = new Set();
  for (const bin of bins) if (await toolVersion(bin)) installed.add(bin);
  return installed;
}

// Agents of a role and the profile they use now: sourcerer.yaml choice, else the package agent default.
function roleAgents(role, root, merged) {
  const dirs = [join(PACKAGE_DIR, 'agents'), join(root, 'agents')];
  const agents = new Map();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.yaml')).sort()) {
      const def = parse(readFileSync(join(dir, file), 'utf8'));
      if (def.role === role) agents.set(def.name, def);
    }
  }
  return [...agents.values()].map((def) => ({ name: def.name, llm: merged.agents?.[def.name]?.llm ?? def.llm, model: merged.agents?.[def.name]?.model }));
}

async function askRole(role, root, merged, llms, question, print, edits) {
  const agents = roleAgents(role, root, merged);
  const current = agents[0]?.llm;
  const envName = `SOURCERER_${role.toUpperCase()}_LLM`;
  if (process.env[envName]) print(`  note: ${envName}=${process.env[envName]} in .env or the shell overrides this choice`);
  let profile = current;
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await question(`${role} profile [${current}]: `)) || current;
    if (!llms[answer]) {
      print(`  unknown profile "${answer}" (choose one listed above)`);
      continue;
    }
    if (role === 'coder' && !llms[answer].capabilities?.editsFiles) {
      print(`  "${answer}" cannot edit files, so it cannot be a coder`);
      continue;
    }
    profile = answer;
    break;
  }
  // The model is typed by the user; Enter keeps the current one. No suggestions.
  const currentModel = agents[0]?.model ?? '';
  const keep = currentModel ? `keeps ${currentModel}` : `keeps the profile's configured model (${llms[profile].model})`;
  const model = await question(`${role} model (Enter ${keep}): `);
  for (const agent of agents) {
    if (profile !== agent.llm) {
      edits.push({ path: ['agents', agent.name, 'llm'], value: profile });
      if (!model && agent.model) edits.push({ path: ['agents', agent.name, 'model'], value: undefined });
    }
    if (model && model !== agent.model) edits.push({ path: ['agents', agent.name, 'model'], value: model });
  }
  return { role, profile, model: model || (profile === current ? currentModel : '') || llms[profile].model };
}

async function askLimit([label, path, whole, optional], merged, user, question, print, edits) {
  const current = path.reduce((node, key) => node?.[key], merged);
  const fromUser = path.reduce((node, key) => node?.[key], user);
  const shown = current ?? 'no limit';
  for (let tries = 0; tries < 3; tries++) {
    const answer = await question(`${label}${optional ? ', none = no limit' : ''} [${shown}]: `);
    if (!answer || answer === String(shown)) return;
    if (answer === 'none' && optional) {
      if (fromUser !== undefined) edits.push({ path, value: undefined });
      return;
    }
    const value = Number(answer);
    const valid = whole ? Number.isInteger(value) && value >= 1 : Number.isFinite(value) && value > 0;
    if (valid) return edits.push({ path, value });
    print(`  "${answer}" is not ${whole ? 'a whole number of at least 1' : 'a positive number'}`);
  }
}

async function gitignore(root, changes, print) {
  if (!(await isGitRepo(root))) {
    print('\n.gitignore: workspace is not a git repo, skipped');
    return;
  }
  for (const [path, line] of [['.env', '.env'], ['runs/x', 'runs/'], ['worktrees/x', 'worktrees/'], [WORKSPACE_FILE, WORKSPACE_FILE]]) {
    const ignored = (await execa('git', ['-C', root, 'check-ignore', '-q', path], { reject: false })).exitCode === 0;
    if (ignored) continue;
    const file = join(root, '.gitignore');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
    changes.push(`.gitignore + ${line}`);
  }
}

async function saveCliHelp(root, installed, refresh, changes) {
  for (const bin of installed) {
    const file = join(root, 'docs', 'cli-help', `${bin}.txt`);
    if (existsSync(file) && !refresh) continue;
    const help = await execa(bin, ['--help'], { reject: false, all: true, timeout: 30_000 });
    mkdirSync(join(root, 'docs', 'cli-help'), { recursive: true });
    writeFileSync(file, `${help.all ?? ''}\n`);
    changes.push(`docs/cli-help/${bin}.txt`);
  }
}

// Commented price rows for chosen models whose CLI/API does not report cost. Prices are typed by the user.
function pricingRows(root, chosen, llms, priced, changes, print) {
  const file = join(root, WORKSPACE_FILE);
  const text = readFileSync(file, 'utf8');
  const needed = [...new Set(chosen.filter((c) => !llms[c.profile].capabilities?.reportsCost).map((c) => c.model))]
    .filter((model) => !priced?.[model]);
  if (!needed.length) return;
  const rows = needed.filter((model) => !text.includes(`#   ${model}:`));
  if (rows.length && !/^pricing:/m.test(text)) {
    const header = text.includes('# pricing:  (fill in') ? '' : '\n# pricing:  (fill in USD per 1M tokens from the provider\'s pricing page, then uncomment)\n';
    appendFileSync(file, `${header}${rows.map((model) => `#   ${model}: { input: , output: , cachedInput: }\n`).join('')}`);
    changes.push(...rows.map((model) => `${WORKSPACE_FILE} pricing row for ${model} (commented)`));
  }
  print(`\nPricing: ${needed.join(', ')} report no cost; add prices under pricing: in ${file}, or cost stays "unknown".`);
}
