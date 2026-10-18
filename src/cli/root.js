import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PACKAGE_DIR, WORKSPACE_FILE, isLegacyWorkspace } from '../core/config.js';

export { PACKAGE_DIR };

// A workspace has sourcerer.yaml; an old-layout one (config/ + agents/ copies) is found too, so it can be migrated.
// The package folder itself is not a workspace unless it has its own sourcerer.yaml.
const isWorkspace = (dir) => existsSync(join(dir, WORKSPACE_FILE)) || isLegacyWorkspace(dir);

export function defaultWorkspace(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'sourcerer');
}

// --root > SOURCERER_ROOT > nearest parent folder with sourcerer.yaml > ~/.config/sourcerer.
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
