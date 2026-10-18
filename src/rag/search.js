import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { PATH_WEIGHT, analyze, excluded, indexDir, pathTerms } from './index.js';
import { tokenize } from './tokenize.js';

const K1 = 1.2;
const B = 0.75;
const MAX_QUERY_TERMS = 40;
const loaded = new Map(); // index dir -> { mtime, meta, data }

function load(root, side) {
  const dir = indexDir(root, side);
  const metaFile = join(dir, 'meta.json');
  if (!existsSync(metaFile)) return null;
  const mtime = statSync(metaFile).mtimeMs;
  if (loaded.get(dir)?.mtime === mtime) return loaded.get(dir);
  const bytes = readFileSync(join(dir, 'postings.bin'));
  const entry = {
    mtime,
    meta: JSON.parse(readFileSync(metaFile, 'utf8')),
    data: new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
  };
  loaded.set(dir, entry);
  return entry;
}

const idf = (n, df) => Math.log(1 + (n - df + 0.5) / (df + 0.5));
const bm25 = (tf, length, avg) => (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / avg));

// Files that differ in a worktree from the base it started from (changed, added, deleted, untracked).
async function changedFiles(worktree, base) {
  const diff = await execa('git', ['-C', worktree, 'diff', '--name-only', base], { reject: false });
  const untracked = await execa('git', ['-C', worktree, 'ls-files', '--others', '--exclude-standard'], { reject: false });
  return [...new Set([...diff.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean))];
}

// BM25 over the side's index. With `worktree`, changed files are scored from their current content
// instead of the base. Returns null when there is no index, else { hits: [{ path, score, terms }], weights }.
export async function searchIndex(config, root, side, query, { worktree, limit = 10 } = {}) {
  const index = load(root, side);
  if (!index) return null;
  const { meta, data } = index;
  const n = meta.files.length;
  const terms = [...new Set(tokenize(query))]
    .map((term) => [term, idf(n, meta.dictionary[term]?.[1] ?? 0)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_QUERY_TERMS);
  const weights = new Map(terms);

  const changed = worktree ? new Set(await changedFiles(worktree, meta.base)) : new Set();
  const scores = new Map();
  const matched = new Map();
  const add = (path, term, score) => {
    scores.set(path, (scores.get(path) ?? 0) + score);
    if (!matched.has(path)) matched.set(path, new Set());
    matched.get(path).add(term);
  };

  for (const [term, weight] of terms) {
    const entry = meta.dictionary[term];
    if (!entry) continue;
    const [offset, count] = entry;
    for (let i = 0; i < count; i++) {
      const doc = data[offset + i * 2];
      const path = meta.files[doc];
      if (!changed.has(path)) add(path, term, weight * bm25(data[offset + i * 2 + 1] / 10, meta.lengths[doc], meta.avgLength));
    }
  }

  for (const path of changed) {
    const file = join(worktree, path);
    if (!existsSync(file) || excluded(path, config.rag.exclude) || statSync(file).size > config.rag.maxFileBytes) continue;
    const bytes = readFileSync(file);
    if (bytes.subarray(0, 8000).includes(0)) continue;
    const { terms: tfs, length } = analyze(path, bytes.toString('utf8'));
    const fromPath = pathTerms(path);
    for (const term of fromPath) tfs[term] = (tfs[term] ?? 0) + PATH_WEIGHT;
    for (const [term, weight] of terms) if (tfs[term]) add(path, term, weight * bm25(tfs[term], length + fromPath.length, meta.avgLength));
  }

  const hits = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([path, score]) => ({ path, score, terms: [...matched.get(path)] }));
  return { hits, weights };
}

// The `size`-line window with the most query-term weight (each term counted once per line).
export function bestWindow(text, weights, size) {
  const lines = text.split('\n');
  if (lines.length <= size) return { start: 1, end: lines.length, text };
  const lineScore = lines.map((line) => [...new Set(tokenize(line))].reduce((sum, term) => sum + (weights.get(term) ?? 0), 0));
  let sum = lineScore.slice(0, size).reduce((a, b) => a + b, 0);
  let best = 0;
  let bestSum = sum;
  for (let start = 1; start + size <= lines.length; start++) {
    sum += lineScore[start + size - 1] - lineScore[start - 1];
    if (sum > bestSum) [best, bestSum] = [start, sum];
  }
  return { start: best + 1, end: best + size, text: lines.slice(best, best + size).join('\n') };
}

// Prompt section with the most relevant files and snippets, within config.rag.context limits.
// Returns { text, files } (text is '' when there is nothing useful).
export async function relevantContext(config, root, side, query, worktree) {
  const { maxFiles, maxChars, snippetLines } = config.rag.context;
  if (!config.rag.enabled || !maxFiles) return { text: '', files: [] };
  const found = await searchIndex(config, root, side, query, { worktree, limit: maxFiles });
  if (!found?.hits.length) return { text: '', files: [] };
  const dir = worktree ?? config.repos[side].path;
  let budget = maxChars;
  const sections = [];
  const files = [];
  for (const hit of found.hits) {
    const file = join(dir, hit.path);
    if (budget < 200 || !existsSync(file)) continue;
    const window = bestWindow(readFileSync(file, 'utf8'), found.weights, snippetLines);
    const body = window.text.slice(0, budget);
    budget -= body.length;
    files.push(hit.path);
    sections.push(`### ${hit.path} (lines ${window.start}-${window.end}; matched: ${hit.terms.join(', ')})\n\`\`\`\n${body}\n\`\`\``);
  }
  if (!sections.length) return { text: '', files: [] };
  return {
    files,
    text: `Likely relevant files (BM25 search of the ${side} repo; a starting point, not complete, verify before relying on it):\n\n${sections.join('\n\n')}`,
  };
}
