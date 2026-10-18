# Sourcerer

Orchestrator + subagent factory. Full spec: docs/PLAN.md. Status: docs/PROGRESS.md (read both first).

- Pure JavaScript, Node 20.12+, ESM. No TypeScript tooling of any kind; zod validates at runtime.
- One phase at a time. Propose a plan, wait for approval, update docs/PROGRESS.md at the end.
- Plain functions, small files, no speculative options. Models, paths, limits and prices live in YAML.
- Never guess model names or CLI flags (check docs/cli-help/).
- Checks: `npm test`, `npm run lint`, `npm run validate`.
- CLI: `sourcerer` (src/cli/index.js, `npm link` once). The command is named `sourcerer`, not `factory` as in PLAN.md.
