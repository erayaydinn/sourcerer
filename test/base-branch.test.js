import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { defaultBranch, loadConfig } from '../src/core/config.js';

const temp = (name) => mkdtempSync(join(tmpdir(), `sourcerer-${name}-`));

async function repo(branch) {
  const dir = temp('repo');
  await execa('git', ['init', '-q', '-b', branch], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'x');
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

test('defaultBranch: origin/HEAD first, then main or master, then the current branch', async () => {
  const master = await repo('master');
  assert.equal(defaultBranch(master), 'master');

  // A clone whose origin's default branch is develop, while it is checked out on a feature branch.
  const upstream = await repo('develop');
  const clone = temp('clone');
  await execa('git', ['clone', '-q', upstream, clone]);
  await execa('git', ['checkout', '-q', '-b', 'feature'], { cwd: clone });
  assert.equal(defaultBranch(clone), 'develop');
  await execa('git', ['branch', '-q', '-D', 'develop'], { cwd: clone });
  assert.equal(defaultBranch(clone), 'origin/develop', 'only the remote branch exists');

  assert.equal(defaultBranch(await repo('trunk')), 'trunk');
  assert.equal(defaultBranch(temp('plain')), undefined, 'not a git repo');
});

test('loadConfig fills in a detected base; an explicit base wins', async () => {
  const root = temp('ws');
  writeFileSync(join(root, '.env'), `SOURCERER_FRONTEND=${await repo('master')}\nSOURCERER_BACKEND=${await repo('main')}\n`);
  writeFileSync(join(root, 'sourcerer.yaml'), '# test\n');
  const detected = loadConfig(root);
  assert.deepEqual([detected.repos.frontend.base, detected.repos.backend.base], ['master', 'main']);

  writeFileSync(join(root, 'sourcerer.yaml'), 'repos: { frontend: { base: release } }\n');
  assert.equal(loadConfig(root).repos.frontend.base, 'release');
});
