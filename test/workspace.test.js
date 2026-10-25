import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { agentsCommand, useCommand } from '../src/cli/agents.js';
import { migrateCommand } from '../src/cli/migrate.js';
import { modelsAddCommand, modelsListCommand, modelsRemoveCommand } from '../src/cli/models.js';
import { loadProject } from '../src/cli/project.js';
import { loadConfig } from '../src/core/config.js';

const temp = (name) => mkdtempSync(join(tmpdir(), `sourcerer-${name}-`));
const out = () => {
  const lines = [];
  const print = (line) => lines.push(line);
  print.text = () => lines.join('\n');
  return print;
};

for (const name of ['SOURCERER_FRONTEND', 'SOURCERER_BACKEND', 'SOURCERER_CODER_LLM', 'SOURCERER_CODER_MODEL']) delete process.env[name];

function workspace(yaml = '# test\n') {
  const root = temp('ws');
  writeFileSync(join(root, 'sourcerer.yaml'), yaml);
  writeFileSync(join(root, '.env'), `SOURCERER_FRONTEND=${root}\nSOURCERER_BACKEND=${root}\n`);
  return root;
}
const agent = (project, name) => project.defs.find((d) => d.name === name);

test('package defaults < sourcerer.yaml < env < --llm, and each value says where it came from', () => {
  const root = workspace([
    'budget: { maxCostPerRun: 3 }',
    'llms:',
    '  my-cursor: { type: cli, bin: cursor-agent, provider: xai, model: grok-4.7-high, capabilities: { editsFiles: true } }',
    'agents:',
    '  coder-backend: { llm: my-cursor }',
    '  reviewer: { model: grok-4.7-xhigh }',
    'pricing:',
    '  grok-4.7-high: { input: 1, output: 2 }',
  ].join('\n'));
  let project = loadProject(root);
  assert.equal(project.config.budget.maxCostPerRun, 3);
  assert.equal(project.config.budget.maxCostPerAgent, 2, 'package default kept');
  assert.ok(project.config.llms['claude-strong'], 'package profiles still there');
  assert.deepEqual(project.config.pricing, { 'grok-4.7-high': { input: 1, output: 2 } });
  assert.deepEqual([agent(project, 'coder-backend').llm, agent(project, 'coder-backend').sources.llm], ['my-cursor', 'sourcerer.yaml']);
  assert.deepEqual([agent(project, 'coder-frontend').llm, agent(project, 'coder-frontend').sources.llm], ['claude-strong', 'package']);
  assert.deepEqual([agent(project, 'reviewer').model, agent(project, 'reviewer').sources.model], ['grok-4.7-xhigh', 'sourcerer.yaml']);

  process.env.SOURCERER_CODER_LLM = 'claude-cheap';
  process.env.SOURCERER_MAX_COST_PER_RUN = '9';
  try {
    project = loadProject(root);
    assert.deepEqual([agent(project, 'coder-backend').llm, agent(project, 'coder-backend').sources.llm], ['claude-cheap', 'SOURCERER_CODER_LLM']);
    assert.equal(project.config.budget.maxCostPerRun, 9, 'env beats sourcerer.yaml');
    project = loadProject(root, ['coder-backend=claude-strong']);
    assert.deepEqual([agent(project, 'coder-backend').llm, agent(project, 'coder-backend').sources.llm], ['claude-strong', '--llm']);
  } finally {
    delete process.env.SOURCERER_CODER_LLM;
    delete process.env.SOURCERER_MAX_COST_PER_RUN;
  }
});

test('a workspace agents/<name>.yaml replaces that package agent; unknown sections and bad config are clear errors', () => {
  const root = workspace();
  mkdirSync(join(root, 'agents'));
  const reviewer = readFileSync(new URL('../agents/reviewer.yaml', import.meta.url), 'utf8').replace('You are the reviewer.', 'You are a strict reviewer.');
  writeFileSync(join(root, 'agents', 'reviewer.yaml'), reviewer);
  const project = loadProject(root);
  assert.match(agent(project, 'reviewer').systemPrompt, /strict reviewer/);
  assert.equal(agent(project, 'reviewer').sources.llm, 'agents/');

  writeFileSync(join(root, 'sourcerer.yaml'), 'budjet: { maxCostPerRun: 1 }\n');
  assert.throws(() => loadConfig(root), /unknown section\(s\) budjet/);
  writeFileSync(join(root, 'sourcerer.yaml'), 'budget: { maxCostPerRun: -1 }\n');
  assert.throws(() => loadConfig(root), /maxCostPerRun/);
});

