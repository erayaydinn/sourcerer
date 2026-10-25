import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { parse } from 'yaml';
import { doctorCommand, runChecks } from '../src/cli/doctor.js';
import { setupCommand } from '../src/cli/setup.js';

const temp = (name) => mkdtempSync(join(tmpdir(), `sourcerer-${name}-`));

// Fake agent CLIs on PATH: `claude` and `cursor-agent` answer --version / --help; no codex.
const bin = temp('bin');
for (const name of ['claude', 'cursor-agent']) {
  writeFileSync(join(bin, name), `#!/bin/sh\ncase "$1" in --version) echo "${name} 9.9.9";; --help) echo "Usage: ${name} [options]";; esac\n`);
  chmodSync(join(bin, name), 0o755);
}
process.env.PATH = `${bin}:${process.env.PATH}`;

async function repo() {
  const dir = temp('repo');
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}

// An empty folder that is a git repo (so .gitignore handling runs); setup creates the workspace.
async function emptyWorkspace() {
  const root = temp('ws');
  await execa('git', ['init', '-q'], { cwd: root });
  return root;
}

const scripted = (answers) => {
  const asked = [];
  return { asked, ask: async (q) => { asked.push(q); return answers.shift() ?? ''; } };
};
const settings = (root) => parse(readFileSync(join(root, 'sourcerer.yaml'), 'utf8')) ?? {};

for (const name of ['SOURCERER_FRONTEND', 'SOURCERER_BACKEND', 'SOURCERER_ROOT']) delete process.env[name];

