# Progress

## Phase 1: Skeleton (done)

Built:
- package.json (ESM, scripts: test, lint, validate), eslint flat config, .gitignore, .env.example.
- src/core/schemas.js: zod schemas for LLM profiles (cli | openai-compat | anthropic), capabilities, factory config and agent definitions.
- src/core/config.js: readYaml, loadConfig (paths resolved from project root), loadEnv (built-in process.loadEnvFile).
- src/core/factory.js: loadAgents, validate (returns { errors, warnings }), createAgent.
- config/factory.config.yaml with profiles claude-strong, claude-cheap, codex-main, cursor-main, gpt-api (models are <model> placeholders).
- agents/: planner, coder-frontend, coder-backend, reviewer.
- scripts/validate.js and test/factory.test.js (10 tests).

Validation rules:
- Errors: unknown llm or fallbackLlm, coder (or its fallback) on editsFiles:false, coder without repo, reviewer with write_file/run_command, duplicate names.
- Warnings: reviewer shares a provider with a coder, keyEnv set but env var missing.

Decisions:
- TypeScript dropped entirely (no tsc, @ts-check, jsconfig). Project renamed to Sourcerer.
- Each profile has an explicit `provider` field, used for the reviewer-vs-coder check.

Deliberately left out: events.js (Phase 4), pricing.yaml and adapters (Phase 2), the --llm override (Phase 7), any check that web tools exclude bash (coders need both), and enforcement of fileScope globs (an adapter/tool concern).

Known issues:
- All models are placeholders. Repo paths ../my-frontend and ../my-backend are placeholders and aren't checked for existence.
- codex is not installed on this machine, so docs/cli-help/codex.txt is missing.
- cursor-agent is not logged in (`cursor-agent login`), so its JSON output shape isn't verified yet.

Setup after Phase 1: saved docs/cli-help/claude.txt (2.1.302) and cursor-agent.txt (2026.04.30). cursor-main is marked jsonOutput: true because cursor-agent supports --output-format json.

## Phase 2: Adapters + cost (mostly done; cursor and codex pending)

Built:
- config/pricing.yaml (empty `models: {}`; fill in real prices), and a `tools` block in factory.config.yaml (maxOutputChars, runCommand allow and timeout).
- Profiles: `maxOutputTokens` (required for anthropic, optional for openai-compat). New `claude-api` profile.
- src/core/cost.js: loadPricing, priceUsage (no price or no usage → costUsd null, 'unknown').
- src/adapters/cli.js: execa runner with recipes keyed by `bin`. The system prompt is prepended to the prompt.
- src/adapters/cli/claude.js: verified against the help text and a real response (test/fixtures/claude.json).
- src/adapters/cli/_template.js: template for gemini, opencode and aider.
- src/adapters/openai-compat.js and anthropic.js: single chat call with tools. No key needed when keyEnv is unset.
- src/adapters/agent-loop.js: built-in loop with maxTurns and an overall timeout. Usage is summed across turns.
- src/adapters/index.js: runAgent(agent, { prompt, cwd, config, pricing }).
- src/tools/: read_file, write_file, run_command, search_code (git grep -E), web_fetch. Cwd sandbox handles symlinks.
- docs/capabilities.md, `npm run smoke` (skips profiles whose model is still <model>).
- Tests: 22 total (cost, claude recipe, tools sandbox, agent loop with a fake API).

Verified for real: a claude CLI end-to-end call reported its cost, and `dontAsk` blocked Write and Bash when only Read was allowed.

Deliberately left out:
- web_search for API agents (no search provider chosen).
- The fallbackLlm retry and budget checks (orchestrator, Phase 4).
- fileScope glob enforcement.
- Claude's `--max-budget-usd`.

