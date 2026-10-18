import { existsSync, readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { gitDirOf, sandboxed } from '../core/sandbox.js';
import { isSecretFile } from '../core/security.js';

const GIT_TIMEOUT_MS = 60_000;
const SIDES = ['frontend', 'backend'];

function git(cwd, args, options = {}) {
  return execa('git', args, { cwd, timeout: GIT_TIMEOUT_MS, ...options });
}

export function taskSlug(task) {
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`cannot make a branch name from task "${task}"`);
  return slug;
}

export function taskDir(config, slug) {
  return join(config.paths.worktrees, slug);
}

// Creates branch feat/<slug> and a worktree per side. Returns { side: dir }.
export async function createWorktrees(config, slug, sides, { signal } = {}) {
  const branch = `feat/${slug}`;
  const created = {};
  try {
    for (const side of sides) {
      const repo = config.repos[side];
      const dir = join(taskDir(config, slug), side);
      if (existsSync(dir)) throw new Error(`worktree folder already exists: ${dir}`);
      const found = await git(repo.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { reject: false });
      if (found.exitCode === 0) throw new Error(`branch ${branch} already exists in the ${side} repo`);

      await git(repo.path, ['worktree', 'add', '-b', branch, dir, repo.base]);
      created[side] = dir;
      if (repo.setup) {
        // Install scripts are code from the repo: run setup in the sandbox (when it is on).
        const [bin, args] = sandboxed(repo.setup.run[0], repo.setup.run.slice(1), { security: config.security, write: [dir, gitDirOf(dir)].filter(Boolean) });
        await execa(bin, args, { cwd: dir, timeout: repo.setup.timeoutSec * 1000, cancelSignal: signal });
      }
    }
  } catch (error) {
    await undoCreate(config, slug, created);
    throw error;
  }
  return created;
}

// Only undoes what createWorktrees just made, so deleting the new branch loses nothing.
async function undoCreate(config, slug, created) {
  for (const [side, dir] of Object.entries(created)) {
    const repoPath = config.repos[side].path;
    await git(repoPath, ['worktree', 'remove', '--force', dir], { reject: false });
    await git(repoPath, ['branch', '-D', `feat/${slug}`], { reject: false });
  }
  removeIfEmpty(taskDir(config, slug));
}

// Removes the worktrees but keeps the branch. git refuses dirty worktrees unless force.
export async function removeWorktrees(config, slug, { force = false } = {}) {
  for (const side of SIDES) {
    const dir = join(taskDir(config, slug), side);
    if (!existsSync(dir)) continue;
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), dir];
    const result = await git(config.repos[side].path, args, { reject: false });
    if (result.exitCode !== 0) throw new Error(`cannot remove ${side} worktree: ${result.stderr}`);
  }
  removeIfEmpty(taskDir(config, slug));
}

function removeIfEmpty(dir) {
  if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

// Coders write in their own worktree and may read the other one; others read the task folder.
export function workspaceFor(agent, worktrees, dir) {
  if (agent.role !== 'coder') return { cwd: dir, readDirs: [] };
  if (!worktrees[agent.repo]) throw new Error(`${agent.name}: no ${agent.repo} worktree for this task`);
  const readDirs = Object.entries(worktrees).filter(([side]) => side !== agent.repo).map(([, path]) => path);
  return { cwd: worktrees[agent.repo], readDirs };
}

// Diff of the worktree against base, including new files (git add -N marks them in the index only).
export async function diffWorktree(dir, base) {
  await git(dir, ['add', '-N', '.']);
  const { stdout: diff } = await git(dir, ['diff', base]);
  const { stdout: names } = await git(dir, ['diff', '--name-only', base]);
  return { diff, filesChanged: names ? names.split('\n').length : 0 };
}

// Ignored files are left out of the diff and will not be committed. Lists them (folders collapsed),
// with the text of small text files, so a changed .gitignore or deploy list is not invisible.
// Files matching `secretPatterns` are listed by name only.
export async function ignoredFiles(dir, maxChars, secretPatterns = []) {
  const { stdout } = await git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']);
  const paths = stdout ? stdout.split('\n') : [];
  return paths.slice(0, 50).map((path) => {
    if (path.endsWith('/')) return { path, content: null };
    if (isSecretFile(path, secretPatterns)) return { path, content: null, secret: true };
    const bytes = readFileSync(join(dir, path));
    const isText = bytes.length <= maxChars && !bytes.includes(0);
    return { path, content: isText ? bytes.toString('utf8') : null };
  });
}
