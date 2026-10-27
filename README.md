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

Run `sourcerer` with no arguments for the interactive terminal UI: an agent list with status and cost, a live view of the events or of any agent's output (Tab switches; PgUp/PgDn scroll it, Home/End jump to the start or back to the live end; on a Mac keyboard Fn+↑/↓), and an input box with history (↑↓) and `/command` completion (Tab). Type a task to start it (one at a time). `sourcerer --plain` (or a non-terminal stdin/stdout) gives a plain line-based session with the same commands. Commands: `/status`, `/cost`, `/logs <runId>`, `/llm role=profile` (this session only), `/approve`, `/reject` (answer a budget question), `/stop`, `/doctor`, `/help`, `/exit`. Ctrl+C once stops the running task (the agents and everything they started are killed, and logs are kept); twice exits.

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

When a task is unclear in a way that would change the plan, the planner may ask up to 5 questions before planning. You answer them one by one, and Enter skips a question. Questions are asked in the terminal UI and the plain session, and by `sourcerer run` when it runs in a terminal. Without a terminal (scripts, CI), the planner states its assumptions instead. Questions and answers are saved to `runs/<id>/questions.json`. Answering costs one extra planner call.

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

**Several models from one CLI (e.g. Cursor).** Each agent can use a different model of the same CLI:

```sh
cursor-agent models                                        # the models your account can use
sourcerer use reviewer cursor-main --model <model>         # same profile, another model, per agent
sourcerer models add cursor-fast --cli cursor-agent --provider <vendor> --model <model>
sourcerer use coder cursor-fast --fallback cursor-main     # a separate profile also works as a fallback
```

- `--provider` is the vendor behind the model (e.g. `xai` for Grok, `openai`, `anthropic`), not the CLI. It drives the check that the reviewer uses a different provider than the coders.
- A CLI that reports no cost (cursor-agent) needs a `pricing:` row per model in `sourcerer.yaml` for cost estimates. Without one, cost shows as unknown, but token limits still work.
- `sourcerer smoke <profile>` tries the profile's own model, not one given with `use --model`. To try another model, make it a profile.
- Which models are available, and whether one can be selected explicitly with `--model`, depends on your plan with that CLI. Check with `smoke` before a long run.

**`sourcerer.yaml` sections**: `llms` (profiles, replaced by name), `agents` (`<name>: { llm, model, fallbackLlm }`), `repos` (`<side>: { base, setup, test, docs, commands, path }`; `commands`: extra commands that repo's coder may run, e.g. `[make fmt, make generate-swagger]`; `base` defaults to the repo's main branch: origin's default branch, else `main` or `master`), `budget`, `review`, `tools`, `paths`, `pricing` (`<model>: { input, output, cachedInput }`, USD per 1M tokens; needed for CLIs that don't report cost). To change a prompt, put a full agent file in `<workspace>/agents/<name>.yaml`: it replaces the package's agent of that name (or adds a new agent).

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

## Another machine

```sh
nvm install 22 && nvm use 22
git clone git@github.com:erayaydinn/sourcerer.git && cd sourcerer && pnpm install && npm link
# log in to the agent CLIs you use (claude, cursor-agent login)
sourcerer setup          # repo paths, profile/model per role, limits
sourcerer doctor
```

- **Defaults:** the default profiles and models come with the package. Your changes live in `~/.config/sourcerer/sourcerer.yaml`, which is not in git.
- **Carrying your choices over:** copy `sourcerer.yaml` (it holds no secrets), or run the `models add` / `use` commands again.
- **`.env`:** don't copy it. Repo paths differ per machine and it holds your API keys; `sourcerer setup` creates it.
- **First task on a large repo:** it builds the search index first. Run `sourcerer index` beforehand to avoid the wait.

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

## Security

Secure by default; loosen per workspace under `security:` in `sourcerer.yaml`.

**What leaves your machine.** Agents send code, task text, diffs and test output to the LLM provider of each profile: Anthropic for `claude`, Cursor and the model's vendor for `cursor-agent`, or your API endpoint. Use accounts your organization has approved for its code.

**What agents may do**

| Setting | Default | Effect |
|---|---|---|
| `webAccess` | `false` | removes web search/fetch from every agent |
| `commandAllowlist` | `true` | coders may only run `allowCommands` + `extraCommands` + their own repo's `commands` and `setup`/`test` command (the list is also given to the coder). Chained commands (`git status && cat ~/.ssh/id_rsa`), `curl`, `ssh` and `git push` are denied |
| `confineFiles` | `true` | Claude can only read and search its worktree and the other repo |
| `sandbox.enabled` | `auto` | **macOS:** agent CLIs, every command they run, your tests and setup commands run in an OS sandbox (`sandbox-exec`). Nothing under your home folder can be read or written except the task's worktree (and its `.git`), the other repo (read-only), the CLIs' own install and login folders, language toolchains and package caches. Add paths with `sandbox.allowRead` / `allowWrite` |
| `trustUnconfinedCli` | `false` | without the sandbox (other platforms, or turned off), `cursor-agent` can't be limited: it reads any file, even with its own `--sandbox` flag. So it is refused unless you set this |
| `secretFiles` | `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`, ... | never indexed, never shown to the reviewer (name only) |

The sandbox and the Claude restrictions were checked with real calls. Inside the sandbox, both `claude` and `cursor-agent --force` work normally, but get "Operation not permitted" for files elsewhere in your home folder. API agents (openai-compat, anthropic) use Sourcerer's own tools, which are already limited to the worktree and follow the same allowlist.

**Redaction.** Secret-looking values (cloud and API keys, tokens, private keys, `password=...`) are replaced with `[REDACTED]` in everything Sourcerer sends (contract, context, diffs, test output, feedback) and in run logs. An agent CLI's own file reads are outside this, which is why reads are confined.

**On disk.** The workspace (`~/.config/sourcerer`, mode 700) holds `.env` (mode 600), run logs (prompts, diffs, agent output) and the search index (code snippets). Remove them with `sourcerer clean --runs [--older-than 30d] --index --yes`. Worktrees are never touched; use `sourcerer worktree remove`.

**Limits.**

- **Network stays open:** the CLIs must reach their LLM API, and the macOS sandbox can't filter by domain. An agent could send what it can read (the worktree) elsewhere.
- **CLI logins stay readable:** the CLIs' own login data (e.g. the Keychain) has to be readable.
- **Other platforms:** off macOS there is no sandbox yet. There, coder-written code (tests) can do anything your user can, so use a container or VM without your credentials. Review every diff before you commit; Sourcerer never commits or pushes. `sourcerer doctor` shows the current security settings.

## Development

```sh
git clone git@github.com:erayaydinn/sourcerer.git && cd sourcerer
pnpm install && npm link      # pnpm 9+; npm link only symlinks the bin
pnpm test && pnpm lint
```

Inside the clone, `sourcerer` uses the clone itself as its workspace (rule 3 above).

## License

MIT, see [LICENSE](LICENSE).