Known issues:
- cursor-agent recipe: done later, see "Cursor adapter" at the end.
- codex recipe not written: not installed, and there's no help file.
- run_command allows node, npm, npx and git, so an agent can still run arbitrary code (`node -e`) or `git push`. The allowlist is per binary, not per subcommand. Tightening it (and limiting Claude Bash to it) is deferred, by your decision.
- The claude CLI can't enforce maxTurns. Claude's `run_command` maps to unrestricted Bash, which ignores our allowlist.
- openai-compat and anthropic adapters have not been run against a real API (no keys set).

Next: cursor recipe after `cursor-agent login`; codex recipe after install (both deferred).

## Phase 3: Worktrees (done)

Built:
- Config: `repos.<side>` is now `{ path, base, setup?: { run, timeoutSec } }`, and there's a new `paths.worktrees` (./worktrees, gitignored).
- src/git/worktree.js:
  - taskSlug: lowercase, a-z0-9 and -, at most 40 characters.
  - createWorktrees(config, slug, sides): branch feat/<slug> from `base`, worktree at worktrees/<slug>/<side>, then runs `setup`. Refuses an existing branch or folder. On failure it undoes only what it just created.
  - removeWorktrees(config, slug, { force }): removes the worktrees and keeps the branch. git refuses dirty worktrees unless forced.
  - workspaceFor(agent, worktrees, taskDir): coders get their own worktree as cwd and the other worktree in readDirs. Planner and reviewer get the task folder.
- readDirs support:
  - API tools: read_file and search_code (new optional `path`) may use readDirs. write_file and run_command are limited to cwd.
  - Claude CLI: readDirs are passed as `--add-dir`, and write tools are scoped to `Edit(./**)` and `Write(./**)`. A real call verified this: a write into an --add-dir folder was denied and its read was allowed.
- scripts/worktree.js (`npm run worktree -- create "<task>" [side]`, `remove <slug> [--force]`).
- Tests: 31 total (7 new worktree tests on temp git repos, plus readDirs tool and recipe tests).

Decisions:
- You commit and push yourself. Sourcerer never commits or pushes.
- `setup` became an object so its timeout lives in YAML. Git calls use a fixed 60s timeout in code.

