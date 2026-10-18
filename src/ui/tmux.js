import { join } from 'node:path';
import { execa } from 'execa';

// Thin tmux layer: it only reads runs/<id>/<agent>.log files. Windows needs WSL.

export function insideTmux() {
  return Boolean(process.env.TMUX);
}

export function quote(text) {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

// Runs `command` in a new session (or a new window when already inside tmux).
// The pane keeps a shell open after the command ends, so nothing disappears.
export function launchArgs({ name, command, cwd, inside }) {
  const keepOpen = `${command}; exec "\${SHELL:-sh}"`;
  const env = ['-e', 'SOURCERER_PANES=1', '-e', `SOURCERER_SESSION=${inside ? '' : name}`];
  return inside
    ? ['new-window', '-n', name, '-c', cwd, ...env, keepOpen]
    : ['new-session', '-s', name, '-n', 'sourcerer', '-c', cwd, ...env, keepOpen];
}

export async function launch(options) {
  const result = await execa('tmux', launchArgs(options), { stdio: 'inherit', reject: false });
  return result.exitCode ?? 1;
}

export function tailCommand(file) {
  return `tail -n +1 -F ${quote(file)}`;
}

function tmux(args) {
  return execa('tmux', args, { timeout: 10_000 });
}

// Splits the current window: orchestrator on top, one `tail -F` pane per agent below.
export async function openLogPanes(runDir, agentNames) {
  const top = process.env.TMUX_PANE;
  await tmux(['set-option', '-w', '-t', top, 'pane-border-status', 'top']);
  await tmux(['set-option', '-w', '-t', top, 'pane-border-format', ' #{pane_title} ']);
  await tmux(['select-pane', '-t', top, '-T', 'orchestrator']);
  // Each split lands right below the top pane, so add them in reverse to keep the given order.
  for (const name of [...agentNames].reverse()) {
    const command = tailCommand(join(runDir, `${name}.log`));
    const { stdout: id } = await tmux(['split-window', '-v', '-d', '-t', top, '-P', '-F', '#{pane_id}', command]);
    await tmux(['select-pane', '-t', id, '-T', name]);
    await tmux(['select-layout', '-t', top, 'main-horizontal']);
  }
}

// --interactive: a separate "worktrees" window with one shell per worktree.
export async function openShellWindow(worktrees) {
  const [first, ...rest] = Object.entries(worktrees);
  const { stdout: id } = await tmux(['new-window', '-d', '-n', 'worktrees', '-c', first[1], '-P', '-F', '#{pane_id}']);
  await tmux(['set-option', '-w', '-t', id, 'pane-border-status', 'top']);
  await tmux(['set-option', '-w', '-t', id, 'pane-border-format', ' #{pane_title} ']);
  await tmux(['select-pane', '-t', id, '-T', first[0]]);
  for (const [side, dir] of rest) {
    const { stdout: paneId } = await tmux(['split-window', '-h', '-d', '-t', id, '-c', dir, '-P', '-F', '#{pane_id}']);
    await tmux(['select-pane', '-t', paneId, '-T', side]);
  }
}
