import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { createWorktrees, removeWorktrees, taskSlug, workspaceFor } from '../src/git/worktree.js';

async function makeRepo(root, name) {
  const path = join(root, name);
  await execa('git', ['init', '-q', '-b', 'main', path]);
  writeFileSync(join(path, 'README.md'), name);
  writeFileSync(join(path, '.gitignore'), 'node_modules/\n');
  await execa('git', ['add', '.'], { cwd: path });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: path });
  return path;
}

async function makeConfig(setup) {
  const root = mkdtempSync(join(tmpdir(), 'sourcerer-wt-'));
  return {
    repos: {
      frontend: { path: await makeRepo(root, 'fe'), base: 'main', setup },
      backend: { path: await makeRepo(root, 'be'), base: 'main' },
    },
    paths: { worktrees: join(root, 'worktrees') },
  };
}

const branchExists = async (repo, branch) =>
  (await execa('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo, reject: false })).exitCode === 0;

test('taskSlug makes a short branch-safe name', () => {
  assert.equal(taskSlug('  Add Login page (OAuth)! '), 'add-login-page-oauth');
  assert.equal(taskSlug('x'.repeat(60)).length, 40);
  assert.throws(() => taskSlug('!!!'), /cannot make a branch name/);
});

test('creates branch + worktree per side, runs setup, removes but keeps branch', async () => {
  const config = await makeConfig({ run: ['mkdir', 'node_modules'], timeoutSec: 10 });
  const worktrees = await createWorktrees(config, 'login', ['frontend', 'backend']);
  assert.equal(worktrees.frontend, join(config.paths.worktrees, 'login', 'frontend'));
  const { stdout } = await execa('git', ['branch', '--show-current'], { cwd: worktrees.backend });
  assert.equal(stdout, 'feat/login');
  assert.ok(existsSync(join(worktrees.frontend, 'node_modules')));

  await removeWorktrees(config, 'login');
  assert.ok(!existsSync(join(config.paths.worktrees, 'login')));
  assert.ok(await branchExists(config.repos.frontend.path, 'feat/login'));
});

test('only creates the sides asked for', async () => {
  const config = await makeConfig();
  const worktrees = await createWorktrees(config, 'api-only', ['backend']);
  assert.deepEqual(Object.keys(worktrees), ['backend']);
  assert.ok(!(await branchExists(config.repos.frontend.path, 'feat/api-only')));
});

test('refuses an existing branch and undoes partial work', async () => {
  const config = await makeConfig();
  await execa('git', ['branch', 'feat/taken'], { cwd: config.repos.backend.path });
  await assert.rejects(createWorktrees(config, 'taken', ['frontend', 'backend']), /already exists in the backend repo/);
  assert.ok(!(await branchExists(config.repos.frontend.path, 'feat/taken')));
  assert.ok(!existsSync(join(config.paths.worktrees, 'taken')));
});

test('failed setup undoes the worktree', async () => {
  const config = await makeConfig({ run: ['false'], timeoutSec: 10 });
  await assert.rejects(createWorktrees(config, 'broken', ['frontend']));
  assert.ok(!(await branchExists(config.repos.frontend.path, 'feat/broken')));
  assert.ok(!existsSync(join(config.paths.worktrees, 'broken')));
});

test('refuses to remove a dirty worktree unless forced', async () => {
  const config = await makeConfig();
  const worktrees = await createWorktrees(config, 'dirty', ['frontend']);
  writeFileSync(join(worktrees.frontend, 'new.js'), 'work');
  await assert.rejects(removeWorktrees(config, 'dirty'), /cannot remove frontend worktree/);
  assert.ok(existsSync(join(worktrees.frontend, 'new.js')));
  await removeWorktrees(config, 'dirty', { force: true });
  assert.ok(!existsSync(worktrees.frontend));
});

test('workspaceFor gives coders their own worktree and the other side read-only', () => {
  const worktrees = { frontend: '/w/t/frontend', backend: '/w/t/backend' };
  assert.deepEqual(workspaceFor({ role: 'coder', repo: 'frontend' }, worktrees, '/w/t'),
    { cwd: '/w/t/frontend', readDirs: ['/w/t/backend'] });
  assert.deepEqual(workspaceFor({ role: 'reviewer' }, worktrees, '/w/t'), { cwd: '/w/t', readDirs: [] });
  assert.throws(() => workspaceFor({ name: 'c', role: 'coder', repo: 'backend' }, { frontend: '/x' }, '/w'), /no backend worktree/);
});
