import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

// Resolves a path against roots[0] and throws if it (or a symlink in it) is outside every root.
export function insideDirs(roots, file) {
  const full = resolve(realpathSync(roots[0]), file);
  let existing = full;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = join(realpathSync(existing), relative(existing, full));
  const inside = roots.some((root) => {
    const rel = relative(realpathSync(root), real);
    return !rel.startsWith('..') && !isAbsolute(rel);
  });
  if (!inside) throw new Error(`path outside workspace: ${file}`);
  return real;
}

export function truncate(text, maxChars) {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}
