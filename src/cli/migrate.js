import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { PACKAGE_DIR, WORKSPACE_FILE, isLegacyWorkspace } from '../core/config.js';
import { WORKSPACE_TEMPLATE } from './init.js';
import { loadProject } from './project.js';

const raw = (file) => (existsSync(file) ? parse(readFileSync(file, 'utf8')) ?? {} : {});
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (value) => (value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
  : value);

// "${SOURCERER_X:-5}" -> 5, "${SOURCERER_X:-}" -> undefined, plain values unchanged.
function defaultOf(value) {
  if (typeof value !== 'string') return value;
  const match = value.match(/^\$\{[A-Z0-9_]+(?::-(.*))?\}$/);
  if (!match) return value;
  if (!match[1]) return undefined;
  return Number.isNaN(Number(match[1])) ? match[1] : Number(match[1]);
}

// The old layout copied config/ and agents/ into the workspace. Keep only what differs from the
// package in sourcerer.yaml; agents with changed prompts/tools stay as agents/<name>.yaml overrides.
export function migrateCommand({ root }, print) {
  if (!isLegacyWorkspace(root)) {
    print(`nothing to migrate: ${root} has no old-layout config/`);
    return 0;
  }
  const oldConfig = raw(join(root, 'config', 'factory.config.yaml'));
  const pkgConfig = raw(join(PACKAGE_DIR, 'config', 'factory.config.yaml'));
  const out = {};
  const put = (path, value) => {
    let node = out;
    for (const key of path.slice(0, -1)) node = node[key] ??= {};
    node[path.at(-1)] = value;
  };

  for (const side of ['frontend', 'backend']) {
    const mine = oldConfig.repos?.[side] ?? {};
    for (const key of ['base', 'setup', 'test', 'docs']) {
      if (mine[key] !== undefined && !same(mine[key], pkgConfig.repos?.[side]?.[key])) put(['repos', side, key], mine[key]);
    }
    const path = defaultOf(mine.path);
    if (path && !String(mine.path).startsWith('${')) put(['repos', side, 'path'], path);
  }
  for (const [section, keys] of Object.entries({ paths: ['runs', 'worktrees'], budget: null, review: null, tools: null })) {
    for (const [key, value] of Object.entries(oldConfig[section] ?? {})) {
      if (keys && !keys.includes(key)) continue;
      const mine = defaultOf(value);
      if (mine !== undefined && !same(mine, pkgConfig[section]?.[key])) put([section, key], mine);
    }
  }
  for (const [name, profile] of Object.entries(oldConfig.llms ?? {})) {
    if (!same(profile, pkgConfig.llms?.[name])) put(['llms', name], profile);
  }
  for (const [name, price] of Object.entries(raw(join(root, 'config', 'pricing.yaml')).models ?? {})) put(['pricing', name], price);

  const custom = [];
  const oldAgentsDir = join(root, 'agents');
  for (const file of existsSync(oldAgentsDir) ? readdirSync(oldAgentsDir).filter((f) => f.endsWith('.yaml')) : []) {
    const mine = raw(join(oldAgentsDir, file));
    const pkg = raw(join(PACKAGE_DIR, 'agents', file));
    for (const key of ['llm', 'model', 'fallbackLlm']) {
      const value = defaultOf(mine[key]);
      if (value !== undefined && !same(value, pkg[key])) put(['agents', mine.name, key], value);
    }
    const rest = (agent) => Object.fromEntries(Object.entries(agent).filter(([key]) => !['llm', 'model', 'fallbackLlm'].includes(key)));
    if (!same(rest(mine), rest(pkg))) custom.push(file);
  }

  // Move the old copies aside, keep changed agents as overrides, write sourcerer.yaml, then verify.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const backups = [];
  for (const dir of ['config', 'agents']) {
    if (!existsSync(join(root, dir))) continue;
    renameSync(join(root, dir), join(root, `${dir}.bak-${stamp}`));
    backups.push(`${dir}.bak-${stamp}`);
  }
  if (custom.length) {
    mkdirSync(join(root, 'agents'));
    for (const file of custom) cpSync(join(root, `agents.bak-${stamp}`, file), join(root, 'agents', file));
  }
  const file = join(root, WORKSPACE_FILE);
  const hadFile = existsSync(file);
  if (!hadFile) writeFileSync(file, `${WORKSPACE_TEMPLATE}${Object.keys(out).length ? `\n${stringify(out)}` : ''}`);
  try {
    const project = loadProject(root);
    if (project.errors.length) throw new Error(project.errors.join('; '));
  } catch (error) {
    print(`migration check failed, restoring the old layout: ${error.message}`);
    if (!hadFile) rmSync(file);
    if (custom.length) rmSync(join(root, 'agents'), { recursive: true });
    for (const backup of backups) renameSync(join(root, backup), join(root, backup.replace(/\.bak-.*/, '')));
    return 1;
  }
  print(hadFile ? `${WORKSPACE_FILE} already existed and was left unchanged` : `wrote ${WORKSPACE_FILE}:`);
  if (!hadFile) print(Object.keys(out).length ? stringify(out).trimEnd() : '(no differences from the package defaults)');
  for (const name of custom) print(`kept agents/${name} as an override (its prompt or tools differ from the package)`);
  for (const backup of backups) print(`old copy moved to ${backup}/ (delete it once you are happy)`);
  return 0;
}
