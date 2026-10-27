import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { searchIndex } from './search.js';
import { definitions, tokenize } from './tokenize.js';

const PER_NAME = 3;
const MAX_LINES = 10;
const MIN_OVERLAP = 0.5;
// Tests define test functions, not helpers worth reusing: skipped on both sides.
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/i;

// "+++ b/path" and added lines of a unified diff -> [{ path, added }].
export function addedByFile(diff) {
  const files = [];
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('+++ ')) files.push({ path: line.replace(/^\+\+\+ (b\/)?/, ''), added: [] });
    else if (line.startsWith('+') && files.length) files.at(-1).added.push(line.slice(1));
  }
  return files.filter((file) => file.path !== '/dev/null');
}

// Share of `name`'s terms that `other` also has (CountBranches vs CountBranches = 1, vs BranchCount = 0.5).
function overlap(name, other) {
  const mine = new Set(tokenize(name));
  if (!mine.size) return 0;
  const theirs = new Set(tokenize(other));
  return [...mine].filter((term) => theirs.has(term)).length / mine.size;
}

// Definitions the diff adds that look like existing code elsewhere in the repo, so the reviewer can spot
// re-implemented helpers. Searches the side's index; files the diff touches are skipped.
// Returns a prompt section, or '' when nothing similar is found (or there is no index).
export async function similarDefinitions(config, root, side, { diff, worktree }) {
  const files = addedByFile(diff);
  const touched = new Set(files.map((file) => file.path));
  const names = [...new Set(files.filter((file) => !TEST_FILE.test(file.path)).flatMap((file) => definitions(file.path, file.added.join('\n'))))];
  const lines = [];
  for (const name of names) {
    const found = await searchIndex(config, root, side, name, { worktree, limit: 8 });
    if (!found) return '';
    const matches = [];
    for (const { path } of found.hits) {
      const file = join(worktree, path);
      if (touched.has(path) || TEST_FILE.test(path) || !existsSync(file)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
        for (const other of definitions(path, text)) {
          const score = overlap(name, other);
          if (score >= MIN_OVERLAP) matches.push({ score, line: `- \`${name}\` (new) ~ ${path}:${i + 1}: \`${text.trim().slice(0, 160)}\`` });
        }
      });
    }
    lines.push(...matches.sort((a, b) => b.score - a.score).slice(0, PER_NAME).map((match) => match.line));
    if (lines.length >= MAX_LINES) break;
  }
  if (!lines.length) return '';
  return `Existing definitions with similar names (BM25 search of the ${side} repo, outside this diff; check whether the new code re-implements one of them):\n${lines.slice(0, MAX_LINES).join('\n')}`;
}
