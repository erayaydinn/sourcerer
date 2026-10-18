import { basename } from 'node:path';

const WEB_TOOLS = ['web_search', 'web_fetch'];
// CLIs that cannot be limited to a folder or a command list (verified: cursor-agent reads any file).
export const UNCONFINED_BINS = ['cursor-agent'];

// Commands coders may run: the configured list, extras, and each repo's own setup/test command.
export function allowedCommands(config) {
  const fromRepos = Object.values(config.repos).flatMap((repo) => [repo.setup, repo.test].filter(Boolean).map((cmd) => cmd.run.join(' ')));
  return [...new Set([...config.security.allowCommands, ...config.security.extraCommands, ...fromRepos])];
}

// True if `command` is an allowed command or starts with one followed by a space.
export function commandAllowed(command, allowed) {
  const text = command.trim().replace(/\s+/g, ' ');
  return allowed.some((prefix) => text === prefix || text.startsWith(`${prefix} `));
}

// `*` matches any characters in the file name; other patterns match the name exactly.
export function isSecretFile(path, patterns) {
  const name = basename(path);
  return patterns.some((pattern) => {
    const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
    return regex.test(name);
  });
}

// Strips web tools when web access is off (the default).
export function applySecurity(defs, config) {
  if (config.security.webAccess) return defs;
  return defs.map((def) => ({ ...def, tools: def.tools.filter((tool) => !WEB_TOOLS.includes(tool)) }));
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];
// key = value with a secret-sounding key: the value is replaced, the key kept.
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"'`]{8,})\3/gi;

// Replaces secret-looking values with [REDACTED] in text Sourcerer sends to agents or writes to logs.
export function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out.replace(SECRET_ASSIGNMENT, (match, key, sep, quote, value) => (value === '[REDACTED]' ? match : `${key}${sep}${quote}[REDACTED]${quote}`));
}
