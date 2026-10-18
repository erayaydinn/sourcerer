import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseEnv } from 'node:util';
import { execa } from 'execa';
import { parse } from 'yaml';
import { doctorCommand, isGitRepo, toolVersion } from './doctor.js';
import { initCommand } from './init.js';
import { PACKAGE_DIR, defaultWorkspace, resolveRoot } from './root.js';

// [role, env name part, agent file whose `llm:` holds the default]
const ROLES = [['planner', 'PLANNER', 'planner.yaml'], ['coder', 'CODER', 'coder-backend.yaml'], ['reviewer', 'REVIEWER', 'reviewer.yaml']];

// [label, env name, config section, config key, whole numbers only]
const LIMITS = [
  ['max cost per run (USD)', 'SOURCERER_MAX_COST_PER_RUN', 'budget', 'maxCostPerRun', false],
  ['max cost per agent (USD)', 'SOURCERER_MAX_COST_PER_AGENT', 'budget', 'maxCostPerAgent', false],
  ['max rounds (coder passes per task)', 'SOURCERER_MAX_ROUNDS', 'review', 'maxRounds', true],
  ['max tokens per run (input + output, empty = no limit)', 'SOURCERER_MAX_TOKENS_PER_RUN', 'budget', 'maxTokensPerRun', true],
  ['max tokens per agent (input + output, empty = no limit)', 'SOURCERER_MAX_TOKENS_PER_AGENT', 'budget', 'maxTokensPerAgent', true],
];

// Interactive and safe to re-run: fills in only what is missing, Enter keeps the current value.
// Writes .env (never key values), appends .gitignore, saves CLI help, adds commented pricing rows.
export async function setupCommand({ root: flag, refresh }, print, ask) {
  const rl = ask ? null : createInterface({ input: process.stdin, output: process.stdout });
  const question = ask ?? (async (text) => (await rl.question(text)).trim());
  try {
    const root = workspaceFor(flag);
    const changes = [];
    if (!existsSync(join(root, 'config', 'factory.config.yaml'))) {
      initCommand(root, {}, print);
      changes.push('workspace created from the package templates');
    }
    const env = envFile(join(root, '.env'), changes);

    print('\nRepos');
    for (const side of ['frontend', 'backend']) await askRepo(side, env, question, print);

    const rawConfig = parse(readFileSync(join(root, 'config', 'factory.config.yaml'), 'utf8'));
    const llms = rawConfig.llms;
    const installed = await detectBins(llms);
    print('\nLLM profiles (from config/factory.config.yaml):');
    for (const [name, p] of Object.entries(llms)) {
      const where = p.type === 'cli' ? `${p.bin}, ${installed.has(p.bin) ? 'installed' : 'NOT installed'}` : p.type;
      print(`  ${name.padEnd(16)} ${where}`);
    }
    const chosen = [];
    for (const [role, key, file] of ROLES) {
      chosen.push(await askRole(role, key, roleDefault(join(root, 'agents', file), key), llms, env, question, print));
    }

    print('\nLimits (Enter keeps the value in brackets)');
    for (const limit of LIMITS) await askLimit(limit, rawConfig, env, question, print);

    for (const { profile } of chosen) {
      const keyEnv = llms[profile].keyEnv;
      if (keyEnv && !(keyEnv in env.read())) env.set(keyEnv, '');
      if (keyEnv) print(`  ${profile} needs ${keyEnv}: type the key into ${env.file} yourself`);
    }

    await gitignore(root, changes, print);
    await saveCliHelp(root, llms, installed, refresh, changes);
    pricingRows(join(root, 'config', 'pricing.yaml'), chosen, llms, changes, print);

    print(`\nChanged:${changes.length ? '' : ' nothing'}`);
    for (const change of changes) print(`  ${change}`);
    print('\nDoctor:');
    return doctorCommand({ root }, print);
  } finally {
    rl?.close();
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

// The agent YAML default from `llm: ${SOURCERER_X_LLM:-name}` (or a plain `llm: name`).
function roleDefault(agentFile, key) {
  const llm = parse(readFileSync(agentFile, 'utf8')).llm ?? '';
  return llm.match(new RegExp(`\\$\\{SOURCERER_${key}_LLM:-([^}]*)\\}`))?.[1] ?? llm;
}

async function askRole(role, key, yamlDefault, llms, env, question, print) {
  const llmName = `SOURCERER_${key}_LLM`;
  const modelName = `SOURCERER_${key}_MODEL`;
  const values = env.read();
  const currentProfile = values[llmName] || yamlDefault;
  let profile = currentProfile;
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await question(`${role} profile [${currentProfile}]: `)) || currentProfile;
    if (llms[answer]) {
      profile = answer;
      break;
    }
    print(`  unknown profile "${answer}" (choose one listed above)`);
  }
  if (profile !== currentProfile) env.set(llmName, profile);

  // The model is typed by the user; Enter keeps the current one. No suggestions.
  const currentModel = values[modelName] || '';
  const keep = currentModel ? `keeps ${currentModel}` : `keeps the profile's configured model (${llms[profile].model})`;
  const model = await question(`${role} model (Enter ${keep}): `);
  if (model && model !== currentModel) env.set(modelName, model);
  return { role, profile, model: model || currentModel || llms[profile].model };
}

