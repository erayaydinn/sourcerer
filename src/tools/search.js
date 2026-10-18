import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { execa } from 'execa';

// ctx.sources (from the agent's rag.scope):
//   { code: [{ name, dir }], docs: [{ name, dir, paths }], contract: file | null }
// Without sources (e.g. smoke tests) the workspace is the only code source.
function sourcesOf(ctx) {
  return ctx.sources ?? { code: [{ name: 'workspace', dir: ctx.cwd }], docs: [], contract: null };
}

// Perl regex (\s, \b, ...) by default; POSIX ERE once git says it has no PCRE.
// macOS ERE silently ignores \s and \b, so ERE is only the fallback.
let regexFlag = '-P';
const noPcre = (stderr) => /perl|pcre/i.test(stderr);

// Runs `git <args...> <flag>` and switches to -E for good if PCRE is missing.
async function gitRegex(dir, build) {
  let result = await execa('git', build(regexFlag), { cwd: dir, reject: false, timeout: 60_000 });
  if (result.exitCode > 1 && regexFlag === '-P' && noPcre(result.stderr)) {
    regexFlag = '-E';
    result = await execa('git', build(regexFlag), { cwd: dir, reject: false, timeout: 60_000 });
  }
  if (result.exitCode > 1) throw new Error(result.stderr);
  return result.stdout ? result.stdout.split('\n') : [];
}

// --untracked: coders' new files are not committed yet (gitignored files stay out).
function grep(dir, pattern, { paths = [], extra = ['--untracked'], flag } = {}) {
  const pathArgs = paths.length ? ['--', ...paths] : [];
  return gitRegex(dir, (auto) => ['grep', '-n', '-I', ...extra, flag ?? auto, '-e', pattern, ...pathArgs]);
}

const prefix = (name, lines) => lines.map((line) => `${name}:${line}`);
const joinResults = (lines) => (lines.length ? lines.join('\n') : 'no matches');

export const search_code = {
  description: 'Search code with a regex (Perl syntax when available). Searches every code source you have; '
    + 'results look like <source>:<file>:<line>:<text>. Pass `source` to search only one.',
  parameters: {
    type: 'object',
    properties: { pattern: { type: 'string' }, source: { type: 'string' } },
    required: ['pattern'],
  },
  run: async ({ pattern, source }, ctx) => {
    const code = sourcesOf(ctx).code.filter((s) => !source || s.name === source);
    if (!code.length) throw new Error(`no code source "${source}" (have: ${sourcesOf(ctx).code.map((s) => s.name).join(', ')})`);
    const results = await Promise.all(code.map(async (s) => prefix(s.name, await grep(s.dir, pattern))));
    return joinResults(results.flat());
  },
};

// Definition patterns in POSIX ERE so they work with any git build.
function symbolPattern(name) {
  const n = name.replaceAll('$', '\\$');
  const end = '([^[:alnum:]_$]|$)';
  return [
    `(function\\*?|class|const|let|var|def|func|interface|type|enum|struct)[[:space:]]+${n}${end}`,
    `func[[:space:]]+\\([^)]*\\)[[:space:]]*${n}${end}`,
    `(^|[^[:alnum:]_$.])${n}[[:space:]]*[:=][[:space:]]*(async[[:space:]]+)?(function|\\()`,
  ].join('|');
}

export const find_symbol = {
  description: 'Find where a function, class, type or variable is defined (JS/TS, Python, Go). Regex-based, not a parser.',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  run: async ({ name }, ctx) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`not a symbol name: ${name}`);
    const pattern = symbolPattern(name);
    const results = await Promise.all(sourcesOf(ctx).code.map(async (s) => prefix(s.name, await grep(s.dir, pattern, { flag: '-E' }))));
    return joinResults(results.flat());
  },
};

export const search_docs = {
  description: 'Search docs, ADRs, the API contract and commit messages with a regex (case-insensitive).',
  parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  run: async ({ pattern }, ctx) => {
    const { docs, contract } = sourcesOf(ctx);
    const lines = [];
    if (contract && existsSync(contract)) {
      const found = await grep(dirname(contract), pattern, { paths: [basename(contract)], extra: ['--no-index', '-i'] });
      lines.push(...prefix('contract', found));
    }
    for (const s of docs) {
      lines.push(...prefix(`${s.name}-docs`, await grep(s.dir, pattern, { paths: s.paths, extra: ['--untracked', '-i'] })));
      const commits = await gitRegex(s.dir, (flag) => ['log', '-i', flag, `--grep=${pattern}`, '-n', '20', '--date=short', '--format=%h %ad %s'])
        .catch((error) => (/does not have any commits/.test(error.message) ? [] : Promise.reject(error)));
      lines.push(...prefix(`${s.name}-commits`, commits));
    }
    return joinResults(lines);
  },
};