Deliberately left out: diffs (Phase 4), wiring into a full run (Phase 4), and checking at validate time that the repo paths exist and are git repos (git errors clearly when they aren't).

Known issues:
- A claude coder's Bash is not scoped, so it could still write into the read-only repo through the shell (part of the deferred allowlist work).
- Remove refuses while your work is uncommitted, by design. Commit inside worktrees/<slug>/<side> first, or use --force to discard it.
- Two tasks with the same slug collide (the second one is refused).

## Phase 4: Orchestrator core (done, acceptance met)

Built:
- src/core/events.js: event names plus zod payload schemas, checked by `emit` (Node EventEmitter). Events: run.started, agent.started, agent.finished, diff.ready, review.requested, cost.updated, run.finished.
- src/core/prompts.js: planner, coder and reviewer prompts, plus `parseJsonBlock`. The planner and reviewer must end with a fenced json block, validated with zod.
- src/core/orchestrator.js `runTask`: planner (cwd = run folder, both base repos read-only) → contract.txt → worktrees for the chosen sides only → coders in parallel (allSettled, then the first failure is thrown) → diffs (`git add -N` + `git diff base`) → reviewer → review.json.
  - Retries once with fallbackLlm.
  - Budget is checked after every successful call. confirm() questions are queued, and after one "no" it never asks again.
- src/core/cost.js: createBudget, addCost, overBudget (unknown cost counts as 0).
- src/core/run-logger.js writes runs/<id>/: orchestrator.log, <agent>.log, <agent>.json (one entry per attempt), summary.json (total, perAgent, perLlm, unknownCostCalls, reviewRounds, worktrees).
- src/git/worktree.js: diffWorktree.
- scripts/run.js: `npm run task -- "<task>"`.
- Tests: 38 total (7 orchestrator tests with a fake runner on temp git repos).

Real acceptance run (scratch project with two tiny repos, claude CLI `sonnet` alias for every role):
- "Add GET /api/greeting..." was planned with an OpenAPI contract, then both coders ran in parallel and their tests pass in the worktrees. The reviewer approved with 4 comments.
- Cost $0.34, all reported (planner $0.12, coders $0.08 and $0.09, reviewer $0.06). Base branches unchanged, nothing committed.
- The same project with maxCostPerRun 0.05 stopped after the planner with status stopped-budget, before creating any worktree.

Decisions: contract goes in prompts only; worktrees are left for you to commit; Sourcerer never commits or pushes.

Deliberately left out:
- The review loop (Phase 5).
- Live streaming into <agent>.log (Phase 6). Logs are written when each call ends.
- Claude's `--max-budget-usd` hard limit within a single call.
- Cancelling the other coder when one fails or the budget stops. It finishes first.
- `--llm` override (Phase 7).

Known issues:
- The budget is only checked after a call ends, so one long call can overshoot it.
- Diffs aren't truncated, so a big diff (e.g. a lockfile) goes into the reviewer prompt in full.
- In the scratch run the reviewer used the same provider as the coders (only Anthropic is available here); the warning showed as designed.
- Failed attempts record cost as null/unknown even if the CLI spent money.

## Phase 5: Review loop (done, not run for real)

Built:
- Config:
  - `review: { maxRounds: 3, testOutputChars: 2000 }`. maxRounds counts coder passes, so 3 means up to 2 fix rounds.
  - Optional `repos.<side>.test: { run, timeoutSec }`, run by the orchestrator after each coder pass.
- Reviewer output is now per side: `comments: { frontend, backend, general }`.
- Loop in orchestrator `reviewLoop`:
  1. The coders that have work run in parallel.
  2. Their test commands run, and the output is saved to `<side>.r<N>.test.txt`.
  3. Failing tests skip the reviewer: the failing side gets the output tail, and that pass counts as a round.
  4. Otherwise the orchestrator writes `<side>.r<N>.diff` for every side and the reviewer runs, getting the test results and its own previous comments. Its verdict goes to `review.r<N>.json`.
  5. On request-changes, only the sides with their own comments rerun (with the general comments added). If there are only general comments, every side reruns.
  6. Each fix round is a fresh coder call that's told its earlier changes are in the worktree.
- Statuses: approved, changes-requested (rounds used up), tests-failed (still red after the last round), failed, stopped-budget.
- Events: `round` added to agent.* / diff.ready / review.requested; new tests.finished and review.finished; run.finished carries rounds and finalComments. The planner logs as round 0.
- summary.json: rounds, reviewRounds (reviewer calls), finalComments. <agent>.json entries carry round.
- Tests: 44 total (7 new loop tests: side-only feedback, general-only, maxRounds exhausted, failing tests go back to the coder, tests-failed, budget stop mid-loop).

Not verified for real: per your decision there was no paid scratch run for this phase. The scratch project from Phase 4 needs a `review` block to run again.

Deliberately left out:
- tmux and log streaming (Phase 6).
- Diff truncation.
- Resuming CLI sessions between rounds.
- Cancelling a running coder.

Known issues:
- Diffs grow every round and aren't truncated.
- Each fix round is a fresh call, so the coder re-reads its context, which costs extra tokens.
- `maxCostPerAgent` covers all rounds, so a long loop hits it sooner. You're asked as usual.

## Phase 6: Multi-screen via tmux (done)

Built:
- Live logs:
  - runAgent takes `onLog(line)`, and the orchestrator emits an `agent.log` event per line.
  - The logger writes `<agent>.log` live: a header per attempt, the streamed lines, then a footer with status, cost and time. Output is repeated only if nothing was streamed.
- Claude CLI moved to `-p --verbose --output-format stream-json`. stream-json requires --verbose (checked with a real call). The log shows assistant text and `→ Tool {input}` lines, and parse() reads the final result line. Fixture: test/fixtures/claude-stream.jsonl (claude.json removed).
- The API loop logs each turn's text and tool calls.
- src/ui/tmux.js: launchArgs/launch, openLogPanes (orchestrator on top; coder-frontend, coder-backend and reviewer below, each `tail -n +1 -F`, with pane titles), openShellWindow.
- `npm run task -- --tmux "<task>"`:
  - Outside tmux it creates session `sourcerer-<slug>`; inside tmux it opens a new window.
  - The top pane is the real orchestrator, so budget and pause questions are answered there.
  - Panes stay open after the run, which prints the kill-session or kill-window command.
- `--interactive` (works with or without --tmux):
  - Pause points before every reviewer call and before every fix round: [C]ontinue / [s]kip / [a]bort.
  - New statuses: `unreviewed` (skipped the review) and `aborted`.
  - With --tmux, a separate `worktrees` window opens one shell per worktree. That's a deviation from the plan: the log panes stay as logs.
- New events: agent.log (kept out of orchestrator.log) and worktrees.ready.
- Tests: 54 total. New ones cover the stream parser, real streaming through a fake `claude` on PATH (lines arrive before the end), live log writing, pause skip/abort, worktrees.ready, and the tmux argument builders.

Verified for real in tmux 3.8, using a fake claude CLI: pane layout and order, live streaming into panes, panes staying open, the interactive pause answered via send-keys, and worktree shells in the right folders. The outside-tmux attach (`tmux new-session` in the foreground) can't be tested in this harness, which has no terminal.

Incident: the first tmux check accidentally ran the real claude CLI and spent about $0.19 plus a cut-off reviewer call before I killed it. Cause: tmux runs the command through the login shell, whose startup files reset PATH, so `-e PATH=...` had no effect. The check now sets PATH inside the command and refuses to start unless `claude` resolves to the fake.

Deliberately left out:
- The Phase 7 CLI (`sourcerer run --tmux`).
- The ink TUI.
- A planner pane (its output shows in the orchestrator pane).

Known issues:
- Windows needs WSL.
- On a very small terminal, `split-window` can fail with "no space for new pane". The error is printed and the run continues.
- tmux session names collide if the same task slug is still open.

## Phase 7: CLI (done)

Built:
- `sourcerer`, from src/cli/index.js via package.json `bin`. Install it with `npm link`. Commander, one small file per command in src/cli/.
- Global `--root <dir>`. It defaults to Sourcerer's own folder, so the CLI works from any directory and through the npm link symlink.
- Commands:
  - `run [--tmux] [--interactive] [--llm <role|agent>=<profile>]... <task...>`
  - `status [-n]`
  - `logs [runId] [--agent] [-f]`
  - `cost [runId] [--since 30m|24h|7d] [--by agent|role|llm]`
  - `validate [--llm ...]`
  - `smoke [profiles...]`
  - `worktree create|remove`
- Run ids accept a unique prefix, and the latest run is the default.
- `--llm` (factory.js applyLlmOverrides):
  - The key is a role or an agent name, and a name wins over a role.
  - The override is applied before validation, so the usual rules still apply.
  - The agent's own `model:` is dropped when its profile changes.
  - An unknown key or a malformed pair is an error.
- src/core/run-history.js: listRuns, findRun, readCalls (reads <agent>.json, so interrupted runs count), groupCost, parseSince.
- Cost tables show calls and unknown-cost calls per row, and print a note when anything counted as $0 because its cost was unknown.
- scripts/ was removed: run, validate, smoke and worktree all moved into the CLI. `npm run validate` and `npm run smoke` call the CLI; `npm run task` and `npm run worktree` are gone.
- Tests: 69 total (run history, CLI via parseAsync on a temp root, --llm overrides).

Verified, all free: every command against the scratch project's runs, the CLI through a symlink (the same thing `npm link` creates), and `run --tmux --llm reviewer=...` inside tmux with the fake claude. That opened a new window with the panes and passed the override through.

Deliberately left out: `sourcerer index` (Phase 8, per your decision) and the TUI (Phase 9).

Known issues:
- `cost --since` uses the time encoded in the run id, which is local time.
- `logs -f` follows a single file. Use `--tmux` to watch every agent.
- `npm link` hasn't been run on this machine; that's up to you.

## Phase 8a: grep-based RAG (done)

8b (LanceDB index per repo, hybrid vector + BM25 search, reranker, branch overlay, post-commit reindex, `sourcerer index`) is deferred until grep proves too weak on your real repos, per your decision. It needs an embedding model and a reranker model chosen by you.

Built:
- `rag.scope` is now enforced. It's validated as frontend | backend | contract | docs. The orchestrator turns it into `sources` for the tools:
  - Code: a side's worktree, or the base repo before worktrees exist (the planner's case).
  - contract: runs/<id>/contract.txt.
  - docs: each repo's `docs` paths plus its commit messages.
  - With no scope, the tools fall back to the workspace.
