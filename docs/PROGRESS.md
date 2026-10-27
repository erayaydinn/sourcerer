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

## Phase 9: TUI (first skipped, later built: see "Phase 9: ink TUI" at the end)

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
- This machine: `sourcerer init` created ~/.config/sourcerer, and its .env has the frontend/backend paths. Outside the repo, `sourcerer` uses that workspace. Inside ~/Repos/Sourcerer it still uses the repo, which keeps the earlier run history (login-task).

Not done: `npm publish` (needs your npm login and explicit go).

## pnpm + pinned versions (done)

- Dependencies are pinned exactly (no ^), using the installed versions.
- Moved to pnpm: `pnpm import` kept every version from package-lock.json. package-lock.json is removed, and pnpm-lock.yaml (lockfile 9.0) plus `packageManager: pnpm@9.15.9` are added.
- Same-major update: every dependency was already the newest of its major, so nothing changed.
  - Newer majors available, not taken: commander 15, execa 10, openai 7, eslint 10 / @eslint/js 10.
- Dev link: `npm link` still works with the pnpm-installed node_modules (it only symlinks the bin; verified with a temp global prefix). `pnpm link --global` failed in the sandbox over the global store location, so the README uses npm link.

## Reviewer context (done), after the login-task review

Why: the reviewer approved, but it missed two deploy blockers. (1) The coder edited .gitignore and the deploy exclude list, which are gitignored themselves, so the changes were invisible in the diff and won't be committed. (2) The new deploy exclusions leave no way to create the tables on the server. The reviewer did read both files, but its mandate was "diffs vs the contract". It got no git state and no coder notes (the coder had flagged the problem), and being read-only it couldn't run git or tests.

Changes:
1. Git state: `ignoredFiles(dir, maxChars)` in src/git/worktree.js. The reviewer prompt lists ignored files (folders collapsed, max 50) with the text of small text files, marked "not in the diff, NOT committed by git".
2. Coder notes: the end of each coder's last answer (`review.contextChars`, default 4000) goes into the reviewer prompt, `run.finished`/summary.json `coderNotes`, and the `sourcerer run` final output.
3. Reviewer mandate (prompts.js + reviewer.yaml, including the ~/.config/sourcerer copy):
   - Review in order: contract → correctness/tests → security (incl. abuse/rate limits) → deployment/operations.
   - Never ask to remove a safeguard to follow the contract; flag the conflict instead.
   - Verify the coder notes.
4. Test context: the reviewer sees the exact test command and that it ran only on this machine, or "no test command configured; the coder's own test claims are unverified".
- Each round's reviewer prompt is saved to runs/<id>/reviewer.r<N>.prompt.txt, so "what did the reviewer see" can be answered later.
- Tests: 99 total. Verified on the real worktree: .gitignore and the deploy exclude list now show in the reviewer prompt with their contents.

## Phase 7 follow-up: REPL, doctor, setup, stop (done)

The brief said "Phases 1-6 done"; run/status/logs/cost/validate/smoke/init already existed and were kept. Decisions:
- Stopping is a real stop, so it needed a minimal core change (you chose this).
- No JSDoc/checkJs (no-TypeScript rule).
- One file per command kept; added repl.js, print.js, doctor.js and setup.js.
- No ripgrep check (search uses git grep).
- Pricing rows are added commented, not as empty values.

