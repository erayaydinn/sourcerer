import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate } from '../src/core/env.js';

const run = (value, env) => {
  const missing = [];
  return { value: interpolate(value, env, missing), missing };
};

test('replaces ${VAR} in nested strings and leaves other values alone', () => {
  const { value, missing } = run({ a: '${X}/sub', list: ['${Y}', 3, true], n: null }, { X: '/root', Y: 'y' });
  assert.deepEqual(value, { a: '/root/sub', list: ['y', 3, true], n: null });
  assert.deepEqual(missing, []);
});

test('${VAR:-default} uses the default when unset or empty, and may be empty', () => {
  assert.equal(run('${A:-opus}', {}).value, 'opus');
  assert.equal(run('${A:-opus}', { A: '' }).value, 'opus');
  assert.equal(run('${A:-opus}', { A: 'sonnet' }).value, 'sonnet');
  assert.equal(run('${A:-}', {}).value, '');
});

test('unset variables without a default are reported with their key path', () => {
  const { missing } = run({ repos: { frontend: { path: '${FE}' } }, list: ['${B}'] }, {});
  assert.deepEqual(missing, ['FE (at repos.frontend.path)', 'B (at list.0)']);
});