- Config: `repos.<side>.docs: [docs, adr, README.md]`.
- src/tools/search.js (search_code moved here from files.js):
  - search_code(pattern, source?): searches every code source in scope; results look like `<source>:<file>:<line>:<text>`.
  - find_symbol(name): definitions in JS/TS, Python and Go, using POSIX-ERE patterns. The name is validated, so no regex can be injected.
  - search_docs(pattern): case-insensitive over doc paths, the contract and `git log --grep` (20 most recent per repo).
- Regex: `-P` (Perl) by default, falling back to `-E` once git reports no PCRE. macOS `git grep -E` silently ignores `\s` and `\b`, which is why -E is only the fallback.
- Searches include `--untracked`, so coders' uncommitted new files are found and gitignored files are skipped. A repo without commits gives "no matches" for commit search instead of an error.
- Agent YAMLs gained find_symbol and search_docs. The claude recipe maps both to Grep, and duplicate tool names are removed.
- Tests: 76 total. The search tests use temp repos with code, docs, ADRs and commits, and cover scope enforcement, symbols per language, untracked and ignored files, commit search, and per-agent sources in the orchestrator.

Verified on Sourcerer's own code (free): find_symbol, and search_code with `\b`/`\s`, which skips node_modules.

Deliberately left out:
- All of 8b.
- An MCP server to give claude CLI agents these tools.
- tree-sitter.

