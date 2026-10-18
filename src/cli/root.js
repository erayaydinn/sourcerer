import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The installed package: its config/ and agents/ are the templates for `sourcerer init`.
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const isWorkspace = (dir) => existsSync(join(dir, 'config', 'factory.config.yaml')) && existsSync(join(dir, 'agents'));

export function defaultWorkspace(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'sourcerer');
}

// --root > SOURCERER_ROOT > nearest parent folder with config/ and agents/ > ~/.config/sourcerer.
export function resolveRoot({ flag, env = process.env, cwd = process.cwd() } = {}) {
  if (flag) return resolve(flag);
  if (env.SOURCERER_ROOT) return resolve(env.SOURCERER_ROOT);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (isWorkspace(dir)) return dir;
    if (dirname(dir) === dir) break;
  }
  const fallback = defaultWorkspace(env);
  if (isWorkspace(fallback)) return fallback;
  throw new Error(`no Sourcerer workspace found (looked in --root, SOURCERER_ROOT, parent folders and ${fallback}). Run \`sourcerer init\`.`);
}
