import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import * as claude from '../src/adapters/cli/claude.js';
import { cleanCommand } from '../src/cli/clean.js';
import { initCommand } from '../src/cli/init.js';
import { loadProject } from '../src/cli/project.js';
import { applySecurity, commandAllowed, isSecretFile, redact } from '../src/core/security.js';
import { ignoredFiles } from '../src/git/worktree.js';
import { buildIndex } from '../src/rag/index.js';
import { runTool } from '../src/tools/index.js';

const temp = (name) => mkdtempSync(join(tmpdir(), `sourcerer-${name}-`));
const quiet = () => {};

test('redact replaces secret-looking values and keeps the rest', () => {
  const text = [
    'AWS key AKIAABCDEFGHIJKLMNOP here',
    'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'DB_PASSWORD="hunter2-very-long"',
    'Authorization: Bearer abc.def.ghijklmnopqrstuvwxyz0123',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----',
    'const user = getUser(id); // nothing secret',
  ].join('\n');
  const out = redact(text);
  for (const secret of ['AKIAABCDEFGHIJKLMNOP', 'sk-proj-abcdef', 'ghp_abcdef', 'hunter2', 'abc.def.ghij', 'AAAAB3NzaC1yc2E']) {
    assert.ok(!out.includes(secret), secret);
  }
  assert.match(out, /DB_PASSWORD="\[REDACTED\]"/, 'the key name stays');
  assert.match(out, /const user = getUser\(id\); \/\/ nothing secret/);
});

test('secret file patterns and command prefixes', () => {
  const patterns = ['.env', '.env.*', '*.pem', 'id_rsa*', '*credentials*'];
  for (const path of ['.env', 'app/.env.local', 'certs/server.pem', '.ssh/id_rsa.pub', 'config/aws_credentials.json']) assert.ok(isSecretFile(path, patterns), path);
  for (const path of ['src/env.js', 'docs/environment.md', 'README.md']) assert.ok(!isSecretFile(path, patterns), path);
  const allowed = ['git status', 'npm test', 'go test'];
  assert.ok(commandAllowed('git status --short', allowed));
  assert.ok(commandAllowed('npm   test', allowed));
  assert.ok(!commandAllowed('git status-hack', allowed));
  assert.ok(!commandAllowed('git push origin main', allowed));
  assert.ok(!commandAllowed('curl https://example.com', allowed));
});

test('claude rules: confined reads/searches, allowlisted Bash, no web; unrestricted without security', () => {
  const security = { confineFiles: true, commandAllowlist: true, allowCommands: ['npm test', 'git status'] };
  const { args } = claude.command({ prompt: 'x', model: 'm', allowedTools: ['read_file', 'search_code', 'run_command', 'write_file'], readDirs: ['/w/other'], security });
  const rules = args.slice(args.indexOf('--allowedTools') + 1);
  assert.deepEqual(rules, [
    'Read(./**)', 'Read(//w/other/**)', 'Grep(./**)', 'Grep(//w/other/**)', 'Glob(./**)', 'Glob(//w/other/**)',
    'Bash(npm test)', 'Bash(npm test *)', 'Bash(git status)', 'Bash(git status *)', 'Edit(./**)', 'Write(./**)',
  ]);
  const open = claude.command({ prompt: 'x', model: 'm', allowedTools: ['read_file', 'run_command'], readDirs: [] });
  assert.deepEqual(open.args.slice(open.args.indexOf('--allowedTools') + 1), ['Read', 'Bash']);
});

function workspace(yaml = '# test\n') {
  const root = temp('ws');
  writeFileSync(join(root, 'sourcerer.yaml'), yaml);
  writeFileSync(join(root, '.env'), `SOURCERER_FRONTEND=${root}\nSOURCERER_BACKEND=${root}\n`);
  return root;
}

