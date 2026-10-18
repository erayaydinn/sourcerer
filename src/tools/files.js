import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { insideDirs } from './sandbox.js';

export const read_file = {
  description: 'Read a text file from the workspace or a read-only directory.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  run: ({ path }, { cwd, readDirs }) => readFileSync(insideDirs([cwd, ...readDirs], path), 'utf8'),
};

export const write_file = {
  description: 'Create or overwrite a text file in the workspace.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  run: ({ path, content }, { cwd }) => {
    const file = insideDirs([cwd], path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return `wrote ${path}`;
  },
};
