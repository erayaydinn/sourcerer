import { loadConfig } from '../core/config.js';
import { createWorktrees, removeWorktrees, taskSlug } from '../git/worktree.js';

export async function worktreeCreateCommand(task, sides, { root }, print) {
  const worktrees = await createWorktrees(loadConfig(root), taskSlug(task), sides.length ? sides : ['frontend', 'backend']);
  for (const [side, dir] of Object.entries(worktrees)) print(`${side}: ${dir}`);
  return 0;
}

export async function worktreeRemoveCommand(slug, { root, force }, print) {
  await removeWorktrees(loadConfig(root), slug, { force });
  print(`removed worktrees for ${slug}; branch feat/${slug} kept`);
  return 0;
}
