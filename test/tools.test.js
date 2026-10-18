import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { runTool } from '../src/tools/index.js';

const cwd = mkdtempSync(join(tmpdir(), 'sourcerer-tools-'));
const outside = mkdtempSync(join(tmpdir(), 'sourcerer-outside-'));
const readOnly = mkdtempSync(join(tmpdir(), 'sourcerer-readonly-'));
const ctx = {
  cwd,
  readDirs: [readOnly],
  allowedTools: ['read_file', 'write_file', 'run_command', 'search_code'],
  toolConfig: { maxOutputChars: 1000, runCommand: { allow: ['git'], timeoutSec: 10 } },
};

test('write then read a file inside cwd', async () => {
  assert.equal(await runTool('write_file', { path: 'a/b.txt', content: 'hello' }, ctx), 'wrote a/b.txt');
  assert.equal(await runTool('read_file', { path: 'a/b.txt' }, ctx), 'hello');
});

test('paths outside cwd are refused, including via symlink', async () => {
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(outside, join(cwd, 'link'));
  assert.match(await runTool('read_file', { path: '../x' }, ctx), /outside workspace/);
  assert.match(await runTool('read_file', { path: join(outside, 'secret.txt') }, ctx), /outside workspace/);
  assert.match(await runTool('read_file', { path: 'link/secret.txt' }, ctx), /outside workspace/);
  assert.match(await runTool('write_file', { path: 'link/new.txt', content: 'x' }, ctx), /outside workspace/);
});

test('readDirs can be read but not written', async () => {
  writeFileSync(join(readOnly, 'api.txt'), 'contract');
  assert.equal(await runTool('read_file', { path: join(readOnly, 'api.txt') }, ctx), 'contract');
  assert.match(await runTool('write_file', { path: join(readOnly, 'api.txt'), content: 'x' }, ctx), /outside workspace/);
});

test('run_command only runs allowlisted commands', async () => {
  assert.match(await runTool('run_command', { command: 'rm', args: ['-rf', '.'] }, ctx), /not allowed/);
  assert.match(await runTool('run_command', { command: 'git', args: ['--version'] }, ctx), /^exit 0\ngit version/);
});

test('tools not given to the agent are refused', async () => {
  assert.match(await runTool('web_fetch', { url: 'https://example.com' }, ctx), /tool not allowed/);
});

test('search_code without sources searches the workspace', async () => {
  await execa('git', ['init', '-q'], { cwd });
  await execa('git', ['add', 'a/b.txt'], { cwd });
  assert.equal(await runTool('search_code', { pattern: 'hel+o' }, ctx), 'workspace:a/b.txt:1:hello');
  assert.equal(await runTool('search_code', { pattern: 'nothing-here' }, ctx), 'no matches');
});