test('setup on an empty folder: paths and key names in .env, roles in sourcerer.yaml, then doctor', async () => {
  const root = await emptyWorkspace();
  const [fe, be] = [await repo(), await repo()];
  const lines = [];
  const { ask, asked } = scripted([
    '/does/not/exist', fe, // frontend: one bad path, then a good one
    be,                    // backend
    '', '',                // planner: keep profile, keep model
    'gpt-api', 'claude-cheap', 'my-coder-model', // coder: gpt-api cannot edit files
    'nope', 'gpt-api', 'my-review-model',
  ]);
  const code = await setupCommand({ root }, (l) => lines.push(l), ask);
  const out = lines.join('\n');
  const env = readFileSync(join(root, '.env'), 'utf8');
  const yaml = settings(root);

  assert.match(out, /create sourcerer\.yaml/);
  assert.match(out, /\/does\/not\/exist: does not exist/);
  assert.match(env, new RegExp(`^SOURCERER_FRONTEND=${fe}$`, 'm'));
  assert.match(env, new RegExp(`^SOURCERER_BACKEND=${be}$`, 'm'));
  assert.match(env, /^OPENAI_API_KEY=$/m, 'key name added, empty');
  assert.doesNotMatch(env, /SOURCERER_CODER_LLM=claude/, 'roles are not written to .env');
  assert.match(out, /"gpt-api" cannot edit files, so it cannot be a coder/);
  assert.match(out, /unknown profile "nope"/);
  assert.deepEqual(yaml.agents, {
    'coder-backend': { llm: 'claude-cheap', model: 'my-coder-model' },
    'coder-frontend': { llm: 'claude-cheap', model: 'my-coder-model' },
    reviewer: { llm: 'gpt-api', model: 'my-review-model' },
  });
  assert.match(out, /gpt-api needs OPENAI_API_KEY: type the key into .* yourself/);
  assert.ok(!asked.some((q) => /key/i.test(q)), 'never asks for a key');
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '.env\nruns/\nworktrees/\nsourcerer.yaml\n');
  assert.match(readFileSync(join(root, 'docs/cli-help/claude.txt'), 'utf8'), /Usage: claude/);
  const text = readFileSync(join(root, 'sourcerer.yaml'), 'utf8');
  assert.match(text, /^# {3}my-review-model: \{ input: , output: , cachedInput: \}/m);
  assert.doesNotMatch(text, /# {3}my-coder-model/, 'claude reports cost');
  assert.match(out, /Doctor:\n[\s\S]*FAIL {2}gpt-api: OPENAI_API_KEY missing/);
  assert.equal(code, 1, 'doctor fails: the reviewer profile needs a key');
});

test('setup again keeps everything and changes nothing', async () => {
  const root = await emptyWorkspace();
  const [fe, be] = [await repo(), await repo()];
  await setupCommand({ root }, () => {}, scripted([fe, be]).ask);
  const before = [readFileSync(join(root, '.env'), 'utf8'), readFileSync(join(root, 'sourcerer.yaml'), 'utf8')];
  const lines = [];
  await setupCommand({ root }, (l) => lines.push(l), scripted([]).ask);
  assert.deepEqual([readFileSync(join(root, '.env'), 'utf8'), readFileSync(join(root, 'sourcerer.yaml'), 'utf8')], before);
  assert.match(lines.join('\n'), /Changed: nothing/);
});

test('setup limits go to sourcerer.yaml: Enter keeps, invalid values are asked again, none removes', async () => {
  const root = await emptyWorkspace();
  const [fe, be] = [await repo(), await repo()];
  const lines = [];
  const { ask, asked } = scripted([
    fe, be, '', '', '', '', '', '',   // repos + three roles (profile, model)
    'lots', '1.5',                    // run budget: invalid, then valid
    '',                               // agent budget: keep the default
    '0', '2.5', '2',                  // rounds: 0 and 2.5 are invalid, then 2
    '150000',                         // tokens per run
    '',                               // tokens per agent: keep (no limit)
  ]);
  await setupCommand({ root }, (l) => lines.push(l), ask);
  assert.ok(asked.includes('max cost per run (USD) [5]: '));
  assert.ok(asked.includes('max rounds (coder passes per task) [3]: '));
  assert.ok(asked.includes('max tokens per run (input + output), none = no limit [no limit]: '));
  const yaml = settings(root);
  assert.deepEqual(yaml.budget, { maxCostPerRun: 1.5, maxTokensPerRun: 150000 });
  assert.deepEqual(yaml.review, { maxRounds: 2 });
  assert.doesNotMatch(readFileSync(join(root, '.env'), 'utf8'), /SOURCERER_MAX_COST_PER_RUN=1/);
  const out = lines.join('\n');
  assert.match(out, /"lots" is not a positive number/);
  assert.match(out, /"0" is not a whole number of at least 1/);

  const again = scripted(['', '', '', '', '', '', '', '', '', '', '', 'none']);
  await setupCommand({ root }, () => {}, again.ask);
  assert.ok(again.asked.includes('max cost per run (USD) [1.5]: '), 'shows the saved value next time');
  assert.ok(again.asked.includes('max tokens per run (input + output), none = no limit [150000]: '));
  assert.deepEqual(settings(root).budget, { maxCostPerRun: 1.5 }, '`none` removed the token limit');
});

test('setup on an old-layout workspace asks for migrate first', async () => {
  const root = temp('legacy');
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config', 'factory.config.yaml'), 'repos: {}\n');
  const lines = [];
  assert.equal(await setupCommand({ root }, (l) => lines.push(l), scripted([]).ask), 1);
  assert.match(lines.join('\n'), /old layout: run `sourcerer migrate` first/);
});

test('doctor: OK/WARN/FAIL lines, key values never printed, exit code', async () => {
  const root = await emptyWorkspace();
  const [fe, be] = [await repo(), await repo()];
  writeFileSync(join(root, 'sourcerer.yaml'), '# test\n');
  writeFileSync(join(root, '.env'), `SOURCERER_FRONTEND=${fe}\nSOURCERER_BACKEND=${be}\nSOURCERER_REVIEWER_LLM=gpt-api\nOPENAI_API_KEY=sk-secret-value-123\n`);
  writeFileSync(join(fe, 'dirty.txt'), 'x');
  const lines = [];
  const code = await doctorCommand({ root }, (l) => lines.push(l));
  const out = lines.join('\n');
  assert.doesNotMatch(out, /sk-secret/);
  assert.match(out, /OK {4}gpt-api: OPENAI_API_KEY set/);
  assert.match(out, /frontend repo .* \(base main, dirty: 1 changes\)/);
  assert.match(out, /WARN {2}codex \(codex-main\) not found/);
  assert.match(out, /WARN {2}\.gitignore does not cover \.env/);
  assert.match(out, /NOTE {2}login state can't be checked/);
  assert.equal(code, 0);
});

test('doctor reports a missing repo, an old layout and a missing workspace as FAIL', async () => {
  const root = await emptyWorkspace();
  writeFileSync(join(root, 'sourcerer.yaml'), '# test\n');
  writeFileSync(join(root, '.env'), 'SOURCERER_FRONTEND=/nope\nSOURCERER_BACKEND=/nope2\n');
  const checks = await runChecks(root);
  assert.ok(checks.some((c) => c.level === 'FAIL' && /frontend repo \/nope/.test(c.label)));

  const legacy = temp('legacy');
  mkdirSync(join(legacy, 'config'));
  writeFileSync(join(legacy, 'config', 'factory.config.yaml'), '');
  assert.ok((await runChecks(legacy)).some((c) => c.level === 'FAIL' && /sourcerer migrate/.test(c.hint ?? '')));

  const none = temp('none');
  const cwd = process.cwd();
  process.env.XDG_CONFIG_HOME = none;
  process.chdir(none);
  try {
    const checks2 = await runChecks(undefined);
    assert.ok(checks2.some((c) => c.level === 'FAIL' && c.label === 'no workspace'));
  } finally {
    process.chdir(cwd);
    delete process.env.XDG_CONFIG_HOME;
  }
});
