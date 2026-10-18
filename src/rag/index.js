import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { basename, join } from 'node:path';
import { execa } from 'execa';
import { definitions, tokenize } from './tokenize.js';

// One BM25 index per repo side, built from the base branch's last commit:
//   <workspace>/index/<side>/meta.json + postings.bin
// File analyses are cached by git blob hash (<workspace>/index/blobs/), so unchanged files are never
// re-read, also across branches and rebuilds.
const VERSION = 1;
export const PATH_WEIGHT = 3;
export const DEFINITION_WEIGHT = 2.5;

export const indexDir = (root, side) => join(root, 'index', side);
const blobFile = (root, hash) => join(root, 'index', 'blobs', hash.slice(0, 2), `${hash}.json`);

// Excluded if a pattern matches: `dir/` (any path segment), `*.ext` (file name end), or a file name.
export function excluded(path, patterns) {
  const segments = path.split('/');
  const name = basename(path);
  return patterns.some((pattern) => {
    if (pattern.endsWith('/')) return segments.slice(0, -1).includes(pattern.slice(0, -1));
    if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
    return name === pattern || path === pattern;
  });
}

const isBinary = (bytes) => bytes.subarray(0, 8000).includes(0);

// Term frequencies for a file's content (definitions weigh more). Path terms are added per file.
export function analyze(path, text) {
  const terms = {};
  const body = tokenize(text);
  for (const term of body) terms[term] = (terms[term] ?? 0) + 1;
  for (const name of definitions(path, text)) {
    for (const term of tokenize(name)) terms[term] = (terms[term] ?? 0) + DEFINITION_WEIGHT;
  }
  return { terms, length: body.length };
}

export function pathTerms(path) {
  return tokenize(path.replace(/\.[^./]+$/, '').replace(/[/.-]/g, ' '));
}

async function listFiles(repoPath, base, { maxFileBytes, exclude }) {
  const { stdout } = await execa('git', ['-C', repoPath, 'ls-tree', '-r', '-l', '-z', base], { maxBuffer: 1024 * 1024 * 512 });
  const files = [];
  const skipped = { excluded: 0, tooBig: 0 };
  for (const entry of stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, type, hash, size] = entry.slice(0, tab).split(/\s+/);
    const path = entry.slice(tab + 1);
    if (type !== 'blob' || mode === '120000') continue;
    if (excluded(path, exclude)) skipped.excluded++;
    else if (Number(size) > maxFileBytes) skipped.tooBig++;
    else files.push({ path, hash });
  }
  return { files, skipped };
}

// Streams blob contents from one `git cat-file --batch` process.
async function readBlobs(repoPath, hashes, onBlob) {
  if (!hashes.length) return;
  const proc = execa('git', ['-C', repoPath, 'cat-file', '--batch'], { input: `${hashes.join('\n')}\n`, buffer: false });
  let buffer = Buffer.alloc(0);
  let current = null;
  for await (const chunk of proc.stdout) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!current) {
        const newline = buffer.indexOf(10);
        if (newline < 0) break;
        const [hash, type, size] = buffer.subarray(0, newline).toString().split(' ');
        buffer = buffer.subarray(newline + 1);
        if (type === 'missing') continue;
        current = { hash, size: Number(size) };
      }
      if (buffer.length < current.size + 1) break;
      onBlob(current.hash, buffer.subarray(0, current.size));
      buffer = buffer.subarray(current.size + 1);
      current = null;
    }
  }
  await proc;
}

export function readMeta(root, side) {
  const file = join(indexDir(root, side), 'meta.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

// Builds or updates the index of one side. Skips the work when the base commit is unchanged.
export async function buildIndex(config, root, side, { force = false } = {}) {
  const started = Date.now();
  const repo = config.repos[side];
  const { stdout: commit } = await execa('git', ['-C', repo.path, 'rev-parse', repo.base]);
  const old = readMeta(root, side);
  if (!force && old?.version === VERSION && old.commit === commit && old.repoPath === repo.path) {
    return { side, upToDate: true, files: old.files.length, commit };
  }

  const { files, skipped } = await listFiles(repo.path, repo.base, config.rag);
  const pathOf = new Map(files.map((f) => [f.hash, f.path]));
  const missing = [...pathOf.keys()].filter((hash) => !existsSync(blobFile(root, hash)));
  let binary = 0;
  await readBlobs(repo.path, missing, (hash, bytes) => {
    const file = blobFile(root, hash);
    mkdirSync(join(file, '..'), { recursive: true });
    const analysis = isBinary(bytes) ? { binary: true } : analyze(pathOf.get(hash), bytes.toString('utf8'));
    writeFileSync(file, JSON.stringify(analysis));
  });

  // Postings: term -> [doc, tf*10, doc, tf*10, ...]
  const postings = new Map();
  const docs = [];
  const lengths = [];
  for (const { path, hash } of files) {
    const analysis = JSON.parse(readFileSync(blobFile(root, hash), 'utf8'));
    if (analysis.binary) {
      binary++;
      continue;
    }
    const doc = docs.length;
    const terms = { ...analysis.terms };
    const fromPath = pathTerms(path);
    for (const term of fromPath) terms[term] = (terms[term] ?? 0) + PATH_WEIGHT;
    docs.push(path);
    lengths.push(analysis.length + fromPath.length);
    for (const [term, tf] of Object.entries(terms)) {
      let list = postings.get(term);
      if (!list) postings.set(term, (list = []));
      list.push(doc, Math.round(tf * 10));
    }
  }

  const dictionary = {};
  let total = 0;
  for (const [term, list] of postings) {
    dictionary[term] = [total, list.length / 2];
    total += list.length;
  }
  const data = new Uint32Array(total);
  for (const [term, list] of postings) data.set(list, dictionary[term][0]);

  const dir = indexDir(root, side);
  mkdirSync(dir, { recursive: true });
  const meta = {
    version: VERSION, side, repoPath: repo.path, base: repo.base, commit, builtAt: new Date().toISOString(),
    files: docs, lengths, avgLength: lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length), dictionary,
  };
  // Write next to the old files, then swap, so a reader never sees half an index.
  writeFileSync(join(dir, 'postings.bin.tmp'), Buffer.from(data.buffer));
  writeFileSync(join(dir, 'meta.json.tmp'), JSON.stringify(meta));
  renameSync(join(dir, 'postings.bin.tmp'), join(dir, 'postings.bin'));
  renameSync(join(dir, 'meta.json.tmp'), join(dir, 'meta.json'));
  const size = statSync(join(dir, 'postings.bin')).size + statSync(join(dir, 'meta.json')).size;
  return {
    side, upToDate: false, commit, files: docs.length, analyzed: missing.length, terms: postings.size, postings: total / 2,
    skipped: { ...skipped, binary }, bytes: size, ms: Date.now() - started,
  };
}