Known issues:
- find_symbol is regex-based. It misses e.g. object-method shorthand (`foo() {}` inside a class or object) and other languages.
- search_code results aren't ranked, so large repos rely on truncation (tools.maxOutputChars).
- The contract is matched case-insensitively and the code isn't. That's by design, but note it.

## Phase 9: TUI (skipped)

Skipped by your decision: no `sourcerer ui`, and ink and react are not installed. To watch runs, use `sourcerer run --tmux`, `sourcerer logs -f` and `sourcerer status`/`cost`.

Next: decide on 8b after real use, or Phase 10 (optional decide.js).

## Cursor adapter (deferred from Phase 2, done)

- src/adapters/cli/cursor.js, registered as `cursor-agent`:
  - Runs `-p --output-format stream-json --trust --workspace <cwd> --model <model>`, with the prompt on stdin (verified).
  - Read-only agents get `--mode ask`; agents with run_command get `--force`.
- Live log: assistant text and `→ read/glob/... {args}` from `tool_call` started events. Thinking and tool results are skipped.
- Cost: Cursor reports tokens (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) but no cost. It's estimated from pricing.yaml, or unknown. inputTokens excludes cache reads (verified).
- Saved docs/cli-help/cursor-agent-models.txt: composer-2.5 plus Grok 4.7/4.6/4.5 variants.
- Fixture test/fixtures/cursor-stream.jsonl. Tests: 82 total (command args, parse, logLine, errors, streaming through a fake `cursor-agent`).
- Real calls, a few cents total: JSON and stream samples, plus one end-to-end call through runAgent (streamed live, parsed, cost unknown with empty pricing).

Known issues:
- No tool allowlist. `--force` lets a coder run any command, the same gap as the deferred allowlist work.
- No `--add-dir`: the other repo is "read-only" only by prompt.
- On your Plus plan `--model composer-2.5` is refused, though Composer is the default; use a Grok id.
- cursor-main still has `<model>` and `provider: cursor`. Set both before use.

