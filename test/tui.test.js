import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';
import { render } from 'ink-testing-library';
import { createElement as h } from 'react';
import { App, wrapLines } from '../src/ui/tui.js';

const temp = (name) => mkdtempSync(join(tmpdir(), `sourcerer-${name}-`));
const KEYS = { enter: '\r', tab: '\t', up: '\u001B[A', ctrlC: '\u0003', pageUp: '\u001B[5~', pageDown: '\u001B[6~', home: '\u001B[H', end: '\u001B[F' };

async function gitRepo() {
  const dir = temp('repo');
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'x');
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

async function workspace(extra = '') {
  const root = temp('ws');
  writeFileSync(join(root, 'sourcerer.yaml'), '# test workspace\n');
  writeFileSync(join(root, '.env'), `SOURCERER_FRONTEND=${await gitRepo()}\nSOURCERER_BACKEND=${await gitRepo()}\n${extra}`);
  return root;
}

const block = (data) => `\`\`\`json\n${JSON.stringify(data)}\n\`\`\``;
const result = (output, costUsd = 0.5) => ({ output, usage: null, costUsd, costSource: 'reported', durationMs: 1 });

// Planner picks backend; the coder streams a line and waits for `gate` (or a stop).
function fakeRun(gate) {
  return async (agent, opts) => {
    if (agent.role === 'planner') return result(block({ sides: ['backend'], contract: 'c', instructions: { backend: 'b' } }));
    if (agent.role === 'coder') {
      opts.onLog('→ Edit {"file_path":"src/auth.php"}');
      await Promise.race([gate, new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)))]);
      return result('coded');
    }
    return result(block({ verdict: 'approve', comments: {} }));
  };
}

