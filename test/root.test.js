import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand } from '../src/cli/init.js';
import { defaultWorkspace, resolveRoot } from '../src/cli/root.js';

function workspace(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sourcerer.yaml'), '# workspace\n');
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

test('init creates sourcerer.yaml (no copies of the package), .env, and never overwrites', () => {
  const target = join(temp(), 'ws');
  const lines = [];
  initCommand(target, {}, (line) => lines.push(line));
  for (const file of ['sourcerer.yaml', '.env', '.env.example']) assert.ok(lines.includes(`create ${file}`), file);
  assert.ok(!existsSync(join(target, 'config')) && !existsSync(join(target, 'agents')), 'nothing copied from the package');
  assert.match(readFileSync(join(target, 'sourcerer.yaml'), 'utf8'), /only what differs from the package defaults/);
  assert.match(readFileSync(join(target, '.env'), 'utf8'), /SOURCERER_FRONTEND=/);
  assert.equal(resolveRoot({ env: {}, cwd: target }), target);

  writeFileSync(join(target, '.env'), 'SOURCERER_FRONTEND=/mine\n');
  const again = [];
  initCommand(target, {}, (line) => again.push(line));
  assert.ok(again.includes('skip   .env (exists)'));
  assert.ok(!again.some((line) => line.startsWith('create')));
  assert.equal(readFileSync(join(target, '.env'), 'utf8'), 'SOURCERER_FRONTEND=/mine\n');
});

test('an old-layout folder (config/ + agents/ copies) is found so it can be migrated; the package itself is not', async () => {
  const { PACKAGE_DIR } = await import('../src/cli/root.js');
  const legacy = temp();
  mkdirSync(join(legacy, 'config'));
  writeFileSync(join(legacy, 'config', 'factory.config.yaml'), '');
  assert.equal(resolveRoot({ env: {}, cwd: legacy }), legacy);
  const xdg = temp();
  assert.throws(() => resolveRoot({ env: { XDG_CONFIG_HOME: xdg }, cwd: join(PACKAGE_DIR, 'src') }), /Run `sourcerer init`/);
});
