import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// macOS sandbox (sandbox-exec / Seatbelt) for agent CLIs and the commands Sourcerer runs (tests, setup).
// Everything under your home folder is unreadable and unwritable, except what is listed below; child
// processes inherit it, so code a coder writes (and its tests) is confined too. Network stays open:
// the CLIs must reach their LLM API. Verified with real calls: claude and cursor-agent (even with --force)
// work inside, and get "Operation not permitted" for files outside.

// Read-only: agent CLI installs and logins, git config, language toolchains.
const READ = [
  '.local/bin', '.local/share/claude', '.local/share/cursor-agent', '.claude', '.claude.json', '.cursor',
  'Library/Keychains', '.gitconfig', '.config/git',
  '.nvm', '.volta', '.asdf', '.pyenv', '.rbenv', '.sdkman', '.cargo', '.rustup', 'go', 'Library/pnpm', '.bun', '.deno',
  '.composer', '.config/composer', '.local/share/pnpm',
];
// Read-write: CLI state, package manager and build caches.
const WRITE = [
  '.claude', '.claude.json', '.cursor', '.npm', '.cache', 'Library/Caches', '.pnpm-store', '.local/share/pnpm',
  'go/pkg', '.composer/cache', '.cache/composer', '.gradle',
];

export const sandboxAvailable = () => process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

// security.sandbox.enabled: 'auto' (on where available), true (required), false.
export function sandboxActive(security) {
  if (!security?.sandbox) return false;
  const setting = security.sandbox.enabled;
  if (setting === false) return false;
  if (setting === true && !sandboxAvailable()) throw new Error('security.sandbox.enabled is true, but the sandbox only works on macOS (sandbox-exec) for now');
  return sandboxAvailable();
}

const quote = (path) => JSON.stringify(path);
const real = (path) => (existsSync(path) ? realpathSync(path) : path);

// The Seatbelt profile text. `write` and `read` are absolute paths (folders or files).
export function sandboxProfile({ write = [], read = [], home = homedir() }) {
  const inHome = (list) => list.map((path) => join(home, path));
  const rule = (paths) => [...new Set(paths.flatMap((path) => [path, real(path)]))].map((path) => `(subpath ${quote(path)})`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read* (subpath ${quote(home)}) (subpath ${quote(real(home))}))`,
    `(deny file-write* (subpath ${quote(home)}) (subpath ${quote(real(home))}))`,
    `(allow file-read-metadata (subpath ${quote(home)}))`,
    `(allow file-read* (literal ${quote(home)}) ${rule([...inHome(READ), ...inHome(WRITE), ...read, ...write])})`,
    `(allow file-write* ${rule([...inHome(WRITE), ...write])})`,
    '',
  ].join('\n');
}

// Returns [command, args] that run `command args` inside the sandbox (unchanged when it is off).
export function sandboxed(command, args, { security, write = [], read = [] }) {
  if (!sandboxActive(security)) return [command, args];
  const extra = security.sandbox ?? {};
  const profile = sandboxProfile({ write: [...write, ...(extra.allowWrite ?? [])], read: [...read, ...(extra.allowRead ?? [])] });
  const dir = join(tmpdir(), 'sourcerer-sandbox');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${createHash('sha256').update(profile).digest('hex').slice(0, 16)}.sb`);
  writeFileSync(file, profile);
  return ['/usr/bin/sandbox-exec', ['-f', file, command, ...args]];
}

// The git dir a worktree writes to (its main repo's .git), so git works inside the sandbox.
export function gitDirOf(worktree) {
  const marker = join(worktree, '.git');
  if (!existsSync(marker)) return null;
  if (statSync(marker).isDirectory()) return marker;
  const match = readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+)$/m);
  // <repo>/.git/worktrees/<name> -> <repo>/.git
  return match ? dirname(dirname(match[1].trim())) : null;
}