test('models add / list / remove edit only sourcerer.yaml, keep comments, and refuse unsafe changes', async () => {
  const root = workspace('# my notes stay\nbudget: { maxCostPerRun: 4 } # inline note\nsecurity: { trustUnconfinedCli: true }\n');
  const print = out();
  await modelsAddCommand('cursor-high', { root, cli: 'cursor-agent', provider: 'xai', model: 'grok-4.7-high' }, print, null);
  const text = readFileSync(join(root, 'sourcerer.yaml'), 'utf8');
  assert.match(text, /^# my notes stay/);
  assert.match(text, /# inline note/);
  assert.deepEqual(parse(text).llms['cursor-high'], {
    type: 'cli', bin: 'cursor-agent', provider: 'xai', model: 'grok-4.7-high',
    capabilities: { editsFiles: true, toolUse: true, jsonOutput: true },
  });
  await assert.rejects(modelsAddCommand('cursor-high', { root, cli: 'cursor-agent', provider: 'xai', model: 'x' }, out(), null), /exists \(use --force/);
  await assert.rejects(modelsAddCommand('x', { root, cli: 'aider', provider: 'p', model: 'm' }, out(), null), /unknown kind "aider"/);
  await assert.rejects(modelsAddCommand('x', { root, api: 'anthropic', provider: 'anthropic', model: 'm' }, out(), null), /missing maxOutputTokens/);

  const list = out();
  await modelsListCommand({ root }, list);
  assert.match(list.text(), /cursor-high\s+cursor-agent\s+xai\s+grok-4\.7-high\s+sourcerer\.yaml/);
  assert.match(list.text(), /claude-strong\s+claude\s+anthropic\s+opus\s+package/);

  useCommand('coder-backend', 'cursor-high', { root }, out());
  assert.throws(() => modelsRemoveCommand('cursor-high', { root }, out()), /used by coder-backend/);
  assert.throws(() => modelsRemoveCommand('claude-strong', { root }, out()), /package profile/);
  useCommand('coder-backend', 'claude-strong', { root }, out());
  modelsRemoveCommand('cursor-high', { root }, out());
  assert.equal(parse(readFileSync(join(root, 'sourcerer.yaml'), 'utf8')).llms, undefined, 'empty llms section removed');
});

test('use: per agent or per role, --model and --fallback, invalid choices are not saved, env overrides are reported', () => {
  const root = workspace();
  const print = out();
  useCommand('coder', 'claude-cheap', { root, model: 'sonnet' }, print);
  assert.match(print.text(), /coder-backend -> claude-cheap \(sonnet\)/);
  assert.match(print.text(), /coder-frontend -> claude-cheap \(sonnet\)/);
  useCommand('reviewer', 'claude-strong', { root, fallback: 'claude-cheap' }, out());
  assert.deepEqual(parse(readFileSync(join(root, 'sourcerer.yaml'), 'utf8')).agents, {
    'coder-backend': { llm: 'claude-cheap', model: 'sonnet' },
    'coder-frontend': { llm: 'claude-cheap', model: 'sonnet' },
    reviewer: { llm: 'claude-strong', fallbackLlm: 'claude-cheap' },
  });
  useCommand('coder-backend', 'claude-strong', { root }, out());
  assert.equal(parse(readFileSync(join(root, 'sourcerer.yaml'), 'utf8')).agents['coder-backend'].model, undefined, 'model cleared with the profile change');

  const before = readFileSync(join(root, 'sourcerer.yaml'), 'utf8');
  assert.throws(() => useCommand('coder', 'gpt-api', { root }, out()), /not saved: .*editsFiles: false/);
  assert.equal(readFileSync(join(root, 'sourcerer.yaml'), 'utf8'), before);
  assert.throws(() => useCommand('nobody', 'claude-cheap', { root }, out()), /no agent or role "nobody"/);
  assert.throws(() => useCommand('coder', 'nope', { root }, out()), /unknown profile "nope"/);

  process.env.SOURCERER_CODER_LLM = 'claude-cheap';
  try {
    const noted = out();
    useCommand('coder-backend', 'claude-strong', { root }, noted);
    assert.match(noted.text(), /SOURCERER_CODER_LLM is set in \.env or the shell and overrides this/);
  } finally {
    delete process.env.SOURCERER_CODER_LLM;
  }
  const table = out();
  agentsCommand({ root }, table);
  assert.match(table.text(), /reviewer\s+reviewer\s+claude-strong\s+sourcerer\.yaml\s+opus\s+profile\s+claude-cheap/);
});

test('migrate keeps only differences, keeps changed agents as overrides, backs up the old copies', () => {
  const root = temp('legacy');
  cpSync(new URL('../config', import.meta.url), join(root, 'config'), { recursive: true });
  cpSync(new URL('../agents', import.meta.url), join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, '.env'), `SOURCERER_FRONTEND=${root}\nSOURCERER_BACKEND=${root}\n`);
  const config = readFileSync(join(root, 'config', 'factory.config.yaml'), 'utf8')
    .replace('  maxCostPerRun: 5', '  maxCostPerRun: ${SOURCERER_MAX_COST_PER_RUN:-3}')
    .replace('  frontend:\n', '  frontend:\n    path: ${SOURCERER_FRONTEND}\n    test: { run: [pnpm, run, build], timeoutSec: 300 }\n')
    .replace('    model: grok-4.7-medium', '    model: grok-4.7-high');
  writeFileSync(join(root, 'config', 'factory.config.yaml'), config);
  writeFileSync(join(root, 'config', 'pricing.yaml'), 'models:\n  grok-4.7-high: { input: 1, output: 2 }\n');
  const coder = readFileSync(join(root, 'agents', 'coder-backend.yaml'), 'utf8').replace(/^llm: .*$/m, 'llm: ${SOURCERER_CODER_LLM:-claude-cheap}');
  writeFileSync(join(root, 'agents', 'coder-backend.yaml'), coder);
  const reviewer = readFileSync(join(root, 'agents', 'reviewer.yaml'), 'utf8').replace('You are the reviewer.', 'You are a strict reviewer.');
  writeFileSync(join(root, 'agents', 'reviewer.yaml'), reviewer);
  assert.throws(() => loadConfig(root), /old layout .*sourcerer migrate/);

  const print = out();
  assert.equal(migrateCommand({ root }, print), 0);
  const yaml = parse(readFileSync(join(root, 'sourcerer.yaml'), 'utf8'));
  assert.deepEqual(yaml.budget, { maxCostPerRun: 3 });
  assert.deepEqual(yaml.repos, { frontend: { test: { run: ['pnpm', 'run', 'build'], timeoutSec: 300 } } });
  assert.equal(yaml.llms['cursor-main'].model, 'grok-4.7-high');
  assert.equal(Object.keys(yaml.llms).length, 1, 'unchanged profiles are not copied');
  assert.deepEqual(yaml.agents, { 'coder-backend': { llm: 'claude-cheap' } });
  assert.deepEqual(yaml.pricing, { 'grok-4.7-high': { input: 1, output: 2 } });
  assert.deepEqual(readdirSync(join(root, 'agents')), ['reviewer.yaml'], 'only the changed prompt is kept as an override');
  assert.ok(readdirSync(root).some((name) => name.startsWith('config.bak-')));
  assert.ok(readdirSync(root).some((name) => name.startsWith('agents.bak-')));
  assert.match(print.text(), /kept agents\/reviewer\.yaml as an override/);

  const project = loadProject(root);
  assert.equal(agent(project, 'coder-backend').llm, 'claude-cheap');
  assert.match(agent(project, 'reviewer').systemPrompt, /strict reviewer/);
  assert.match(migrateCommand({ root }, out()) === 0 ? 'ok' : '', /ok/, 'second run: nothing to migrate');
});

test('migrate restores the old layout if the result does not load', () => {
  const root = temp('legacy-bad');
  cpSync(new URL('../config', import.meta.url), join(root, 'config'), { recursive: true });
  cpSync(new URL('../agents', import.meta.url), join(root, 'agents'), { recursive: true });
  const print = out();
  assert.equal(migrateCommand({ root }, print), 1, 'no repo paths: the check fails');
  assert.match(print.text(), /restoring the old layout/);
  assert.ok(existsSync(join(root, 'config', 'factory.config.yaml')) && !existsSync(join(root, 'sourcerer.yaml')));
  assert.ok(!readdirSync(root).some((name) => name.includes('.bak-')));
});
