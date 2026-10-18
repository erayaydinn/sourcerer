import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PACKAGE_DIR, defaultWorkspace } from './root.js';

// Copies the package's config and agents into a workspace. Existing files are never overwritten,
// so running it again after an update only adds what is missing.
// Target: [dir] > --root > SOURCERER_ROOT > ~/.config/sourcerer.
export function initCommand(dir, { root }, print) {
  const target = resolve(dir ?? root ?? process.env.SOURCERER_ROOT ?? defaultWorkspace());
  const agents = readdirSync(join(PACKAGE_DIR, 'agents')).filter((file) => file.endsWith('.yaml'));
  const copies = [
    ['config/factory.config.yaml', 'config/factory.config.yaml'],
    ['config/pricing.yaml', 'config/pricing.yaml'],
    ...agents.map((file) => [`agents/${file}`, `agents/${file}`]),
    ['.env.example', '.env.example'],
    ['.env.example', '.env'],
  ];

  for (const [from, to] of copies) {
    const destination = join(target, to);
    if (existsSync(destination)) {
      print(`skip   ${to} (exists)`);
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(PACKAGE_DIR, from), destination);
    print(`create ${to}`);
  }

  print(`\nworkspace: ${target}`);
  print('next: set SOURCERER_FRONTEND and SOURCERER_BACKEND in .env, then run `sourcerer validate`');
  return 0;
}
