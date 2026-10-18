import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

// Shell variables win over .env (process.loadEnvFile does not override them).
function loadEnv(rootDir) {
  const file = resolve(rootDir, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function loadConfig(rootDir) {
  loadEnv(rootDir);
  const config = readYaml(resolve(rootDir, 'config/factory.config.yaml'), factoryConfig);
  for (const repo of Object.values(config.repos)) repo.path = resolve(rootDir, repo.path);
  for (const key of ['agents', 'runs', 'pricing', 'worktrees']) config.paths[key] = resolve(rootDir, config.paths[key]);
  return config;
}
