import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { gitDirOf, sandboxActive, sandboxProfile, sandboxed } from '../src/core/sandbox.js';

const security = { sandbox: { enabled: true, allowRead: [], allowWrite: [] } };
const mac = process.platform === 'darwin';

test('profile denies the home folder and allows the given paths', () => {
  const profile = sandboxProfile({ write: ['/h/work'], read: ['/h/other'], home: '/h' });
  assert.match(profile, /\(deny file-read\* \(subpath "\/h"\)/);
  assert.match(profile, /\(deny file-write\* \(subpath "\/h"\)/);
  assert.match(profile, /\(allow file-read-metadata \(subpath "\/h"\)\)/);
  assert.match(profile, /\(allow file-read\* .*\(subpath "\/h\/other"\).*\(subpath "\/h\/work"\)/);
  assert.match(profile, /\(allow file-write\* .*\(subpath "\/h\/work"\)/);
  assert.doesNotMatch(profile.split('\n').find((l) => l.startsWith('(allow file-write*')), /\/h\/other/);
});

test('sandboxActive: off without settings, auto follows the platform, false is off', () => {
  assert.equal(sandboxActive(undefined), false);
  assert.equal(sandboxActive({ sandbox: { enabled: false } }), false);
  assert.equal(sandboxActive({ sandbox: { enabled: 'auto' } }), mac);
});

test('inside the sandbox: work folder ok, rest of home denied, children too, node and git work', { skip: !mac }, async () => {
  const base = mkdtempSync(join(homedir(), '.sourcerer-sandbox-test-'));
  try {
    const work = join(base, 'repo');
    mkdirSync(work);
    writeFileSync(join(base, 'secret.txt'), 'TOP-SECRET');
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: work });
    writeFileSync(join(work, 'a.txt'), 'hello');
    await execa('git', ['add', '.'], { cwd: work });
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'], { cwd: work });
    const tree = join(base, 'tree');
    await execa('git', ['worktree', 'add', '-q', '-b', 'feat/x', tree, 'main'], { cwd: work });

    const run = (cmd, args, cwd = tree) => {
      const [bin, binArgs] = sandboxed(cmd, args, { security, write: [cwd, gitDirOf(cwd)].filter(Boolean) });
      return execa(bin, binArgs, { cwd, reject: false, all: true });
    };
    assert.equal(gitDirOf(tree), join(work, '.git'));
    assert.equal((await run('cat', ['a.txt'])).stdout, 'hello');
    assert.equal((await run('sh', ['-c', 'echo new > b.txt && cat b.txt'])).stdout, 'new');
    assert.match((await run('cat', [join(base, 'secret.txt')])).all, /Operation not permitted/);
    assert.match((await run('sh', ['-c', `cat ${join(base, 'secret.txt')}`])).all, /Operation not permitted/, 'child processes are confined');
    assert.match((await run('sh', ['-c', `echo x > ${join(base, 'leak.txt')}`])).all, /Operation not permitted/);
    assert.match((await run('ls', [join(homedir(), '.ssh')])).all, /Operation not permitted|No such file/);
    assert.equal((await run(process.execPath, ['-e', 'console.log(1 + 1)'])).stdout, '2', 'node from the toolchain runs');
    const status = await run('git', ['status', '--short']);
    assert.equal(status.exitCode, 0, status.all);
    assert.match(status.stdout, /b\.txt/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
