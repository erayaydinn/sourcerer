import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { runTool } from '../src/tools/index.js';

async function repo(files, commits) {
  const dir = mkdtempSync(join(tmpdir(), 'sourcerer-search-'));
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  await execa('git', ['add', '.'], { cwd: dir });
  for (const message of commits) {
    await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message], { cwd: dir });
  }
  return dir;
}

const backend = await repo({
  'src/users.js': 'export async function getUser(id) {}\nconst listUsers = async () => []\nexport const getUserName = (u) => u.name\n',
  'svc.go': 'func (s *Svc) Load() error {}\ntype Config struct {}\n',
  'app.py': 'def handle(req):\n    return getUser(1)\nclass Handler:\n    pass\n',
  'docs/auth.md': '# Auth\nTokens expire after 1h.\n',
  'adr/0001-db.md': 'We use Postgres.\n',
}, ['init', 'Switch auth to JWT tokens']);
const frontend = await repo({ 'app.js': 'fetch("/api/users")\ngetUser()\n', 'README.md': 'Frontend for TOKENS demo\n' }, ['init']);
const runDir = mkdtempSync(join(tmpdir(), 'sourcerer-run-'));
writeFileSync(join(runDir, 'contract.txt'), 'GET /api/users -> User[]\nAuth: bearer token\n');

const ctx = (sources) => ({
  cwd: backend, readDirs: [], sources,
  allowedTools: ['search_code', 'find_symbol', 'search_docs'],
  toolConfig: { maxOutputChars: 10_000, runCommand: { allow: [], timeoutSec: 1 } },
});
const both = { code: [{ name: 'frontend', dir: frontend }, { name: 'backend', dir: backend }], docs: [], contract: null };
const backendOnly = { code: [{ name: 'backend', dir: backend }], docs: [], contract: null };

test('search_code searches every source in scope with a prefix', async () => {
  const out = await runTool('search_code', { pattern: 'api/users' }, ctx(both));
  assert.equal(out, 'frontend:app.js:1:fetch("/api/users")');
});

test('search_code respects scope and narrows with source', async () => {
  assert.equal(await runTool('search_code', { pattern: 'fetch' }, ctx(backendOnly)), 'no matches');
  assert.match(await runTool('search_code', { pattern: 'getUser', source: 'frontend' }, ctx(both)), /^frontend:app\.js:2/);
  assert.match(await runTool('search_code', { pattern: 'x', source: 'frontend' }, ctx(backendOnly)), /no code source "frontend" \(have: backend\)/);
});

test('new uncommitted files are searchable, gitignored ones are not', async () => {
  const dir = await repo({ '.gitignore': 'dist/\n', 'old.js': 'x' }, []);
  writeFileSync(join(dir, 'fresh.js'), 'export function brandNew() {}\n');
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'bundle.js'), 'function brandNew() {}\n');
  const sources = { code: [{ name: 'backend', dir }], docs: [{ name: 'backend', dir, paths: [] }], contract: null };
  assert.equal(await runTool('find_symbol', { name: 'brandNew' }, ctx(sources)), 'backend:fresh.js:1:export function brandNew() {}');
  assert.equal(await runTool('search_docs', { pattern: 'nothing' }, ctx(sources)), 'no matches', 'repo without commits');
});

test('search_code understands \\s and \\b where git has PCRE', async () => {
  assert.match(await runTool('search_code', { pattern: 'function\\s+getUser\\b' }, ctx(backendOnly)), /src\/users\.js:1/);
});

test('find_symbol finds definitions, not calls, across languages', async () => {
  const lines = (name) => runTool('find_symbol', { name }, ctx(both)).then((out) => out.split('\n'));
  assert.deepEqual(await lines('getUser'), ['backend:src/users.js:1:export async function getUser(id) {}']);
  assert.deepEqual(await lines('listUsers'), ['backend:src/users.js:2:const listUsers = async () => []']);
  assert.deepEqual(await lines('getUserName'), ['backend:src/users.js:3:export const getUserName = (u) => u.name']);
  assert.deepEqual(await lines('Load'), ['backend:svc.go:1:func (s *Svc) Load() error {}']);
  assert.deepEqual(await lines('Config'), ['backend:svc.go:2:type Config struct {}']);
  assert.deepEqual(await lines('handle'), ['backend:app.py:1:def handle(req):']);
  assert.deepEqual(await lines('Handler'), ['backend:app.py:3:class Handler:']);
  assert.match(await runTool('find_symbol', { name: 'a|b' }, ctx(both)), /not a symbol name/);
});

test('search_docs covers doc paths, ADRs, the contract and commit messages', async () => {
  const sources = {
    code: [],
    docs: [
      { name: 'backend', dir: backend, paths: ['docs', 'adr', 'README.md'] },
      { name: 'frontend', dir: frontend, paths: ['docs', 'adr', 'README.md'] },
    ],
    contract: join(runDir, 'contract.txt'),
  };
  const out = (await runTool('search_docs', { pattern: 'tokens?' }, ctx(sources))).split('\n');
  assert.ok(out.includes('contract:contract.txt:2:Auth: bearer token'), out.join('\n'));
  assert.ok(out.includes('backend-docs:docs/auth.md:2:Tokens expire after 1h.'));
  assert.ok(out.includes('frontend-docs:README.md:1:Frontend for TOKENS demo'));
  assert.ok(out.some((l) => /^backend-commits:[0-9a-f]+ \d{4}-\d{2}-\d{2} Switch auth to JWT tokens$/.test(l)));
  assert.match(await runTool('search_docs', { pattern: 'postgres' }, ctx(sources)), /backend-docs:adr\/0001-db\.md:1/);
  assert.equal(await runTool('search_docs', { pattern: 'tokens' }, ctx({ code: [], docs: [], contract: null })), 'no matches');
});
