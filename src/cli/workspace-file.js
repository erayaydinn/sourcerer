import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { WORKSPACE_FILE } from '../core/config.js';
import { loadProject } from './project.js';

// Edits sourcerer.yaml through the yaml Document API (comments are kept), then reloads the whole
// project. If the result is invalid the file is restored and nothing is saved.
// `edit(doc)` uses doc.setIn / doc.deleteIn. Returns the reloaded project.
export function editWorkspace(root, edit) {
  const file = join(root, WORKSPACE_FILE);
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const doc = parseDocument(before ?? '');
  if (!isMap(doc.contents)) doc.contents = doc.createNode({});
  edit(doc);
  writeFileSync(file, doc.toString());
  try {
    const project = loadProject(root, [], { allowMissingRepos: true });
    if (project.errors.length) throw new Error(project.errors.join('; '));
    return project;
  } catch (error) {
    if (before === null) rmSync(file);
    else writeFileSync(file, before);
    throw new Error(`not saved: ${error.message}`);
  }
}

// Removes now-empty parent maps after a deleteIn, so the file stays tidy.
export function deleteIn(doc, path) {
  doc.deleteIn(path);
  for (let i = path.length - 1; i > 0; i--) {
    const parent = doc.getIn(path.slice(0, i));
    if (isMap(parent) && parent.items.length === 0) doc.deleteIn(path.slice(0, i));
  }
}
