import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { buildIndex, excluded, readMeta } from '../src/rag/index.js';
import { bestWindow, relevantContext, searchIndex } from '../src/rag/search.js';
import { definitions, tokenize } from '../src/rag/tokenize.js';

const temp = (name) => mkdtempSync(join(tmpdir(), `sourcerer-${name}-`));
const git = (cwd, ...args) => execa('git', args, { cwd });
const commit = (cwd, message) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-am', message);

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

async function repo(files) {
  const dir = temp('repo');
  await git(dir, 'init', '-q', '-b', 'main');
  write(dir, files);
  await git(dir, 'add', '.');
  await commit(dir, 'init');
  return dir;
}

const rag = { enabled: true, maxFileBytes: 5000, exclude: ['vendor/', '*.min.js', 'composer.lock'], context: { maxFiles: 3, maxChars: 600, snippetLines: 4 } };
const config = (backend) => ({ repos: { backend: { path: backend, base: 'main' } }, rag });

test('tokenize splits identifiers, keeps the whole one, drops noise words', () => {
  assert.deepEqual(tokenize('getUserName'), ['user', 'name', 'getusername']);
  assert.deepEqual(tokenize('rate_limit HTTPServer v2'), ['rate', 'limit', 'rate_limit', 'http', 'server', 'httpserver', 'v2']);
  assert.deepEqual(tokenize('return this.value when the user is null'), ['user']);
});

test('definitions per language', () => {
  assert.deepEqual(definitions('a.php', 'class LoginController {\n  public function attempt() {}\n}\ntrait Throttles {}'), ['LoginController', 'attempt', 'Throttles']);
  assert.deepEqual(definitions('a.py', 'class Session:\n    async def refresh(self):\n        pass'), ['Session', 'refresh']);
  assert.deepEqual(definitions('a.go', 'func (s *Store) Get() {}\ntype Limiter struct{}\nfunc New() {}'), ['Get', 'New', 'Limiter']);
  assert.deepEqual(definitions('a.ts', 'export class Api {}\nconst fetchUser = async (id) => id\nfunction boot() {}'), ['Api', 'boot', 'fetchUser']);
  assert.deepEqual(definitions('README.md', 'class Nope'), []);
});

test('excluded matches folders, extensions and file names', () => {
  assert.ok(excluded('app/vendor/lib/x.php', ['vendor/']));
  assert.ok(!excluded('app/vendors.php', ['vendor/']));
  assert.ok(excluded('public/app.min.js', ['*.min.js']));
  assert.ok(excluded('composer.lock', ['composer.lock']));
});

test('index: ranks by BM25 with path and definition boosts; incremental by base commit and blob', async () => {
  const backend = await repo({
    'src/Auth/RateLimiter.php': '<?php\nclass RateLimiter {\n  public function tooManyAttempts($key) { return $this->hits($key) > 5; }\n}\n',
    'src/Auth/LoginController.php': '<?php\nclass LoginController {\n  public function login($request) { $user = $this->attempt($request); }\n}\n',
    'src/Mail/Mailer.php': '<?php\nclass Mailer { public function send($to) {} }\n',
    'vendor/big/RateLimiterCopy.php': '<?php class RateLimiter {}',
    'public/app.min.js': 'function rateLimiter(){}',
    'logo.png': Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]),
  });
  const root = temp('ws');
  const first = await buildIndex(config(backend), root, 'backend');
  assert.equal(first.files, 3, 'vendor, minified and binary files are left out');
  assert.deepEqual(first.skipped, { excluded: 2, tooBig: 0, binary: 1 });

  const { hits } = await searchIndex(config(backend), root, 'backend', 'add rate limiting to login attempts');
  assert.equal(hits[0].path, 'src/Auth/RateLimiter.php');
  assert.equal(hits[1].path, 'src/Auth/LoginController.php');
  assert.ok(!hits.some((h) => h.path.includes('Mailer')));

  assert.equal((await buildIndex(config(backend), root, 'backend')).upToDate, true);
  write(backend, { 'src/Mail/Mailer.php': '<?php\nclass Mailer { public function sendLoginAlert($to) {} }\n' });
  await commit(backend, 'change mailer');
  const second = await buildIndex(config(backend), root, 'backend');
  assert.equal(second.analyzed, 1, 'only the changed file is read again');
  assert.equal(readMeta(root, 'backend').files.length, 3);
});

test('a worktree overlay replaces changed files, adds new ones and drops deleted ones', async () => {
  const backend = await repo({
    'src/billing/invoice.go': 'package billing\nfunc CreateInvoice() {}\n',
    'src/billing/refund.go': 'package billing\nfunc Refund() {}\n',
  });
  const root = temp('ws');
  await buildIndex(config(backend), root, 'backend');
  const tree = join(temp('wt'), 'backend');
  await git(backend, 'worktree', 'add', '-q', '-b', 'feat/x', tree, 'main');
  write(tree, { 'src/billing/coupon.go': 'package billing\nfunc ApplyCoupon(invoice Invoice) {}\n', 'src/billing/invoice.go': 'package billing\nfunc CreateInvoice() { ApplyCoupon() }\n' });
  rmSync(join(tree, 'src/billing/refund.go'));

  const base = await searchIndex(config(backend), root, 'backend', 'coupon refund');
  assert.deepEqual(base.hits.map((h) => h.path), ['src/billing/refund.go']);
  const overlay = await searchIndex(config(backend), root, 'backend', 'coupon refund', { worktree: tree });
  assert.deepEqual(overlay.hits.map((h) => h.path).sort(), ['src/billing/coupon.go', 'src/billing/invoice.go']);
});

test('bestWindow picks the densest lines; relevantContext respects the file and character budget', async () => {
  const weights = new Map([['coupon', 3], ['invoice', 1]]);
  const sample = ['a', 'b', 'coupon here', 'invoice coupon', 'c', 'd', 'e'].join('\n');
  assert.deepEqual(bestWindow(sample, weights, 2), { start: 3, end: 4, text: 'coupon here\ninvoice coupon' });

  const lines = (word) => Array.from({ length: 30 }, (_, i) => `${word} line ${i}`).join('\n');
  const backend = await repo({ 'src/coupon.js': lines('coupon'), 'src/coupon_rules.js': lines('coupon'), 'src/couponApi.js': lines('coupon') });
  const root = temp('ws');
  await buildIndex(config(backend), root, 'backend');
  const { text, files } = await relevantContext(config(backend), root, 'backend', 'coupon', null);
  assert.ok(files.length >= 1 && files.length <= 3);
  assert.match(text, /^Likely relevant files \(BM25 search of the backend repo/);
  assert.match(text, /### src\/coupon\S*\.js \(lines \d+-\d+; matched: coupon/);
  assert.ok(text.length < 600 + 400, 'snippets stay within maxChars (plus headers)');
  assert.deepEqual(await relevantContext({ ...config(backend), rag: { ...rag, enabled: false } }, root, 'backend', 'coupon', null), { text: '', files: [] });
});