async function until(app, pattern) {
  for (let i = 0; i < 200; i++) {
    if (pattern.test(app.lastFrame() ?? '')) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${pattern}\n${app.lastFrame()}`);
}

const type = async (app, text) => {
  app.stdin.write(text);
  await sleep(30);
  app.stdin.write(KEYS.enter);
};

test('TUI: a task shows agent states, cost, live agent log via Tab, and the input box', async () => {
  const root = await workspace();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const history = join(temp('hist'), 'history');
  const app = render(h(App, { rootFlag: root, run: fakeRun(gate), history }));
  await until(app, /sourcerer · idle/);
  await type(app, 'Add login');
  await until(app, /running "Add login" · round 1/);
  await until(app, /● coder-backend\s+r1/);
  assert.match(app.lastFrame(), /✓ planner\s+r0 \$0\.50/);
  assert.match(app.lastFrame(), /· reviewer/);
  assert.match(app.lastFrame(), /\$0\.5000/);

  app.stdin.write(KEYS.tab); // events -> planner
  await sleep(30);
  app.stdin.write(KEYS.tab); // -> coder-backend? (agent order follows the config)
  await sleep(30);
  for (let i = 0; i < 4 && !/coder-backend \(live\)/.test(app.lastFrame()); i++) {
    app.stdin.write(KEYS.tab);
    await sleep(30);
  }
  await until(app, /coder-backend \(live\)[\s\S]*→ Edit \{"file_path":"src\/auth\.php"\}/);

  release();
  await until(app, /sourcerer · idle/);
  assert.match(app.lastFrame(), /✓ reviewer/);
  app.unmount();
});

test('TUI: one task at a time, history with ↑, /command Tab completion, /exit', async () => {
  const root = await workspace();
  const history = join(temp('hist'), 'history');
  let code = null;
  const app = render(h(App, { rootFlag: root, run: fakeRun(new Promise(() => {})), history, onExit: (c) => { code = c; } }));
  await type(app, 'First task');
  await until(app, /● coder-backend/);
  await type(app, 'Second task');
  await until(app, /a task is already running: "First task"/);

  app.stdin.write('/sta');
  await sleep(30);
  app.stdin.write(KEYS.tab);
  await until(app, /> \/status /);
  app.stdin.write('\u001B'); // Esc clears
  await sleep(30);

  app.stdin.write(KEYS.up);
  await until(app, /> Second task/);
  app.stdin.write('\u001B');
  await sleep(30);

  app.stdin.write(KEYS.ctrlC);
  await until(app, /stopping\.\.\./);
  await until(app, /sourcerer · idle/);
  await type(app, '/exit');
  for (let i = 0; i < 40 && code === null; i++) await sleep(25);
  assert.equal(code, 0);
  assert.deepEqual(readFileSync(history, 'utf8').trim().split('\n'), ['First task', 'Second task', '/exit']);
});

test('TUI: budget question shows a banner and /reject stops the run', async () => {
  const root = await workspace('SOURCERER_MAX_COST_PER_RUN=0.1\n');
  const app = render(h(App, { rootFlag: root, run: fakeRun(Promise.resolve()), history: join(temp('hist'), 'history') }));
  await type(app, 'Costly');
  await until(app, /over maxCostPerRun \$0\.1\. Continue\? \(y\/n, \/approve, \/reject, \/stop\)/);
  await type(app, '/reject');
  await until(app, /stopped-budget/);
  await until(app, /sourcerer · idle/);
  assert.doesNotMatch(app.lastFrame(), /Continue\? \(y\/n, \/approve/);
  app.unmount();
});

test('TUI: a chunk that ends in Enter (paste, tmux send-keys) is typed and submitted', async () => {
  const root = await workspace();
  const app = render(h(App, { rootFlag: root, run: fakeRun(Promise.resolve()), history: join(temp('hist'), 'history') }));
  app.stdin.write('/llm\r');
  await until(app, /no overrides/);
  assert.match(app.lastFrame(), /> \/llm/);
  app.unmount();
});

test('wrapLines splits long lines to the panel width and keeps short ones', () => {
  assert.deepEqual(wrapLines(['abc', 'abcdefghij', ''], 4), ['abc', 'abcd', 'efgh', 'ij', '']);
});

test('TUI: a long event line is shown in full, wrapped across rows', async () => {
  const root = await workspace();
  const app = render(h(App, { rootFlag: root, run: fakeRun(Promise.resolve()), history: join(temp('hist'), 'history') }));
  const long = `/logs ${'x'.repeat(150)}END`;
  app.stdin.write(`${long}\r`);
  await until(app, /no run matches|no runs yet/);
  const frame = app.lastFrame().replace(/[│\s]/g, '');
  assert.ok(frame.includes(`>${long.replace(/\s/g, '')}`), 'the whole echoed line is visible');
  app.unmount();
});

test('TUI: PgUp/PgDn/Home/End scroll the panel; new lines do not move it; End follows again', async () => {
  const app = render(h(App, { rootFlag: await workspace(), run: fakeRun(Promise.resolve()), history: join(temp('hist'), 'history') }));
  await until(app, /sourcerer · idle/);
  for (let i = 1; i <= 40; i++) await type(app, `/no-such-${i}`);
  await until(app, /unknown command \/no-such-40/);

  app.stdin.write(KEYS.home);
  await until(app, /newer line\(s\) below · End: live/);
  assert.match(app.lastFrame(), /sourcerer: type a task, or \/help/, 'the first line is shown');
  const atTop = app.lastFrame();
  await type(app, '/no-such-41');
  await sleep(50);
  assert.match(app.lastFrame(), /sourcerer: type a task/, 'still at the top after new lines');
  assert.notEqual(app.lastFrame(), atTop, 'the count of newer lines went up');

  app.stdin.write(KEYS.pageDown);
  await sleep(50);
  assert.doesNotMatch(app.lastFrame(), /sourcerer: type a task/);
  app.stdin.write(KEYS.pageUp);
  await until(app, /sourcerer: type a task/);

  app.stdin.write(KEYS.end);
  await until(app, /unknown command \/no-such-41/);
  assert.doesNotMatch(app.lastFrame(), /End: live/);
  app.unmount();
});
