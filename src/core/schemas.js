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
function envNumber(schema) {
  return z.preprocess((value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value), schema);
}

export const factoryConfig = z.object({
  repos: z.object({ frontend: repo, backend: repo }).strict(),
  paths: z.object({ agents: z.string(), runs: z.string(), pricing: z.string(), worktrees: z.string() }).strict(),
  budget: z.object({ maxCostPerRun: envNumber(z.number().positive()), maxCostPerAgent: envNumber(z.number().positive()) }).strict(),
  review: z.object({
    maxRounds: envNumber(z.number().int().min(1)),
    testOutputChars: z.number().int().positive(),
    // Coder notes and ignored-file contents given to the reviewer (default keeps older workspaces valid).
    contextChars: z.number().int().positive().default(4000),
  }).strict(),
  tools: z.object({
    maxOutputChars: z.number().int().positive(),
    runCommand: z.object({
      allow: z.array(z.string()),
      timeoutSec: z.number().int().positive(),
    }).strict(),
  }).strict(),
  llms: z.record(z.string(), llmProfile),
}).strict();

export const pricingFile = z.object({
  models: z.record(z.string(), z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cachedInput: z.number().nonnegative().optional(),
  }).strict()).default({}),
}).strict();

// `model: ${SOURCERER_CODER_MODEL:-}` resolves to '' when unset, which means "not set".
const optionalText = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());

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