Built:
- Stop: `runTask({ signal })`.
  - CLI agents run in their own process group, and abort or timeout kills the whole group (SIGTERM, SIGKILL after 3s).
  - The signal also reaches the API loop (SDK requests and tools), setup and test commands, and run_command.
  - No fallback after a stop. Status `aborted`, error "stopped by user", logs kept.
  - `sourcerer run` handles Ctrl+C itself: once stops, twice exits (needed because agents no longer share the terminal's process group).
- REPL (`sourcerer` with no arguments), node:readline:
  - One task at a time. Live events (print.js, shared with `run`). At the end, the total from summary.json, coder notes and worktrees.
  - Commands: /status /cost /logs /llm (validated, session-only) /approve /reject /stop /doctor /help /exit.
  - Budget question: y/n or /approve /reject; /stop aborts it.
  - Ctrl+C once stops the task; twice (or twice within 2s when idle) exits.
- `sourcerer doctor [--smoke]` (read-only):
  - Checks node 20.12+, git, tmux, the workspace, config validation, repos (exist, git, clean/dirty), CLIs used by profiles (version), keyEnv (set/missing only, values never printed), pricing for models that don't report cost, .gitignore (.env, runs/) when the workspace is a git repo, docs/cli-help per installed CLI, and a login reminder.
  - FAIL only for what is actually used. Exit 1 on any FAIL.
- `sourcerer setup [--refresh]` (interactive, re-runnable):
  - Runs init if needed.
  - Writes repo paths (validated) and per-role LLM/model (typed, never suggested) to .env.
  - Adds empty keyEnv names; keys are never asked for.
  - Appends .gitignore lines, saves `<bin> --help`, adds commented pricing rows.
  - Lists the changes, then runs doctor.
- `sourcerer index`: stub ("vector index not built yet (Phase 8b); search uses git grep").
- .env reload: values that came from a .env are refreshed on every load (REPL edits, several roots). Shell variables still win.
- pricing.yaml template is now block style (`models:` plus commented rows), and an empty `models:` is accepted.
- docs/cli-help/cursor-agent.txt refreshed for 2026.10.16. Every flag the recipe uses is still there.
- Tests: 113 total (cancel incl. process-tree kill, REPL via streams, setup on a fresh clone, re-run changes nothing, doctor masking/exit code, .env reload).

Verified for real in tmux, with the fake claude:
- REPL: one Ctrl+C killed both coders (2 → 0 processes), the run ended aborted, and the REPL took the next task. A double Ctrl+C exited 130 with nothing left behind.
- `sourcerer run`: Ctrl+C gave summary status `aborted` / "stopped by user".
- Doctor was also run on this machine.

Deliberately left out:
- Colors and fancy UI.
- REPL history and completion.
- Queueing several tasks (a second task while one runs is refused).
- `logs -f` inside the REPL.
- Checking CLI login state (not reliable).
- /pause answers for --interactive inside the REPL (the REPL has no --interactive).

Known issues:
- Process-group kill is POSIX-only (Windows needs WSL).
- If Sourcerer itself is killed with SIGKILL, detached agent CLIs keep running.
- The cursor-agent stream output format of 2026.10.16 isn't re-verified: run `sourcerer doctor --smoke`.

## Phase 9: ink TUI (done)

Why: the plain REPL had no Claude-CLI-like input area. You chose option A: Node 22 + ink 8.

Environment:
- Node 22.23.3 installed with nvm (`--reinstall-packages-from=20`) and made the nvm default. Node 20 is kept; `nvm use 20` switches back.
- The reinstall copied an old corepack (0.29.3) that hijacked `pnpm` and failed on npm's new signing keys. Fixed with corepack@latest (0.36.0), `corepack disable pnpm`, and a reinstall of pnpm 9.15.9.
- `sourcerer` is linked under Node 22. Terminals opened before the switch stay on Node 20 until reopened.
- engines `>=22`, `.nvmrc` = 22. doctor now requires Node 22.

Packages (pinned):
- ink 8.0.0 (needs Node 22; ink 7 too, ink 6.8 was the Node 20 option).
- react 19.3.0, chosen over 19.3.1 because that was only 3 days old.
- dev: ink-testing-library 4.0.0. No @types.

Built:
- src/ui/session.js: the UI-agnostic session (task queue, slash commands, budget question, /llm, Ctrl+C), moved out of repl.js. Both UIs are thin layers over it.
- src/cli/repl.js: the plain REPL over the session, used when not on a TTY or with `--plain`.
- src/ui/tui.js: ink via `React.createElement`, no build step.
  - Header: status, round, total cost, unknown count and overrides.
  - Agent list: ·/●/✓/✗, round and cost.
  - Main view: events, or any agent's live log; Tab cycles.
  - Budget banner.
  - Bordered input: Enter submits, ↑↓ history (saved to ~/.config/sourcerer/history), Tab completes /commands, Esc clears.
  - A chunk ending in Enter (paste, tmux send-keys) is typed, then submitted.
- Entry: `sourcerer` (or `--root x`) on a TTY starts the TUI; `--plain` or non-TTY starts the REPL.
- executeTask accepts an already-loaded project, so config warnings are not printed twice per task.
- Lint ignores worktrees/, and `pnpm test` only runs test/**. Before this, a target repo's worktree inside the workspace was linted and its tests were run as Sourcerer's own.
- Tests: 117 (4 ink render tests: agent states + cost + Tab to a live log, one task at a time + history + completion + Ctrl+C + /exit, budget banner + /reject, paste with Enter).

Verified for real in tmux (120x26) with the fake claude:
- The layout and live updates work.
- Tab showed an agent's live log.
- One Ctrl+C killed both coders (2 → 0), and the header went idle with "2 unknown".
- A double Ctrl+C exited.

Deliberately left out: mouse, panel resizing, themes, multi-line task input, scrolling back through the view (the newest lines are shown).

Known issues:
- Config warnings for unused profiles (missing keys) still appear at each task start. doctor tells them apart; validate does not.
- A very small terminal squeezes the panels (no minimum-size check).

## CLI failures and TUI wrapping (done), after frontend-login-task

What happened: the Claude subscription hit its 5-hour session limit during the frontend coder. Claude said "You've hit your session limit · resets 11:40pm".
- The error shown was execa's message, which is the whole stdout (6.5k characters of stream JSON).
- The first attempt's reported cost ($0.21) was recorded as unknown and not counted in the budget.
- The fallback (claude-cheap) is the same Claude account, so it failed right away.
- In the TUI, long lines were cut off.

Fixes:
- claude recipe: a failed result throws `claude failed (<api_error>): <message>`, with `error.cost` (usage + reported cost) and `error.rateLimited` (429 / usage_limit). A stream without a result line is an error (it used to be parsed as a result).
- runCli: on a non-zero exit, the recipe's structured error is used when there is one. Otherwise `<bin> exited with code N: <last stderr lines>`, or `timed out after Ns`. stdout is never dumped.
- callAgent: a failed attempt's reported cost is logged and charged to the budget. On a rate limit, a fallback with the same CLI bin (same account) is skipped, with a note in the error.
- TUI: lines are wrapped to the panel width (wrapLines) instead of truncated, so errors and logs are readable in full. The budget banner wraps too.
- Tests: 122 total (limit parse with cost, short errors from a fake CLI, failed-call cost in summary + skipped same-account fallback, wrapLines, long line in the TUI).
- Verified: the real failure replayed through the new path gives a one-line error, and tmux at 100 columns shows wrapped lines.

Suggestion, not done: give coders a fallback on another account/provider (e.g. `fallbackLlm: cursor-main`) so a Claude limit doesn't stop the run.

## setup: budget and round limits (done)

- `sourcerer setup` now also asks for SOURCERER_MAX_COST_PER_RUN, SOURCERER_MAX_COST_PER_AGENT and SOURCERER_MAX_ROUNDS.
- The value in brackets is the .env value, or the config default from `${VAR:-default}`.
- Enter keeps it and writes nothing.
- Invalid input is asked again, up to 3 times: budgets must be positive numbers, rounds a whole number of at least 1.
- Tests: 123 total.

## Token limits (done)

- `budget.maxTokensPerRun` and `budget.maxTokensPerAgent` (env SOURCERER_MAX_TOKENS_PER_RUN / _PER_AGENT). Optional: empty means no token limit.
- Tokens counted are input + output; cache reads are not.
- Checked after every call, like the cost limit, with the same pause/continue question ("run used 1,400 tokens, over maxTokensPerRun 1,000").
- Calls with unknown cost but reported tokens (e.g. Cursor) are counted, and so are failed calls that report usage.
- Totals: cost.updated and run.finished carry totalTokens. summary.json has totalTokens and tokensPerAgent. They show in the `run` output and the TUI header.
- `sourcerer setup` asks for both (whole numbers; shows "[no limit]"; typing `none` removes a set limit).
- The existing ~/.config/sourcerer config got the two budget lines, since `init` never overwrites files.
- Tests: 126 total.

Limit: like cost, the token check runs after a call ends, so one long call can go over it.

## Package defaults vs workspace choices (done)

Why: workspaces held full copies of config/ and agents/, so package updates (prompts, new profiles) never reached them, and running inside the repo edited the package's own templates.

New layout:
- Package (read at runtime): config/factory.config.yaml (plain defaults, no `${…}`, no repo paths, `pricing: {}`) and agents/*.yaml (plain `llm:` defaults). config/pricing.yaml is removed; prices live in the `pricing` section.
- Workspace: `sourcerer.yaml` (only your differences), `.env` (paths, keys), runs/, worktrees/, history.
  - An optional `<workspace>/agents/<name>.yaml` replaces that package agent, or adds a new one.
- Precedence: `--llm` > env/shell > sourcerer.yaml > package.
  - Env is applied in code: ENV_SETTINGS in config.js for paths and limits, ROLE_ENV in factory.js for SOURCERER_<ROLE>_LLM/_MODEL.
  - A profile change at any layer drops the lower layers' model, which belonged to the old profile.
  - Each agent def has `sources` ({ llm, model }) for `sourcerer agents`.
- sourcerer.yaml merge: `llms` and `pricing` replace by name; other sections deep-merge (arrays replace). Unknown sections are an error.
- Workspace detection: a folder with sourcerer.yaml. An old-layout folder is detected so it can be migrated. The package folder (this repo) is not a workspace unless it has its own sourcerer.yaml, which is gitignored. So running inside the repo uses ~/.config/sourcerer.
- Missing repo paths give a clear error. `allowMissingRepos` lets models/agents/use work before setup.
- validate only warns about missing keys for profiles an agent actually uses (that warning used to repeat at every task start).

Commands:
- `sourcerer models` lists profiles (kind, provider, model, from, installed, used by).
- `models add [name] --cli|--api --provider --model [--base-url --key-env --max-output-tokens --force]`: interactive when flags are missing. For cursor-agent it shows `cursor-agent models` as a reference; model names are always typed by the user.
- `models remove`: refused while an agent uses the profile, and refused for package profiles.
- `sourcerer agents` shows the agent → profile → model table with sources.
- `sourcerer use <agent|role> <profile> [--model] [--fallback]` warns when an env variable overrides the choice.
- `sourcerer migrate` writes only the differences to sourcerer.yaml (`${X:-d}` defaults are compared as d), keeps agents with changed prompts/tools as overrides, moves the old copies to `*.bak-<stamp>/`, and verifies the result (restores everything if it fails).
- All of these edit sourcerer.yaml through the yaml Document API (workspace-file.js): comments are kept, the result is reloaded and validated, and an invalid one is restored.
- `init` creates a commented sourcerer.yaml + .env (no copies).
- `setup` writes paths and key names to .env, and roles (per agent of the role) plus limits to sourcerer.yaml; it refuses coder profiles that can't edit files, and adds .gitignore lines for .env, runs/, worktrees/ and sourcerer.yaml.
- TUI/REPL: /models, /models add (flags only), /models remove, /agents, /use.
- .env.example: repo paths are empty placeholders now. The old example values counted as "set" and hid the missing-path error.

This machine:
- ~/.config/sourcerer migrated: sourcerer.yaml has only the frontend pnpm setup/test. The old copies are in config.bak-20261018T211758/ and agents.bak-20261018T211758/.
- The earlier runs and worktrees in ~/Repos/Sourcerer stay there; see them with `sourcerer --root ~/Repos/Sourcerer status`.

Tests: 135 (layering/precedence/sources, workspace agent override, models add/list/remove, use, migrate + rollback, setup/doctor on the new layout, session /use).

## Phase 8 (BM25): repo index + coder context (done)

Why: the real target repos are large (10k+ files, millions of lines; PHP, Python, Go, JS). Agent CLIs search with their own tools, so the gain is in handing coders the right starting files, not in faster grep.

Built (no new dependencies):
- src/rag/tokenize.js:
  - Identifiers are split on camelCase, snake_case and digits, lowercased. The parts and the whole identifier are kept.
  - Code keywords and common English words are dropped.
  - Definition regexes for PHP (function/class/interface/trait/enum), Python (def/class), Go (func incl. methods, type) and JS/TS (function/class/interface/type/enum, const arrow/function).
- src/rag/index.js:
  - One index per side from the base branch's last commit: `git ls-tree -r -l -z` + one streaming `git cat-file --batch`.
  - Per-blob analysis cache (index/blobs/<hh>/<hash>.json, shared across sides and rebuilds).
  - Postings as a Uint32Array (doc, tf×10) + meta.json dictionary. Written atomically.
  - Skipped when the base commit is unchanged. Field weights: path ×3, definitions +2.5.
  - Excludes: dir/, *.ext, file names. Also binary files and files over maxFileBytes.
- src/rag/search.js:
  - BM25 (k1 1.2, b 0.75), max 40 query terms ranked by idf.
  - Worktree overlay: `git diff --name-only base` + untracked files are scored from their current content, and their base entries are dropped (deleted files disappear).
  - bestWindow picks the snippet; relevantContext respects maxFiles and maxChars.
- Orchestrator: optional `contextFor({ side, task, plan, worktree })`. Used for the first coder pass only, and saved to runs/<id>/<side>.context.txt. executeTask provides it when rag.enabled: it updates the index, then searches with instructions + contract + task. Errors never fail a run.
- `sourcerer index [--side] [--force] [--query --limit]` prints build stats or the ranking.
- doctor warns when there is no index yet.
- Config: `rag: { enabled, maxFileBytes, exclude, context: { maxFiles, maxChars, snippetLines } }`.
- index/ is gitignored.
- Tests: 142 (tokenizer, definitions per language, excludes, ranking + incremental by commit/blob, worktree overlay, bestWindow + budget, context only in the first pass).
- Smoke on this repo: 88 files indexed in 0.1s, queries take about 2 ms, and the expected files ranked top.

Deliberately left out:
- The planner keyword step (your call).
- Trigram index (agent CLIs already search fast).
- Vector search.
- MCP server.
- Using the index in the API-agent search tools.

Not yet measured: indexing time, size and memory on a 10k+ file repo. Run `sourcerer index` there (it prints time and size).

## Security hardening (done)

Defaults (package config `security:`): webAccess false, commandAllowlist true, confineFiles true, trustUnconfinedCli false, secretFiles list.
- Web tools are stripped from every agent unless webAccess (applySecurity in loadProject).
- Claude:
  - `run_command` becomes `Bash(<cmd>)` + `Bash(<cmd> *)` per allowed command. The allowed commands are allowCommands + extraCommands + each repo's setup/test.
  - read and search tools become `Read|Grep|Glob(./**)` + `(//<readDir>/**)`.
  - Verified with real calls: the allowed command runs; `&&`, `;`, `$()`, `| tee`, other commands, and reads/greps outside are all denied.
- cursor-agent: verified to read files outside its workspace even with `--mode ask` and `--sandbox enabled`. So it is refused for any agent unless security.trustUnconfinedCli. The package default reviewer moved from cursor-main to claude-cheap (it now shares a provider with the coders, which is a warning only).
- API agents: run_command also checks the full command against the allowlist; web_fetch is gone when web is off.
- Secrets:
  - secret files are skipped by the index and the worktree overlay, and shown to the reviewer by name only. This fixes a real leak: a worktree .env used to be sent to the reviewer.
  - redact() is applied to every prompt Sourcerer sends, the coder notes, contract.txt and all run logs.
- Disk: init creates the workspace 0700 and .env 0600. setup fixes looser permissions and doctor warns about them.
- `sourcerer clean --runs [--older-than] --index [--yes]` (dry run by default, never touches worktrees).
- doctor shows the security settings.
- README "Security" section, with the honest limit: running tests runs coder-written code, so only a container/VM isolates.
- Tests: 149 (redaction, patterns, Claude rules, defaults/cursor refusal, API allowlist, secret files for the reviewer and the index, permissions, clean).
- Real-call cost for the checks: about $0.21 (Claude); the Cursor checks ran on the subscription.

## macOS sandbox (done)

- src/core/sandbox.js builds a Seatbelt profile and runs commands as `sandbox-exec -f <profile> <cmd>`.
  - The profile: allow default, deny file read/write under $HOME, allow metadata reads under $HOME (realpath/getcwd need them), then read access to the CLI installs/logins (~/.local/bin, ~/.local/share/claude|cursor-agent, ~/.claude, ~/.claude.json, ~/.cursor, ~/Library/Keychains), ~/.gitconfig, the language toolchains (nvm, volta, asdf, pyenv, go, cargo, pnpm, composer, ...) and the given read paths, and write access to CLI state, package/build caches and the given write paths.
  - Later allow rules override the earlier deny (verified). Child processes inherit the profile.
- Applied to the agent CLIs (runCli: write = worktree + its main repo's .git, read = the other repo + its .git), the API agents' run_command, the orchestrator's test command and the worktree setup command (install scripts are repo code).
- `security.sandbox.enabled: auto` (on where /usr/bin/sandbox-exec exists), `true` (error if unavailable) or `false`. `allowRead` / `allowWrite` add paths. No `security` block means no sandbox.
- With the sandbox on, cursor-agent is no longer refused. Without it, the trustUnconfinedCli rule still applies. The package default reviewer stays claude-cheap, so the default is valid on every platform.
- doctor reports whether the sandbox is on.
- Verified with real calls (worktree under $HOME, a secret elsewhere in $HOME):
  - claude: with its own read limits off, Read got EPERM; git status worked.
  - cursor-agent --force: shell `cat` and its file reader both got "Operation not permitted"; git status worked. Without the sandbox it had read the same file.
  - Before that: Claude's Keychain login needs ~/Library/Keychains, and cursor's launcher needs metadata reads.
- Tests: 153 (profile shape, the on/off rules, and real sandbox-exec runs on macOS: allowed folder, denied home files, child processes, node, git in a worktree).

Limits:
- The network is open, since the CLIs need their API and Seatbelt can't filter by domain.
- CLI logins must stay readable.
- macOS only; Linux (bubblewrap/Landlock) is not done.
- sandbox-exec is deprecated by Apple but still works.

## Agent CLIs leaving processes behind (done)

- A dev server or watcher started by an agent kept the CLI's stdout open, so runCli waited until the timeout after the work was done.
- runCli now kills the CLI's process group as soon as the CLI itself exits. Regression test in test/cli-stream.test.js (a fake claude that leaves `sleep` running).
- Tests and setup commands (configured by the user) still wait for their own stdout; not changed.

## Planner questions (done)

- The planner may answer with `{ "questions": [...] }` (1 to 5) instead of a plan, when it is told someone can answer. The prompt says: ask only if the answer changes the plan; never ask what the repos show or what has an obvious default.
- runTask takes an optional `ask(questions)` hook. Answers ('' = skipped, shown to the planner as "use your judgment") go into a second planner call, which may not ask again. Both calls count toward the budget. Saved, redacted, to runs/<id>/questions.json.
- Without `ask`, the prompt says no one can answer: the planner states its assumptions, and a questions reply fails the run.
- Wired in:
  - `sourcerer run`, only when stdin is a TTY.
  - The session (REPL and TUI): each line answers the current question, Enter skips it, and /stop ends the run. /approve and /reject apply only to budget questions. The TUI banner shows a per-question hint.
- Tests: 157.
- Deferred: coders asking mid-run. `claude -p` can't wait for input, so this would need ending the call and `--resume`, with sessions kept. For now, coders report open decisions in their notes.

## Base branch from the repo (done)

- `repos.<side>.base` is optional and no longer defaults to `main` in the package config.
- When unset, loadConfig detects it (defaultBranch in src/core/config.js):
  - origin/HEAD's branch: the local branch if it exists, else `origin/<name>`;
  - otherwise a local `main` or `master`;
  - otherwise the current branch.
  - It is undefined when the folder isn't a git repo, which doctor already reports.
- An explicit base in sourcerer.yaml still wins. doctor shows the base it uses.
- Tests: 159 (master-only repo, a clone whose origin default is develop, remote-only branch, explicit override).

## TUI scrolling (done)

- The right panel (events or an agent's output) scrolls:
  - PgUp/PgDn move half a page.
  - Home goes to the first line; End goes back to the end and follows new lines again.
  - ↑↓ stay for input history.
- Each view keeps its own position (state `scroll`: first shown line per view; no entry means follow the end). While scrolled up, new lines don't move the view. The header shows how many newer lines are below.
- Kept lines per view: 500 -> 5000.
- Not done:
  - Mouse wheel (needs mouse reporting, which breaks normal text selection).
  - Once a view is past 5000 lines, the oldest lines are dropped, so a scrolled-up view shifts by the lines dropped.
- Tests: 160.

## Coder prompts: scoped verification (done)

- Feedback from a run on a large work repo: a small task took about 1.4M tokens on the coder and ran long, where Cursor used about 100k for the same task. The run's logs were not available here.
- An older local run showed the pattern: 12 of 17 tool calls were checks.
  - Whole-repo lint and build.
  - A throwaway test harness in /tmp.
  - A dev server probed with curl.
- Coder system prompts (agents/coder-*.yaml) and coderPrompt now say:
  - Make the smallest change; read only the files needed, starting from the search results and the contract.
  - Add or update tests for the new behaviour and run just those.
  - No whole-repo test suite, lint or build; no throwaway setups outside the repo; no servers or watchers. The repo's configured test command and the reviewer come after.
  - "Design new code from scratch" became "keep new code modular and clean, but do not restructure existing code the task does not need". The no-bad-practices rule stays.
- Not done yet (from the same analysis):
  - `--effort` per agent (the claude CLI has `--effort low|medium|high|xhigh|max`).
  - A live turn/token limit for CLI agents (maxTurns only applies to the API loop).
  - Resuming the coder's session in fix rounds.

## Benchmark on Gitea, and per-repo commands (done)

Benchmark: Gitea (about 6.4k files, half Go), `--side backend`, task "add GET /api/v1/repos/{owner}/{repo}/branches/count". Coder numbers:

| | new prompts (9701e72) | old prompts (55020e7) | cursor-agent direct (grok-4.7-medium) |
|---|---|---|---|
| rounds | 1 | 2 | 1 |
| tokens, input + output | 69,883 | 126,398 | 133,601 |
| tokens read from cache | 1,080,310 | 1,992,956 | 3,891,968 |
| duration | 153 s | 251 s | 753 s |
| tool calls | 42 | 64 | 124 |

- The Sourcerer coders couldn't run `make fmt` or `make generate-swagger` (not allowlisted). They hand-edited generated swagger files.
  - In the old run, the reviewer asked for a second round because nothing had been run.
  - Cursor (no command limit) ran the integration tests.
- `go test` itself was allowed. Checked with a real claude call: the plain, `-tags '...'` and `-run` forms all pass `Bash(go test *)`. It failed on the bench machine because Go 1.23 was installed with GOTOOLCHAIN=local, while Gitea needs Go 1.27.
- Token counts in Sourcerer (TUI, summary.json) exclude cache reads. Including them, the coder total was 1.1M to 2.1M here.

Change:
- `repos.<side>.commands`: extra command prefixes that side's coder may run.
- `allowedCommands(config, side)` now gives a coder only its own repo's commands and setup/test, plus the global lists. runAgent passes `agent.repo`.
- When the allowlist is on and the coder has run_command, coderPrompt lists the allowed commands. It also says to run each one on its own (no &&, pipes or env prefixes) and to report a missing command instead of working around it.
- Tests: 162.

## Coders don't write tests (done)

- Coder prompts (agents/coder-*.yaml, coderPrompt) now say:
  - Write no new tests and change no test files.
  - Verify by compiling or type-checking, and by running only the existing tests that cover the change.
  - If a test fails, fix the code. If the test itself must change, say so in the answer.
- Reviewer (agents/reviewer.yaml, reviewerPrompt): coders don't write tests by design. Missing tests alone are not a reason for request-changes; mention them under "general" if they matter.
- Known effect: if the repo's test command fails because a test must change, the coder can't fix it. Fix rounds then repeat until review.maxRounds, and the coder notes say why.


## Tool-free reviewer (done)

- Why: on Gitea with grok, the coder took as long as Cursor (327 s vs 326 s). The run took 565 s, partly because the reviewer explored the repo with its tools (169 s).
- Reviewer (agents/reviewer.yaml): `tools: []`, maxTurns 2. It reviews only the prompt (diffs, notes, contract, test result) and comments on what the diff can't show.
  - Checked on a real saved review prompt with claude-cheap: 18 s / $0.09 vs 28 s / $0.11 with tools, same verdict.

## Code quality: coder rules, similar-code hints, reviewer checklist (done)

- From the Gitea comparison: several outputs copied an unneeded `GitRepo == nil` check from ListBranches. Five of six re-implemented `git_model.CountBranches`. One defined `api.BranchCount` and returned an anonymous struct. Two documented only the 200 response.
- Coder prompts: four new rules.
  - Search for and reuse an existing helper.
  - Copy only what is needed from example code.
  - Leave no unused types or functions.
  - Document every response, errors included.
- src/rag/similar.js: finds existing definitions that resemble what the diff adds.
  - It takes the definitions the diff adds (the `definitions()` regexes) and searches the side's BM25 index for each name.
  - It lists definitions in other, non-test files whose name shares at least half the terms: path, line and signature, at most 10 lines.
  - Wired as runTask's optional `similarFor` (run.js, only with rag on, never fails the run). It goes into the reviewer prompt per side and is saved as `<side>.r<round>.similar.txt`.
  - On the real Gitea diffs it returns exactly `models/git/branch.go:555: func CountBranches(...)` in about 1.4 s.
- Reviewer checklist item 5, Maintainability: re-implemented helpers, unused code, copied checks, undocumented error responses.
- Tests: 164. `cancel.test.js` "aborting runCli kills..." failed once under full-suite load, then passed 3 of 3 alone and in a full rerun. It is timing-sensitive; not changed.

