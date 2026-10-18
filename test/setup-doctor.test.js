import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
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

// A fresh clone: the package's config and agents, a git repo, no .env and no .gitignore.
async function freshClone() {
  const root = temp('clone');
  cpSync(new URL('../config', import.meta.url), join(root, 'config'), { recursive: true });
  cpSync(new URL('../agents', import.meta.url), join(root, 'agents'), { recursive: true });
  await execa('git', ['init', '-q'], { cwd: root });
  return root;
}

const scripted = (answers) => {
  const asked = [];
  return { asked, ask: async (q) => { asked.push(q); return answers.shift() ?? ''; } };
};

for (const name of ['SOURCERER_FRONTEND', 'SOURCERER_BACKEND', 'SOURCERER_ROOT']) delete process.env[name];

test('setup on a fresh clone: .env, roles, key names, .gitignore, cli-help, pricing rows, then doctor', async () => {
  const root = await freshClone();
  const [fe, be] = [await repo(), await repo()];
  const lines = [];
  const { ask, asked } = scripted([
    '/does/not/exist', fe, // frontend: one bad path, then a good one
    be,                    // backend
    '', '',                // planner: keep profile, keep model
    'claude-cheap', 'my-coder-model',
    'nope', 'gpt-api', 'my-review-model',
  ]);
  const code = await setupCommand({ root }, (l) => lines.push(l), ask);
  const out = lines.join('\n');
  const env = readFileSync(join(root, '.env'), 'utf8');

  assert.match(out, /\/does\/not\/exist: does not exist/);
  assert.match(env, new RegExp(`^SOURCERER_FRONTEND=${fe}$`, 'm'));
  assert.match(env, new RegExp(`^SOURCERER_BACKEND=${be}$`, 'm'));
  assert.match(env, /^SOURCERER_CODER_LLM=claude-cheap$/m);
  assert.match(env, /^SOURCERER_CODER_MODEL=my-coder-model$/m);
  assert.match(env, /^SOURCERER_REVIEWER_LLM=gpt-api$/m);
  assert.match(env, /^OPENAI_API_KEY=$/m, 'key name added, empty');
  assert.match(out, /unknown profile "nope"/);
  assert.match(out, /gpt-api needs OPENAI_API_KEY: type the key into .* yourself/);
  assert.ok(!asked.some((q) => /key/i.test(q)), 'never asks for a key');
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.env\nruns\/\n$/);
  assert.match(readFileSync(join(root, 'docs/cli-help/claude.txt'), 'utf8'), /Usage: claude/);
  assert.match(readFileSync(join(root, 'config/pricing.yaml'), 'utf8'), /^# {2}my-review-model: \{ input: , output: , cachedInput: \}/m);
  assert.doesNotMatch(readFileSync(join(root, 'config/pricing.yaml'), 'utf8'), /my-coder-model/, 'claude reports cost');
  assert.match(out, /Doctor:\n[\s\S]*FAIL {2}claude-api|Doctor:\n[\s\S]*gpt-api: OPENAI_API_KEY missing/);
  assert.equal(code, 1, 'doctor fails: the reviewer profile needs a key');
});

test('setup again keeps everything and changes nothing', async () => {
  const root = await freshClone();
  const [fe, be] = [await repo(), await repo()];
  await setupCommand({ root }, () => {}, scripted([fe, be, '', '', '', '', '', '']).ask);
  const envBefore = readFileSync(join(root, '.env'), 'utf8');
  const lines = [];
  await setupCommand({ root }, (l) => lines.push(l), scripted([]).ask);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), envBefore);
  assert.match(lines.join('\n'), /Changed: nothing/);
});

test('doctor: OK/WARN/FAIL lines, key values never printed, exit 1 on FAIL', async () => {
  const root = await freshClone();
  const [fe, be] = [await repo(), await repo()];
  writeFileSync(join(root, '.env'), `SOURCERER_FRONTEND=${fe}\nSOURCERER_BACKEND=${be}\nSOURCERER_REVIEWER_LLM=gpt-api\nOPENAI_API_KEY=sk-secret-value-123\n`);
  writeFileSync(join(fe, 'dirty.txt'), 'x');
  const lines = [];
  const code = await doctorCommand({ root }, (l) => lines.push(l));
  const out = lines.join('\n');
  assert.doesNotMatch(out, /sk-secret/);
  assert.match(out, /OK {4}gpt-api: OPENAI_API_KEY set/);
  assert.match(out, /frontend repo .* \(dirty: 1 changes\)/);
  assert.match(out, /WARN {2}codex \(codex-main\) not found/);
  assert.match(out, /WARN {2}\.gitignore does not cover \.env/);
  assert.match(out, /NOTE {2}login state can't be checked/);
  assert.equal(code, 0);
});

test('doctor reports a missing repo and a missing workspace as FAIL', async () => {
  const root = await freshClone();
  writeFileSync(join(root, '.env'), 'SOURCERER_FRONTEND=/nope\nSOURCERER_BACKEND=/nope2\n');
  const checks = await runChecks(root);
  assert.ok(checks.some((c) => c.level === 'FAIL' && /frontend repo \/nope/.test(c.label)));
  const none = temp('none');
  mkdirSync(join(none, 'x'));
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
