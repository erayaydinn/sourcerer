# Sourcerer

Orchestrator + subagent factory. Full spec: docs/PLAN.md. Status: docs/PROGRESS.md (read both first).

- Pure JavaScript, Node 22+ (`.nvmrc`), ESM. UI: ink + react via `React.createElement` (no JSX build). No TypeScript tooling of any kind; zod validates at runtime.
- One phase at a time. Propose a plan, wait for approval, update docs/PROGRESS.md at the end.
- Plain functions, small files, no speculative options. Models, paths, limits and prices live in YAML.
- Precedence: --llm > .env/shell (ENV_SETTINGS in src/core/config.js, ROLE_ENV in factory.js) > sourcerer.yaml > package defaults.
- Never guess model names or CLI flags (check docs/cli-help/).
- Package manager: pnpm 9 (`pnpm-lock.yaml`); dependency versions are pinned exactly (no ^).
- Checks: `pnpm test`, `pnpm lint`, `pnpm validate`.
- CLI: `sourcerer` (src/cli/index.js, `npm link` once). Workspace: --root > SOURCERER_ROOT > parent folder with sourcerer.yaml > ~/.config/sourcerer (`sourcerer init`). The workspace holds only user choices (sourcerer.yaml) + .env; config/ and agents/ in this repo are the package defaults. The command is named `sourcerer`, not `factory` as in PLAN.md.
