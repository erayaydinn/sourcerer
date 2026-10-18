import { z } from 'zod';

export const planSchema = z.object({
  sides: z.array(z.enum(['frontend', 'backend'])).min(1),
  contract: z.string().min(1),
  instructions: z.object({ frontend: z.string().optional(), backend: z.string().optional() }),
}).refine((plan) => plan.sides.every((side) => plan.instructions[side]), 'every side needs instructions');

export const reviewSchema = z.object({
  verdict: z.enum(['approve', 'request-changes']),
  comments: z.object({
    frontend: z.array(z.string()).default([]),
    backend: z.array(z.string()).default([]),
    general: z.array(z.string()).default([]),
  }),
});

// sides (optional, from --side): the work is limited to these sides; the planner must not pick others.
export function plannerPrompt(task, repos, sides) {
  const decide = sides
    ? `The work is limited to: ${sides.join(', ')}. Set "sides" to exactly ${JSON.stringify(sides)} and plan no work for other sides.`
    : 'Decide which sides need changes. Pick only one side if the change touches only one side.';
  return `Task: ${task}

Read-only repos:
- frontend: ${repos.frontend.path}
- backend: ${repos.backend.path}

Write the API contract (OpenAPI or JSON schema).
${decide}
End your answer with exactly one fenced json block in this shape:
\`\`\`json
{ "sides": ["frontend", "backend"], "contract": "<contract text>", "instructions": { "frontend": "...", "backend": "..." } }
\`\`\``;
}

// feedback: { round, comments, testOutput } for fix rounds, null for the first pass.
export function coderPrompt(task, plan, side, workspace, feedback) {
  const readOnly = workspace.readDirs.length ? `\nRead-only (do not change): ${workspace.readDirs.join(', ')}` : '';
  return `Task: ${task}

API contract:
${plan.contract}

Your part (${side}):
${plan.instructions[side]}

Work only in ${workspace.cwd}.${readOnly}
Write and run your own tests and fix failures. Do not commit or push.${feedback ? fixSection(feedback) : ''}`;
}

function fixSection({ round, comments, testOutput }) {
  const parts = [`\n\nThis is fix round ${round}. Your earlier changes are already in the worktree (see git diff).`];
  if (testOutput) parts.push(`The test command failed. End of its output:\n\`\`\`\n${testOutput}\n\`\`\``);
  if (comments.length) parts.push(`Reviewer feedback:\n${comments.map((comment) => `- ${comment}`).join('\n')}`);
  parts.push('Address all of it.');
  return parts.join('\n\n');
}

// tests: { side: passed } for sides with a test command. previous: last round's comments or null.
export function reviewerPrompt(task, plan, diffs, tests, previous) {
  const diffText = Object.entries(diffs)
    .map(([side, diff]) => `### ${side}\n\`\`\`diff\n${diff || '(no changes)'}\n\`\`\``)
    .join('\n\n');
  const testText = Object.keys(tests).length
    ? `\n\nTest commands: ${Object.entries(tests).map(([side, passed]) => `${side} ${passed ? 'passed' : 'failed'}`).join(', ')}`
    : '';
  const previousText = previous ? `\n\nYour comments from the previous round (check they were addressed):\n${JSON.stringify(previous, null, 2)}` : '';
  return `Task: ${task}

API contract:
${plan.contract}

Diffs:
${diffText}${testText}${previousText}

Check both diffs against the contract and each other.
Put each comment under the side that must change it, or "general" if it is not side-specific.
End your answer with exactly one fenced json block in this shape:
\`\`\`json
{ "verdict": "approve" | "request-changes", "comments": { "frontend": ["..."], "backend": ["..."], "general": ["..."] } }
\`\`\``;
}

// Reads the last ```json block of an agent's answer and validates it.
export function parseJsonBlock(text, schema, what) {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (!blocks.length) throw new Error(`${what}: no json block in answer`);
  let data;
  try {
    data = JSON.parse(blocks[blocks.length - 1][1]);
  } catch (error) {
    throw new Error(`${what}: invalid JSON (${error instanceof Error ? error.message : error})`);
  }
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(`${what}: ${z.prettifyError(result.error)}`);
  return result.data;
}
