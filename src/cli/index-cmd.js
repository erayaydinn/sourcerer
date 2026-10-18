import { buildIndex } from '../rag/index.js';
import { searchIndex } from '../rag/search.js';
import { loadProject, table } from './project.js';

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// Builds/updates the BM25 index per side; with --query, shows the ranking instead (for checking results).
export async function indexCommand({ root, side, force, query, limit }, print) {
  const { config } = loadProject(root);
  const sides = side ? [side] : ['frontend', 'backend'];
  for (const name of sides) {
    if (!config.repos[name]) throw new Error(`unknown side "${name}" (frontend or backend)`);
    const built = await buildIndex(config, root, name, { force });
    if (built.upToDate) print(`${name}: up to date (${built.files} files, ${config.repos[name].base} ${built.commit.slice(0, 8)})`);
    else {
      const { excluded, tooBig, binary } = built.skipped;
      print(`${name}: indexed ${built.files} files (${built.analyzed} newly analyzed) in ${(built.ms / 1000).toFixed(1)}s, `
        + `${built.terms} terms, ${built.postings} postings, ${mb(built.bytes)}; skipped ${excluded} excluded, ${tooBig} too big, ${binary} binary`);
    }
    if (!query) continue;
    const started = Date.now();
    const { hits } = await searchIndex(config, root, name, query, { limit: Number(limit ?? 10) });
    print(`\n${name}: top ${hits.length} for "${query}" (${Date.now() - started} ms)`);
    if (hits.length) table([['SCORE', 'FILE', 'MATCHED'], ...hits.map((h) => [h.score.toFixed(2), h.path, h.terms.join(' ')])], print);
  }
  return 0;
}