test('defaults: web tools removed; without the sandbox cursor-agent is refused unless trusted', () => {
  const root = workspace([
    'repos: { backend: { test: { run: [make, check], timeoutSec: 60 } } }',
    'agents: { reviewer: { llm: cursor-main } }',
    'security: { sandbox: { enabled: false } }',
  ].join('\n'));
  const project = loadProject(root);
  assert.ok(project.defs.every((def) => !def.tools.some((tool) => tool.startsWith('web_'))), 'no web tools');
  assert.match(project.errors.join('\n'), /reviewer: llm "cursor-main" uses cursor-agent, which cannot be limited/);

  writeFileSync(join(root, 'sourcerer.yaml'), 'agents: { reviewer: { llm: cursor-main } }\nsecurity: { trustUnconfinedCli: true, webAccess: true, sandbox: { enabled: false } }\n');
  const trusted = loadProject(root);
  assert.deepEqual(trusted.errors, []);
  assert.ok(trusted.defs.find((d) => d.name === 'coder-backend').tools.includes('web_fetch'), 'web tools back when allowed');
  assert.deepEqual(applySecurity([{ tools: ['read_file', 'web_fetch'] }], { security: { webAccess: false } }), [{ tools: ['read_file'] }]);
});

test('API agents: run_command follows the allowlist; reviewer gets secret files by name only', async () => {
  const cwd = temp('cwd');
  const ctx = {
    cwd, readDirs: [], allowedTools: ['run_command'],
    toolConfig: { maxOutputChars: 1000, runCommand: { allow: ['git'], timeoutSec: 10 } },
    security: { commandAllowlist: true, allowCommands: ['git --version'] },
  };
  assert.match(await runTool('run_command', { command: 'git', args: ['--version'] }, ctx), /^exit 0/);
  assert.match(await runTool('run_command', { command: 'git', args: ['push'] }, ctx), /command not allowed: git push/);

  await execa('git', ['init', '-q'], { cwd });
  writeFileSync(join(cwd, '.gitignore'), '.env\nnotes.txt\n');
  writeFileSync(join(cwd, '.env'), 'API_KEY=supersecretvalue123');
  writeFileSync(join(cwd, 'notes.txt'), 'plain notes');
  const ignored = await ignoredFiles(cwd, 1000, ['.env', '.env.*']);
  assert.deepEqual(ignored.find((f) => f.path === '.env'), { path: '.env', content: null, secret: true });
  assert.equal(ignored.find((f) => f.path === 'notes.txt').content, 'plain notes');
});

test('the search index never reads secret files', async () => {
  const repo = temp('repo');
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, '.env.production'), 'STRIPE_KEY=sk_live_abcdefghijklmnop');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'pay.js'), 'export function charge() {}');
  await execa('git', ['add', '-f', '.'], { cwd: repo });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x'], { cwd: repo });
  const root = temp('ws');
  const config = {
    repos: { backend: { path: repo, base: 'main' } },
    rag: { enabled: true, maxFileBytes: 10000, exclude: [], context: { maxFiles: 1, maxChars: 100, snippetLines: 5 } },
    security: { secretFiles: ['.env', '.env.*'] },
  };
  const built = await buildIndex(config, root, 'backend');
  assert.equal(built.files, 1);
  assert.ok(!readFileSync(join(root, 'index', 'backend', 'meta.json'), 'utf8').includes('.env'));
});

test('init makes the workspace private; clean deletes runs and the index only with --yes', () => {
  const root = join(temp('parent'), 'ws');
  initCommand(root, {}, quiet);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, '.env')).mode & 0o777, 0o600);

  writeFileSync(join(root, '.env'), `SOURCERER_FRONTEND=${root}\nSOURCERER_BACKEND=${root}\n`);
  mkdirSync(join(root, 'runs', '20200101-000000-old'), { recursive: true });
  mkdirSync(join(root, 'index', 'backend'), { recursive: true });
  const lines = [];
  cleanCommand({ root, runs: true, index: true }, (l) => lines.push(l));
  assert.match(lines.join('\n'), /would delete 2 item\(s\)/);
  assert.ok(existsSync(join(root, 'index')), 'dry run deletes nothing');
  cleanCommand({ root, runs: true, index: true, olderThan: '30d', yes: true }, quiet);
  assert.ok(!existsSync(join(root, 'index')) && !existsSync(join(root, 'runs', '20200101-000000-old')));
  assert.throws(() => cleanCommand({ root }, quiet), /--runs and\/or --index/);
});

test('with the macOS sandbox on, cursor-agent is allowed (the OS confines it)', { skip: process.platform !== 'darwin' }, () => {
  const root = workspace('agents: { reviewer: { llm: cursor-main } }\n');
  assert.deepEqual(loadProject(root).errors, []);
});
