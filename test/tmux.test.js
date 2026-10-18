import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchArgs, quote, tailCommand } from '../src/ui/tmux.js';

test('quote handles single quotes and spaces', () => {
  assert.equal(quote("it's a task"), `'it'\\''s a task'`);
});

test('launch outside tmux creates a session that keeps a shell open', () => {
  const args = launchArgs({ name: 'sourcerer-x', command: 'node run.js', cwd: '/p', inside: false });
  assert.deepEqual(args.slice(0, 7), ['new-session', '-s', 'sourcerer-x', '-n', 'sourcerer', '-c', '/p']);
  assert.ok(args.includes('SOURCERER_SESSION=sourcerer-x'));
  assert.equal(args.at(-1), 'node run.js; exec "${SHELL:-sh}"');
});

test('launch inside tmux opens a window instead', () => {
  const args = launchArgs({ name: 'sourcerer-x', command: 'c', cwd: '/p', inside: true });
  assert.equal(args[0], 'new-window');
  assert.ok(args.includes('SOURCERER_SESSION='));
});

test('tail command follows files that do not exist yet', () => {
  assert.equal(tailCommand('/runs/a b/coder.log'), "tail -n +1 -F '/runs/a b/coder.log'");
});
