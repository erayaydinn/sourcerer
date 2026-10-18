import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand } from '../src/cli/init.js';
import { defaultWorkspace, resolveRoot } from '../src/cli/root.js';

function workspace(dir) {
  mkdirSync(join(dir, 'config'), { recursive: true });
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'config', 'factory.config.yaml'), '');
  return dir;
}

const temp = () => mkdtempSync(join(tmpdir(), 'sourcerer-root-'));

test('--root wins, then SOURCERER_ROOT', () => {
  assert.equal(resolveRoot({ flag: '/a', env: { SOURCERER_ROOT: '/b' } }), '/a');
  assert.equal(resolveRoot({ env: { SOURCERER_ROOT: '/b' } }), '/b');
});

test('finds the nearest parent workspace, e.g. from inside a worktree', () => {
  const root = workspace(temp());
  const deep = join(root, 'worktrees', 'task', 'backend', 'src');
  mkdirSync(deep, { recursive: true });
  assert.equal(resolveRoot({ env: {}, cwd: deep }), root);
});

test('falls back to $XDG_CONFIG_HOME/sourcerer, else errors with a hint', () => {
  const xdg = temp();
  const elsewhere = temp();
  assert.throws(() => resolveRoot({ env: { XDG_CONFIG_HOME: xdg }, cwd: elsewhere }), /Run `sourcerer init`/);
  workspace(join(xdg, 'sourcerer'));
  assert.equal(resolveRoot({ env: { XDG_CONFIG_HOME: xdg }, cwd: elsewhere }), join(xdg, 'sourcerer'));
  assert.equal(defaultWorkspace({ XDG_CONFIG_HOME: xdg }), join(xdg, 'sourcerer'));
});

test('init copies templates, creates .env, and never overwrites', () => {
  const target = join(temp(), 'ws');
  const lines = [];
  initCommand(target, {}, (line) => lines.push(line));
  for (const file of ['config/factory.config.yaml', 'config/pricing.yaml', 'agents/reviewer.yaml', '.env', '.env.example']) {
    assert.ok(lines.includes(`create ${file}`), file);
  }
  assert.match(readFileSync(join(target, '.env'), 'utf8'), /SOURCERER_FRONTEND=/);
  assert.equal(resolveRoot({ env: {}, cwd: target }), target);

  writeFileSync(join(target, '.env'), 'SOURCERER_FRONTEND=/mine\n');
  const again = [];
  initCommand(target, {}, (line) => again.push(line));
  assert.ok(again.includes('skip   .env (exists)'));
  assert.ok(!again.some((line) => line.startsWith('create')));
  assert.equal(readFileSync(join(target, '.env'), 'utf8'), 'SOURCERER_FRONTEND=/mine\n');
});
