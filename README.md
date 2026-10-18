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

- Node.js 22+ and git
- At least one agent CLI, logged in: `claude` (Claude Code) and/or `cursor-agent`
- Optional: `tmux` (for `--tmux`; on Windows use WSL)

## Install

```sh
npm install -g @erayaydinn/sourcerer      # or: pnpm add -g @erayaydinn/sourcerer
sourcerer init            # creates ~/.config/sourcerer (sourcerer.yaml, .env)
```

Edit `~/.config/sourcerer/.env`:

```sh
SOURCERER_FRONTEND=/path/to/frontend-repo
SOURCERER_BACKEND=/path/to/backend-repo
```

Or let the wizard fill in what is missing (repo paths, LLM and model per role, budget, token and round limits, key names, pricing rows):

```sh
sourcerer setup           # interactive, safe to re-run, never asks for API keys
sourcerer doctor          # OK / WARN / FAIL per check; exit 1 on any FAIL
sourcerer doctor --smoke  # also says hi through each profile (costs a few cents)
```

## Usage

Run `sourcerer` with no arguments for the interactive terminal UI: an agent list with status and cost, a live view of the events or of any agent's output (Tab switches), and an input box with history (↑↓) and `/command` completion (Tab). Type a task to start it (one at a time). `sourcerer --plain` (or a non-terminal stdin/stdout) gives a plain line-based session with the same commands. Commands: `/status`, `/cost`, `/logs <runId>`, `/llm role=profile` (this session only), `/approve`, `/reject` (answer a budget question), `/stop`, `/doctor`, `/help`, `/exit`. Ctrl+C once stops the running task (the agents and everything they started are killed, and logs are kept); twice exits.

```sh
sourcerer run "Add GET /api/users with pagination"
sourcerer run --side backend "Add rate limiting"          # only the backend
sourcerer run --tmux "..."                                 # one pane per agent
sourcerer run --interactive "..."                          # pause before each review / fix round
sourcerer run --llm reviewer=claude-cheap "..."            # swap an agent's LLM for one run
# Ctrl+C once stops the task cleanly, twice exits

sourcerer status                                           # recent runs
sourcerer logs [runId] [--agent coder-backend] [-f]
sourcerer cost [runId] [--since 7d] [--by agent|role|llm]
sourcerer worktree remove <slug> [--force]                 # after you have committed
```

Run ids accept a unique prefix and default to the latest run.

## Configuration

Prompts, tools, default LLM profiles and limits ship with the package, so updates reach you. Your workspace (`~/.config/sourcerer` by default) holds only your choices:

```
sourcerer.yaml   what you changed (profiles, per-agent choices, limits, prices, repo commands)
.env             machine-specific values and secrets (repo paths, API keys); never committed
runs/  worktrees/  history
```

Precedence, strongest first: `--llm` → `.env` / shell variables → `sourcerer.yaml` → package defaults.

**Choose models per agent**

```sh
sourcerer models                                   # profiles, where they come from, who uses them
sourcerer models add cursor-high --cli cursor-agent --provider xai --model grok-4.7-high
sourcerer use coder-backend cursor-high            # one agent
sourcerer use reviewer claude-strong --model opus --fallback claude-cheap
sourcerer use coder claude-cheap                   # every agent of a role
sourcerer agents                                   # agent -> profile -> model, and where each value comes from
sourcerer models remove cursor-high                # refused while an agent uses it
```

These commands edit `sourcerer.yaml` (comments are kept) and refuse to save an invalid result, e.g. a coder on a profile that cannot edit files. In the TUI: `/models`, `/agents`, `/use`.

**`sourcerer.yaml` sections**: `llms` (profiles, replaced by name), `agents` (`<name>: { llm, model, fallbackLlm }`), `repos` (`<side>: { base, setup, test, docs, path }`), `budget`, `review`, `tools`, `paths`, `pricing` (`<model>: { input, output, cachedInput }`, USD per 1M tokens; needed for CLIs that don't report cost). To change a prompt, put a full agent file in `<workspace>/agents/<name>.yaml`: it replaces the package's agent of that name (or adds a new agent).

**Environment variables** (see `.env.example`):

| Variable | Meaning | Default |
|---|---|---|
| `SOURCERER_FRONTEND`, `SOURCERER_BACKEND` | repo paths | required |
| `SOURCERER_{PLANNER,CODER,REVIEWER}_LLM` / `_MODEL` | profile / model for every agent of a role (good for one-off runs) | from `sourcerer.yaml` / package |
| `SOURCERER_MAX_COST_PER_RUN`, `SOURCERER_MAX_COST_PER_AGENT` | budget in USD | 5, 2 |
| `SOURCERER_MAX_ROUNDS` | coder passes per task | 3 |
| `SOURCERER_MAX_TOKENS_PER_RUN`, `SOURCERER_MAX_TOKENS_PER_AGENT` | token limits (input + output, not cache reads) | none |

The workspace is found in this order: `--root <dir>`, `SOURCERER_ROOT`, the nearest parent folder with a `sourcerer.yaml`, then `~/.config/sourcerer` (or `$XDG_CONFIG_HOME/sourcerer`).

**Upgrading from the old layout** (a workspace with full `config/` and `agents/` copies): run `sourcerer migrate`. It keeps only your differences in `sourcerer.yaml`, keeps agents whose prompt you changed as overrides, and moves the old copies to `*.bak-<date>/`.

## Code search (BM25)

Large repos are the main use case, so each repo gets a BM25 index and every coder's first prompt starts with the most relevant files and snippets for its part of the task. This works with any agent CLI, and saves the agents from spending turns (and tokens) on exploration.

```sh
sourcerer index                                   # build/update both repos (also done at the start of a task)
sourcerer index --side backend --query "rate limit login attempts"   # see the ranking
```

- **Indexed:** the base branch's last commit (`git ls-tree`). Changes in a task's worktree are overlaid at query time.
- **Updates:** analyses are cached by git blob hash, so only changed files are read again.
- **Ranking:** identifiers are split on camelCase and snake_case. File paths and definitions (PHP, Python, Go, JS/TS) weigh more than body text.
- **Skipped:** `vendor/`, `node_modules/`, build output, lock files, binaries and files over `rag.maxFileBytes`. Change this with `rag:` in `sourcerer.yaml`. `rag.context` sets how many files and characters go into a prompt, and `rag.enabled: false` turns it off.
- **Where it lives:** the index is in `<workspace>/index/`. The context each coder got is saved in `runs/<id>/<side>.context.txt`.
- **Limits:** this is lexical search. It finds words, not meaning, and doesn't translate. The coder query is built from the planner's contract and instructions (usually English) plus the task.

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

## License

MIT, see [LICENSE](LICENSE).
