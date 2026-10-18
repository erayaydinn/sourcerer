import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { factoryConfig } from './schemas.js';

export function readYaml(file, schema) {
  const result = schema.safeParse(parse(readFileSync(file, 'utf8')));
  if (!result.success) throw new Error(`${file}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export function loadEnv(rootDir) {
  const file = resolve(rootDir, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function loadConfig(rootDir) {
  const config = readYaml(resolve(rootDir, 'config/factory.config.yaml'), factoryConfig);
  for (const repo of Object.values(config.repos)) repo.path = resolve(rootDir, repo.path);
  for (const key of ['agents', 'runs', 'pricing', 'worktrees']) config.paths[key] = resolve(rootDir, config.paths[key]);
  return config;
}
