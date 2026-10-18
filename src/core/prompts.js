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

// context per side: { diff, test: { command, passed } | null, ignored: [{ path, content }], notes }.
// previous: last round's comments or null.
export function reviewerPrompt(task, plan, context, previous) {
  const sides = Object.entries(context).map(([side, c]) => sideSection(side, c)).join('\n\n');
  const previousText = previous ? `\n\nYour comments from the previous round (check they were addressed):\n${JSON.stringify(previous, null, 2)}` : '';
  return `Task: ${task}

API contract:
${plan.contract}

${sides}${previousText}

Review in this order:
1. Contract: each side matches the contract, and the sides match each other.
2. Correctness and tests.
3. Security: authentication, secrets, input handling, abuse (e.g. missing rate limits), data that could be exposed.
4. Deployment and operations: config, migrations, deploy/ignore lists, files that will not be committed, anything the server needs.
If following the contract would remove a safeguard, do not ask for the safeguard to be removed; point out the conflict instead.
The coder notes are the coders' own claims: verify them, and act on any risks they raise.
Put each comment under the side that must change it, or "general" if it is not side-specific.
End your answer with exactly one fenced json block in this shape:
\`\`\`json
{ "verdict": "approve" | "request-changes", "comments": { "frontend": ["..."], "backend": ["..."], "general": ["..."] } }
\`\`\``;
}

function sideSection(side, { diff, test, ignored, notes }) {
  const testText = test
    ? `\`${test.command}\` ${test.passed ? 'passed' : 'failed'} (run by the orchestrator in the worktree, on this machine only; not on any server)`
    : 'no test command configured; the coder\'s own test claims are unverified';
  const ignoredText = ignored.length
    ? ignored.map(({ path, content }) => (content === null ? `- ${path}` : `- ${path}:\n\`\`\`\n${content}\n\`\`\``)).join('\n')
    : '(none)';
  return `## ${side}

Diff against the base branch:
\`\`\`diff
${diff || '(no changes)'}
\`\`\`

Ignored files in the worktree (not in the diff above, and NOT committed by git):
${ignoredText}

Tests: ${testText}

Coder notes (end of the coder's last answer):
${notes || '(none)'}`;
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