// The config value is `${NAME:-default}` (or a plain number); .env wins when it is set.
async function askLimit([label, name, section, key, whole], rawConfig, env, question, print) {
  const raw = String(rawConfig[section]?.[key] ?? '');
  const fallback = raw.match(new RegExp(`\\$\\{${name}:-([^}]*)\\}`))?.[1] ?? raw;
  const current = env.read()[name] || '';
  const shown = current || fallback || 'no limit';
  for (let tries = 0; tries < 3; tries++) {
    const answer = await question(`${label} [${shown}]: `);
    if (!answer || answer === shown) return;
    if (answer === 'none' && current) return env.set(name, ''); // remove an optional limit
    const value = Number(answer);
    const valid = whole ? Number.isInteger(value) && value >= 1 : Number.isFinite(value) && value > 0;
    if (valid) return env.set(name, answer);
    print(`  "${answer}" is not ${whole ? 'a whole number of at least 1' : 'a positive number'}`);
  }
}

async function gitignore(root, changes, print) {
  if (!(await isGitRepo(root))) {
    print('\n.gitignore: workspace is not a git repo, skipped');
    return;
  }
  for (const [path, line] of [['.env', '.env'], ['runs/x', 'runs/']]) {
    const ignored = (await execa('git', ['-C', root, 'check-ignore', '-q', path], { reject: false })).exitCode === 0;
    if (ignored) continue;
    const file = join(root, '.gitignore');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
    changes.push(`.gitignore + ${line}`);
  }
}

async function saveCliHelp(root, llms, installed, refresh, changes) {
  for (const bin of installed) {
    const file = join(root, 'docs', 'cli-help', `${bin}.txt`);
    if (existsSync(file) && !refresh) continue;
    const help = await execa(bin, ['--help'], { reject: false, all: true, timeout: 30_000 });
    mkdirSync(join(root, 'docs', 'cli-help'), { recursive: true });
    writeFileSync(file, `${help.all ?? ''}\n`);
    changes.push(`docs/cli-help/${bin}.txt`);
  }
}

// Commented rows for models whose CLI/API does not report cost. Prices are typed in by the user.
function pricingRows(file, chosen, llms, changes, print) {
  let text = readFileSync(file, 'utf8');
  if (/^models:\s*\{\s*\}\s*$/m.test(text)) {
    text = text.replace(/^models:\s*\{\s*\}\s*$/m, 'models:');
    writeFileSync(file, text);
  }
  const priced = parse(text)?.models ?? {};
  const needed = [...new Set(chosen.filter((c) => !llms[c.profile].capabilities?.reportsCost).map((c) => c.model))];
  const rows = needed.filter((model) => !priced[model] && !text.includes(`#  ${model}:`));
  for (const model of rows) {
    appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}#  ${model}: { input: , output: , cachedInput: }   # USD per 1M tokens\n`);
    text = readFileSync(file, 'utf8');
    changes.push(`config/pricing.yaml row for ${model} (commented)`);
  }
  const missing = needed.filter((model) => !priced[model]);
  if (missing.length) print(`\nPricing: fill in ${missing.join(', ')} in ${file} from the providers' pricing pages, then uncomment.`);
}
