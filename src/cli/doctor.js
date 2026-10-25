import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { createAgent } from '../core/factory.js';
import { readMeta } from '../rag/index.js';
import { sandboxActive, sandboxAvailable } from '../core/sandbox.js';
import { loadProject } from './project.js';
import { resolveRoot } from './root.js';
import { smokeCommand } from './smoke.js';

// Runs `<bin> <args>` and returns its first output line, or null if it is not installed / fails.
export async function toolVersion(bin, args = ['--version']) {
  const result = await execa(bin, args, { reject: false, timeout: 10_000, all: true });
  return result.exitCode === 0 ? (result.all ?? '').trim().split('\n')[0] : null;
}

export async function isGitRepo(dir) {
  if (!dir || !existsSync(dir)) return false;
  return (await execa('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { reject: false })).stdout === 'true';
}

const ok = (label) => ({ level: 'OK', label });
const warn = (label, hint) => ({ level: 'WARN', label, hint });
const fail = (label, hint) => ({ level: 'FAIL', label, hint });

// Every check, read-only. Values of environment variables are never included.
export async function runChecks(rootFlag) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(major >= 22 ? ok(`node ${process.versions.node}`) : fail(`node ${process.versions.node}`, 'install Node.js 22 or newer (e.g. `nvm install 22`)'));
  const git = await toolVersion('git');
  checks.push(git ? ok(git) : fail('git not found', 'install git'));
  const tmux = await toolVersion('tmux', ['-V']);
  const tmuxHint = process.platform === 'win32' ? 'tmux needs WSL on Windows' : 'install tmux (only needed for --tmux)';
  checks.push(tmux ? ok(tmux) : warn('tmux not found', tmuxHint));

  let root;
  try {
    root = resolveRoot({ flag: rootFlag });
    checks.push(ok(`workspace ${root}`));
  } catch {
    checks.push(fail('no workspace', 'run `sourcerer setup`'));
    return checks.concat(loginNote([]));
  }

  let project;
  try {
    project = loadProject(root);
  } catch (error) {
    checks.push(fail('config does not load', firstLine(error)));
    return checks.concat(loginNote([]));
  }
  const { config, defs, errors, warnings } = project;
  checks.push(errors.length ? fail('config validation', errors.join('; ')) : ok('config/factory.config.yaml is valid'));
  for (const warning of warnings.filter((w) => !w.includes('env var'))) checks.push(warn(warning));

  for (const [side, repo] of Object.entries(config.repos)) {
    if (!(await isGitRepo(repo.path))) {
      checks.push(fail(`${side} repo ${repo.path}`, existsSync(repo.path) ? 'not a git repo' : `folder does not exist; set SOURCERER_${side.toUpperCase()} in .env`));
      continue;
    }
    const dirty = (await execa('git', ['-C', repo.path, 'status', '--porcelain'])).stdout.split('\n').filter(Boolean).length;
    checks.push(ok(`${side} repo ${repo.path} (base ${repo.base}, ${dirty ? `dirty: ${dirty} changes` : 'clean'})`));
  }

  // Profiles used by an agent (llm or fallback) must work; unused ones only warn.
  const used = new Set(defs.flatMap((def) => [def.llm, def.fallbackLlm].filter(Boolean)));
  const usedBins = [];
  const bins = new Map();
  for (const [name, profile] of Object.entries(config.llms)) {
    if (profile.type === 'cli') bins.set(profile.bin, [...(bins.get(profile.bin) ?? []), name]);
    if ('keyEnv' in profile && profile.keyEnv) {
      const set = Boolean(process.env[profile.keyEnv]);
      const label = `${name}: ${profile.keyEnv} ${set ? 'set' : 'missing'}`;
      checks.push(set ? ok(label) : used.has(name) ? fail(label, 'add it to .env') : warn(label, 'only needed if you use this profile'));
    }
  }
  for (const [bin, profiles] of bins) {
    const inUse = profiles.some((name) => used.has(name));
    const version = await toolVersion(bin);
    if (version && inUse) usedBins.push(bin);
    const label = `${bin} (${profiles.join(', ')})`;
    if (version) checks.push(ok(`${label}: ${version}`));
    else checks.push(inUse ? fail(`${label} not found`, `install ${bin} and log in once`) : warn(`${label} not found`, 'only needed if you use these profiles'));
    if (version && !existsSync(join(root, 'docs', 'cli-help', `${bin}.txt`))) {
      checks.push(warn(`docs/cli-help/${bin}.txt missing`, 'run `sourcerer setup` to save it'));
    }
  }

  const pricing = config.pricing;
  const agents = defs.map((def) => createAgent(def, config));
  const unpriced = new Set();
  for (const agent of agents) {
    for (const [profile, model] of [[agent.profile, agent.model], [agent.fallback, agent.fallback?.model]]) {
      if (profile && !profile.capabilities.reportsCost && !pricing[model]) unpriced.add(model);
    }
  }
  for (const model of unpriced) checks.push(warn(`no price for ${model}`, 'cost will be "unknown"; add it under pricing: in sourcerer.yaml'));
  if (!unpriced.size) checks.push(ok('pricing covers every model that does not report cost'));

  const { security } = config;
  checks.push(security.webAccess ? warn('web access is on for agents', 'turn off with security.webAccess: false') : ok('web access off'));
  checks.push(security.commandAllowlist ? ok('coder commands limited to the allowlist') : warn('coders may run any command', 'set security.commandAllowlist: true'));
  checks.push(security.confineFiles ? ok('Claude reads limited to the worktree and the other repo') : warn('Claude may read any file', 'set security.confineFiles: true'));
  let sandboxOn = false;
  try {
    sandboxOn = sandboxActive(security);
  } catch (error) {
    checks.push(fail('sandbox', error.message));
  }
  if (sandboxOn) checks.push(ok('macOS sandbox on: agents, their commands and tests cannot read or write your home folder'));
  else checks.push(warn(sandboxAvailable() ? 'sandbox is off' : 'no sandbox on this platform', sandboxAvailable()
    ? 'turn on with security.sandbox.enabled: auto' : 'run Sourcerer in a container or VM without your credentials'));
  if (security.trustUnconfinedCli && !sandboxOn) checks.push(warn('security.trustUnconfinedCli is on', 'cursor-agent can read any file and run any command'));
  for (const [label, path] of [['workspace', root], ['.env', join(root, '.env')]]) {
    if (existsSync(path) && (statSync(path).mode & 0o077)) checks.push(warn(`${label} can be read by other users`, 'run `sourcerer setup` to fix the permissions'));
  }

  if (config.rag.enabled) {
    for (const side of Object.keys(config.repos)) {
      const meta = readMeta(root, side);
      checks.push(meta ? ok(`search index ${side}: ${meta.files.length} files (built ${meta.builtAt.slice(0, 10)})`)
        : warn(`no search index for ${side}`, 'run `sourcerer index` (otherwise it is built at the first task, which can take minutes on a large repo)'));
    }
  }

  if (await isGitRepo(root)) {
    for (const path of ['.env', 'runs/x']) {
      const ignored = (await execa('git', ['-C', root, 'check-ignore', '-q', path], { reject: false })).exitCode === 0;
      const name = path.replace('/x', '/');
      checks.push(ignored ? ok(`.gitignore covers ${name}`) : warn(`.gitignore does not cover ${name}`, 'run `sourcerer setup`'));
    }
  }

  return checks.concat(loginNote(usedBins));
}

function loginNote(bins) {
  const list = bins.length ? bins.join(', ') : 'each agent CLI';
  return [{ level: 'NOTE', label: `login state can't be checked; log in to ${list} once by hand` }];
}

const firstLine = (error) => String(error instanceof Error ? error.message : error).split('\n').slice(0, 3).join(' ');

export async function doctorCommand({ root, smoke }, print) {
  const checks = await runChecks(root);
  for (const check of checks) print(`${check.level.padEnd(5)} ${check.label}${check.hint ? ` (${check.hint})` : ''}`);
  let failed = checks.some((check) => check.level === 'FAIL');
  if (smoke) {
    if (failed) print('\nskipping --smoke: fix the FAIL lines first');
    else {
      print('\nsmoke (one tiny call per profile, costs a few cents):');
      failed = (await smokeCommand([], { root: resolveRoot({ flag: root }) }, print)) !== 0;
    }
  }
  return failed ? 1 : 0;
}
