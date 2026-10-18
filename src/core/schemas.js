import { z } from 'zod';

export const TOOLS = ['read_file', 'write_file', 'run_command', 'search_code', 'find_symbol', 'search_docs', 'web_search', 'web_fetch'];
export const RAG_SOURCES = ['frontend', 'backend', 'contract', 'docs'];
export const ROLES = ['planner', 'coder', 'reviewer'];

const capabilities = z.object({
  editsFiles: z.boolean().default(false),
  toolUse: z.boolean().default(false),
  jsonOutput: z.boolean().default(false),
  reportsCost: z.boolean().default(false),
  contextWindow: z.number().int().positive().optional(),
}).strict();

const base = {
  provider: z.string(),
  model: z.string(),
  capabilities: capabilities.default({}),
};

export const llmProfile = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cli'), bin: z.string(), ...base }).strict(),
  z.object({
    type: z.literal('openai-compat'),
    baseURL: z.url(),
    keyEnv: z.string().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    ...base,
  }).strict(),
  z.object({
    type: z.literal('anthropic'),
    keyEnv: z.string().optional(),
    maxOutputTokens: z.number().int().positive(),
    ...base,
  }).strict(),
]);

const command = z.object({ run: z.array(z.string()).min(1), timeoutSec: z.number().int().positive() }).strict();

const repo = z.object({
  path: z.string(),
  base: z.string(),
  setup: command.optional(),
  test: command.optional(),
  docs: z.array(z.string()).default([]),
}).strict();

// Env values arrive as text: "5" -> 5 for fields that may come from ${VAR}. Non-numbers still fail.
// An empty value (`${VAR:-}` with VAR unset) means "not set".
function envNumber(schema) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    return value.trim() === '' ? undefined : Number(value);
  }, schema);
}

// An empty value (e.g. from `${VAR:-}`) means "not set".
const optionalText = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());

const price = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cachedInput: z.number().nonnegative().optional(),
}).strict();

// Package defaults merged with the workspace's sourcerer.yaml (see config.js).
export const factoryConfig = z.object({
  repos: z.object({ frontend: repo, backend: repo }).strict(),
  paths: z.object({ runs: z.string(), worktrees: z.string() }).strict(),
  budget: z.object({
    maxCostPerRun: envNumber(z.number().positive()),
    maxCostPerAgent: envNumber(z.number().positive()),
    // Input + output tokens (cache reads not counted). Empty means no token limit.
    maxTokensPerRun: envNumber(z.number().int().positive().optional()),
    maxTokensPerAgent: envNumber(z.number().int().positive().optional()),
  }).strict(),
  review: z.object({
    maxRounds: envNumber(z.number().int().min(1)),
    testOutputChars: z.number().int().positive(),
    // Coder notes and ignored-file contents given to the reviewer (default keeps older workspaces valid).
    contextChars: z.number().int().positive().default(4000),
  }).strict(),
  rag: z.object({
    enabled: z.boolean(),
    maxFileBytes: z.number().int().positive(),
    exclude: z.array(z.string()),
    context: z.object({
      maxFiles: z.number().int().min(0),
      maxChars: z.number().int().positive(),
      snippetLines: z.number().int().positive(),
    }).strict(),
  }).strict(),
  security: z.object({
    webAccess: z.boolean(),
    commandAllowlist: z.boolean(),
    allowCommands: z.array(z.string()),
    extraCommands: z.array(z.string()).default([]),
    confineFiles: z.boolean(),
    trustUnconfinedCli: z.boolean(),
    sandbox: z.object({
      enabled: z.union([z.literal('auto'), z.boolean()]),
      allowRead: z.array(z.string()).default([]),
      allowWrite: z.array(z.string()).default([]),
    }).strict().default({ enabled: 'auto', allowRead: [], allowWrite: [] }),
    secretFiles: z.array(z.string()),
  }).strict(),
  tools: z.object({
    maxOutputChars: z.number().int().positive(),
    runCommand: z.object({
      allow: z.array(z.string()),
      timeoutSec: z.number().int().positive(),
    }).strict(),
  }).strict(),
  llms: z.record(z.string(), llmProfile),
  // Per-agent choices (sourcerer.yaml `agents:`), applied over the agent YAML defaults.
  agents: z.preprocess((value) => value ?? {}, z.record(z.string(), z.object({
    llm: optionalText,
    model: optionalText,
    fallbackLlm: optionalText,
  }).strict())),
  // USD per 1M tokens, keyed by the resolved model name.
  pricing: z.preprocess((value) => value ?? {}, z.record(z.string(), price)),
}).strict();

export const agentDef = z.object({
  name: z.string(),
  role: z.enum(ROLES),
  repo: z.enum(['frontend', 'backend']).optional(),
  llm: z.string(),
  model: optionalText,
  fallbackLlm: optionalText,
  tools: z.array(z.enum(TOOLS)).default([]),
  fileScope: z.object({
    read: z.array(z.string()).default([]),
    write: z.array(z.string()).default([]),
  }).strict().default({ read: [], write: [] }),
  maxTurns: z.number().int().positive(),
  timeoutSec: z.number().int().positive(),
  rag: z.object({ scope: z.array(z.enum(RAG_SOURCES)).default([]) }).strict().default({ scope: [] }),
  systemPrompt: z.string(),
}).strict();
