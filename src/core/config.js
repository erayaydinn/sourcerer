import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';
import { z } from 'zod';
import { interpolate } from './env.js';
import { factoryConfig } from './schemas.js';

// ${VAR} / ${VAR:-default} are filled from the environment before validation.
export function readYaml(file, schema) {
  const missing = [];
  const data = interpolate(parse(readFileSync(file, 'utf8')), process.env, missing);
  if (missing.length) throw new Error(`${file}: environment variable not set: ${missing.join(', ')} (set it in .env)`);
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`${file}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

// Values this process took from a .env file, so a later load (REPL, another root) can replace them.
const fromEnvFile = new Set();

// Shell variables win over .env. Values that came from a .env are refreshed on every load.
function loadEnv(rootDir) {
  const file = resolve(rootDir, '.env');
  const values = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  for (const name of fromEnvFile) {
    if (!(name in values)) {
      delete process.env[name];
      fromEnvFile.delete(name);
    }
  }
  for (const [name, value] of Object.entries(values)) {
    if (name in process.env && !fromEnvFile.has(name)) continue;
    process.env[name] = value;
    fromEnvFile.add(name);
  }
}

export function loadConfig(rootDir) {
  loadEnv(rootDir);
  const config = readYaml(resolve(rootDir, 'config/factory.config.yaml'), factoryConfig);
  for (const repo of Object.values(config.repos)) repo.path = resolve(rootDir, repo.path);
  for (const key of ['agents', 'runs', 'pricing', 'worktrees']) config.paths[key] = resolve(rootDir, config.paths[key]);
  return config;
}
