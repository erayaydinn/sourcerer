# Sourcerer

An orchestrator and subagent factory for a project split into **two repos: a frontend and a backend**.

A task flows like this:

1. **Planner** writes the API contract and decides which side(s) need work.
2. **Coders** (frontend and backend) work in parallel, each in its own git worktree on a `feat/<task>` branch.
3. Your test command runs after every pass. Failures go straight back to the coder.
4. **Reviewer** (read-only, on a different LLM provider) sees both diffs and the contract, then approves or requests changes, for up to N rounds.

Sourcerer never commits or pushes; the work is left in the worktrees for you.

Every agent can use a different model and CLI. Supported adapters: the `claude` and `cursor-agent` CLIs, any OpenAI-compatible API, and the Anthropic API. Cost is tracked per call, and the run pauses to ask you when a budget is exceeded.

## Requirements

- Node.js 20.12+ and git
- At least one agent CLI, logged in: `claude` (Claude Code) and/or `cursor-agent`
- Optional: `tmux` (for `--tmux`; on Windows use WSL)

## Install

```sh
npm install -g @erayaydinn/sourcerer      # or: pnpm add -g @erayaydinn/sourcerer
sourcerer init            # creates ~/.config/sourcerer (config/, agents/, .env)
```

Edit `~/.config/sourcerer/.env`:

```sh
SOURCERER_FRONTEND=/path/to/frontend-repo
SOURCERER_BACKEND=/path/to/backend-repo
```

Then check the setup:

```sh
sourcerer validate        # agents -> LLM profile -> model
sourcerer smoke           # says hi to each configured profile (costs a few cents)
```

## Usage

```sh
sourcerer run "Add GET /api/users with pagination"
sourcerer run --side backend "Add rate limiting"          # only the backend
sourcerer run --tmux "..."                                 # one pane per agent
sourcerer run --interactive "..."                          # pause before each review / fix round
sourcerer run --llm reviewer=claude-cheap "..."            # swap an agent's LLM for one run

sourcerer status                                           # recent runs
sourcerer logs [runId] [--agent coder-backend] [-f]
sourcerer cost [runId] [--since 7d] [--by agent|role|llm]
sourcerer worktree remove <slug> [--force]                 # after you have committed
```

Run ids accept a unique prefix and default to the latest run.

## Configuration

A workspace holds `config/factory.config.yaml`, `config/pricing.yaml`, `agents/*.yaml` and `.env`. Runs (`runs/`) and worktrees (`worktrees/`) are created inside it.

The workspace is found in this order:

1. `--root <dir>`
2. `SOURCERER_ROOT`
3. the nearest parent folder that has `config/` and `agents/`
4. `~/.config/sourcerer` (or `$XDG_CONFIG_HOME/sourcerer`)

Any YAML value can come from the environment with `${VAR}` or `${VAR:-default}`. Shell variables win over `.env`. The main ones:

| Variable | Meaning | Default |
|---|---|---|
| `SOURCERER_FRONTEND`, `SOURCERER_BACKEND` | repo paths | required |
| `SOURCERER_{PLANNER,CODER,REVIEWER}_LLM` | LLM profile per role | the agent YAML's |
| `SOURCERER_{PLANNER,CODER,REVIEWER}_MODEL` | model per role | the profile's model |
| `SOURCERER_MAX_COST_PER_RUN`, `SOURCERER_MAX_COST_PER_AGENT` | budget in USD | 5, 2 |
| `SOURCERER_MAX_ROUNDS` | coder passes per task | 3 |

See `.env.example` for the full list. Per repo you can also set a `setup` command (run once in each new worktree) and a `test` command (run after every coder pass).

**Adding an agent** means adding a YAML file to `agents/`. **Adding a model** means adding a profile under `llms:` in `factory.config.yaml`. To get cost estimates for CLIs that don't report cost, add the model's prices to `pricing.yaml`.

`sourcerer init` never overwrites existing files, so you can run it again after an update to pick up new templates.

## Safety notes

- Agents write only inside their own worktree. The other repo is read-only, and the reviewer cannot write at all.
- Coders that run commands are **not** restricted to an allowlist when using the `claude` or `cursor-agent` CLIs. Treat them like a developer with shell access to the worktree, and try Sourcerer on copies of your repos first.
- Content fetched from the web is passed to agents as untrusted data.

## Development

```sh
git clone git@github.com:erayaydinn/sourcerer.git && cd sourcerer
pnpm install && npm link      # pnpm 9+; npm link only symlinks the bin
pnpm test && pnpm lint
```

Inside the clone, `sourcerer` uses the clone itself as its workspace (rule 3 above).
