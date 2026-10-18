import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentDef, factoryConfig } from '../src/core/schemas.js';
import { applyLlmOverrides, createAgent, validate } from '../src/core/factory.js';

const config = factoryConfig.parse({
  repos: { frontend: { path: '/fe', base: 'main' }, backend: { path: '/be', base: 'main' } },
  paths: { agents: 'a', runs: 'r', pricing: 'p', worktrees: 'w' },
  budget: { maxCostPerRun: 5, maxCostPerAgent: 2 },
  review: { maxRounds: 3, testOutputChars: 2000 },
  tools: { maxOutputChars: 1000, runCommand: { allow: ['git'], timeoutSec: 10 } },
  llms: {
    claude: { type: 'cli', bin: 'claude', provider: 'anthropic', model: 'm1', capabilities: { editsFiles: true } },
    chat: { type: 'openai-compat', provider: 'openai', baseURL: 'http://localhost:11434/v1', model: 'm2' },
  },
});

const agent = (fields) => agentDef.parse({ maxTurns: 5, timeoutSec: 60, systemPrompt: 'x', ...fields });
const coder = agent({ name: 'coder', role: 'coder', repo: 'frontend', llm: 'claude' });
const reviewer = agent({ name: 'reviewer', role: 'reviewer', llm: 'chat', tools: ['read_file'] });

test('valid setup has no errors or warnings', () => {
  assert.deepEqual(validate([coder, reviewer], config), { errors: [], warnings: [] });
});

test('unknown llm profile is an error', () => {
  const { errors } = validate([agent({ name: 'p', role: 'planner', llm: 'nope' })], config);
  assert.match(errors[0], /unknown llm profile "nope"/);
});

test('unknown fallbackLlm is an error', () => {
  const { errors } = validate([{ ...coder, fallbackLlm: 'nope' }], config);
  assert.match(errors[0], /unknown fallbackLlm/);
});

test('coder on editsFiles:false profile is an error', () => {
  const { errors } = validate([{ ...coder, llm: 'chat' }], config);
  assert.match(errors[0], /editsFiles: false/);
});

test('coder without repo is an error', () => {
  const { errors } = validate([{ ...coder, repo: undefined }], config);
  assert.match(errors[0], /needs a repo/);
});

test('reviewer with write tools is an error', () => {
  const { errors } = validate([{ ...reviewer, tools: ['write_file'] }], config);
  assert.match(errors[0], /read-only/);
});

test('duplicate agent names are an error', () => {
  const { errors } = validate([coder, coder], config);
  assert.match(errors[0], /duplicate/);
});

test('reviewer sharing a provider with a coder is a warning', () => {
  const { errors, warnings } = validate([coder, { ...reviewer, llm: 'claude' }], config);
  assert.deepEqual(errors, []);
  assert.match(warnings[0], /provider "anthropic"/);
});

test('openai-compat works without keyEnv', () => {
  assert.equal(config.llms.chat.keyEnv, undefined);
});

test('createAgent applies model override and resolves cwd and fallback', () => {
  const built = createAgent({ ...coder, model: 'override', fallbackLlm: 'claude' }, config);
  assert.equal(built.model, 'override');
  assert.equal(built.cwd, '/fe');
  assert.equal(built.fallback.bin, 'claude');
});

test('applyLlmOverrides: agent name wins over role and model override is dropped', () => {
  const coder2 = { ...coder, name: 'coder-b', model: 'special' };
  const [a, b] = applyLlmOverrides([coder, coder2], ['coder=chat', 'coder-b=claude']);
  assert.deepEqual([a.llm, b.llm, b.model], ['chat', 'claude', undefined]);
});

test('applyLlmOverrides rejects bad pairs and unknown keys', () => {
  assert.throws(() => applyLlmOverrides([coder], ['coder']), /expects <role\|agent>=<profile>/);
  assert.throws(() => applyLlmOverrides([coder], ['nobody=chat']), /no agent or role named "nobody"/);
});

test('an empty model or fallbackLlm (unset env with :-) counts as not set', () => {
  const def = agent({ name: 'c', role: 'coder', repo: 'frontend', llm: 'claude', model: '', fallbackLlm: '' });
  assert.equal(def.model, undefined);
  assert.equal(def.fallbackLlm, undefined);
  assert.equal(createAgent(def, config).model, 'm1');
});
