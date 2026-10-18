# Sourcerer

Orchestrator + subagent factory. Full spec: docs/PLAN.md. Status: docs/PROGRESS.md (read both first).

- Pure JavaScript, Node 20.12+, ESM. No TypeScript tooling of any kind; zod validates at runtime.
- One phase at a time. Propose a plan, wait for approval, update docs/PROGRESS.md at the end.
- Plain functions, small files, no speculative options. Models, paths, limits and prices live in YAML.
- Machine-specific values (repo paths, per-role LLM/model) come from `.env` via `${VAR}` / `${VAR:-default}` in YAML; see `.env.example`.
- Never guess model names or CLI flags (check docs/cli-help/).
- Package manager: pnpm 9 (`pnpm-lock.yaml`); dependency versions are pinned exactly (no ^).
- Checks: `pnpm test`, `pnpm lint`, `pnpm validate`.
- CLI: `sourcerer` (src/cli/index.js, `npm link` once). Workspace: --root > SOURCERER_ROOT > parent folder with config/+agents/ > ~/.config/sourcerer (`sourcerer init`). The command is named `sourcerer`, not `factory` as in PLAN.md.