## `--side` (done)

- `sourcerer run --side backend "<task>"` (repeatable; values frontend/backend). Without it the planner decides, as before.
- The planner still runs (contract + instructions) and is told the work is limited to those sides. Its `sides` choice is overridden, and the run fails if it wrote no instructions for a forced side.
- Only the forced sides get worktrees, coders, tests and diffs. An invalid value fails before any LLM call. The tmux relaunch passes `--side` on, and run.started logs `sides`.
- Tests: 86 total. Verified with the fake claude: the planner picked both sides, but only backend ran.

## Config from env: repo paths and per-role models (done)

- Every YAML file (config, agents, pricing) supports `${VAR}` and `${VAR:-default}` (src/core/env.js). Values are filled in before zod validation, so env values follow the same rules.
  - Unset and empty count the same.
  - A variable without a default that isn't set is an error naming the file and key path.
- `loadConfig` loads `<root>/.env` itself, so every command sees it. Shell variables win over .env.
- Repo paths: `SOURCERER_FRONTEND` and `SOURCERER_BACKEND` (required). The local `.env` has them; .env is gitignored, so personal paths no longer go to git.
- Per role: `SOURCERER_{PLANNER,CODER,REVIEWER}_LLM` picks the profile (default: the agent YAML's) and `..._MODEL` picks the model (default: the profile's model). CODER covers both coders.
- Precedence: `--llm` > env > YAML. `--llm` drops the env model, since it belonged to the old profile.
- An empty `model`/`fallbackLlm` counts as not set (schemas.js `optionalText`).
- `.env.example` lists every variable.
- Tests: 92 total (interpolation, missing-var paths, empty model, role vars, --llm precedence).

Known issue: whether a model exists in the chosen CLI can't be checked statically. Use `sourcerer smoke`.

Limits from env as well:
- `SOURCERER_MAX_COST_PER_RUN` (default 5), `SOURCERER_MAX_COST_PER_AGENT` (default 2) and `SOURCERER_MAX_ROUNDS` (default 3).
- Env text is converted to numbers only for those fields (schemas.js `envNumber`). Non-numbers and out-of-range values fail validation with the key path.
- Other numeric fields (timeouts, maxTurns, testOutputChars) are still YAML-only.
- Tests: 93 total.

## npm package + workspaces (done, not published)

- Workspace resolution (src/cli/root.js): `--root` > `SOURCERER_ROOT` > nearest parent folder with config/ + agents/ (so the dev clone and worktrees inside it still work) > `$XDG_CONFIG_HOME/sourcerer` or `~/.config/sourcerer`. No match is an error that says to run `sourcerer init`. The package folder is no longer a default.
- `sourcerer init [dir]` (src/cli/init.js): copies the package's config/, agents/ and .env.example, plus a .env made from .env.example. Existing files are never overwritten. Target: [dir] > --root > SOURCERER_ROOT > ~/.config/sourcerer.
- package.json:
  - Name `@erayaydinn/sourcerer` (`sourcerer` is taken on npm). `private` is removed.
  - `files` = src, config, agents, .env.example and README.md (46 files, 29.8 kB).
  - `publishConfig.access: public`, `license: UNLICENSED` (pending your choice).
- README.md (English): install, init, usage, configuration, safety notes, development.
- Tests: 97 total (root resolution, init copy/skip/.env).
- Verified (free): `npm pack`, then install into a temp prefix, `init` into a temp XDG_CONFIG_HOME, validate, and a fake-claude run from another folder. runs/ and worktrees/ were created in the workspace and the package folder stayed clean.
- This machine: `sourcerer init` created ~/.config/sourcerer, and its .env has the ai-frontend/ai-backend paths. Outside the repo, `sourcerer` uses that workspace. Inside ~/Repos/Sourcerer it still uses the repo, which keeps the earlier run history (login-alt-yapisi-kur).

Not done: `npm publish` (needs your npm login and explicit go).
