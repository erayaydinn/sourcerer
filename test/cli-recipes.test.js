import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as claude from '../src/adapters/cli/claude.js';
import * as cursor from '../src/adapters/cli/cursor.js';

test('claude command maps tools and sends prompt on stdin', () => {
  const { args, input } = claude.command({ prompt: 'hi', model: 'm', allowedTools: ['read_file', 'web_search'] });
  assert.equal(input, 'hi');
  assert.deepEqual(args.slice(-3), ['--allowedTools', 'Read', 'WebSearch']);
  assert.ok(args.includes('dontAsk'));
  assert.deepEqual(args.slice(0, 4), ['-p', '--verbose', '--output-format', 'stream-json']);
});

test('claude command adds read-only dirs and scopes writes to cwd', () => {
  const { args } = claude.command({ prompt: 'hi', model: 'm', allowedTools: ['write_file'], readDirs: ['/other'] });
  assert.deepEqual(args.slice(-5), ['--add-dir', '/other', '--allowedTools', 'Edit(./**)', 'Write(./**)']);
});

const stream = readFileSync(new URL('./fixtures/claude-stream.jsonl', import.meta.url), 'utf8');

test('claude parse reads result, usage and reported cost from the last stream line', () => {
  const parsed = claude.parse(stream);
  assert.equal(parsed.output, 'hello');
  assert.equal(parsed.costUsd, 0.0542121);
  assert.deepEqual(parsed.usage, { inputTokens: 12523, outputTokens: 132, cachedTokens: 28081 });
});

test('claude logLine shows assistant text and tool calls only', () => {
  const lines = stream.trim().split('\n').map(claude.logLine).filter(Boolean);
  assert.deepEqual(lines, ['→ Read {"file_path":"/work/note.txt"}', 'hello']);
});

test('claude parse throws on is_error', () => {
  assert.throws(() => claude.parse(JSON.stringify({ is_error: true, subtype: 'error_max_turns' })), /error_max_turns/);
});

const cursorStream = readFileSync(new URL('./fixtures/cursor-stream.jsonl', import.meta.url), 'utf8');

test('cursor command: read-only agents get --mode ask, prompt on stdin', () => {
  const { args, input } = cursor.command({ prompt: 'hi', model: 'grok-4.7-medium', cwd: '/w', allowedTools: ['read_file', 'search_code'] });
  assert.equal(input, 'hi');
  assert.deepEqual(args, ['-p', '--output-format', 'stream-json', '--trust', '--workspace', '/w', '--model', 'grok-4.7-medium', '--mode', 'ask']);
});

test('cursor command: coders running commands get --force, writers without commands get neither', () => {
  const coder = cursor.command({ prompt: 'x', model: 'm', cwd: '/w', allowedTools: ['read_file', 'write_file', 'run_command'] });
  assert.equal(coder.args.at(-1), '--force');
  assert.ok(!coder.args.includes('--mode'));
  const writer = cursor.command({ prompt: 'x', model: 'm', cwd: '/w', allowedTools: ['write_file'] });
  assert.ok(!writer.args.includes('--force') && !writer.args.includes('--mode'));
});

test('cursor parse reads result and usage; no cost so it gets estimated', () => {
  const parsed = cursor.parse(cursorStream);
  assert.equal(parsed.output, "I'll read `note.txt` and reply with only its contents.hello");
  assert.deepEqual(parsed.usage, { inputTokens: 31543, outputTokens: 153, cachedTokens: 19200 });
  assert.equal(parsed.costUsd, undefined);
});

test('cursor logLine shows assistant text and started tool calls only', () => {
  const lines = cursorStream.trim().split('\n').map(cursor.logLine).filter(Boolean);
  assert.deepEqual(lines, [
    "I'll read `note.txt` and reply with only its contents.",
    '→ glob {"globPattern":"**/note.txt"}',
    '→ read {"path":"/work/note.txt"}',
    'hello',
  ]);
});

test('cursor parse throws on errors and on a stream without result', () => {
  assert.throws(() => cursor.parse(JSON.stringify({ type: 'result', is_error: true, subtype: 'error', result: 'boom' })), /boom/);
  assert.throws(() => cursor.parse('{"type":"assistant","message":{"content":[]}}'), /without a result/);
});
