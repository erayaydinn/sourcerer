# Adapter capabilities

| Adapter | Status | Cost source | Tool allowlist | Read-only mode | maxTurns enforced | Prompt via |
|---|---|---|---|---|---|---|
| claude CLI (`-p --verbose --output-format stream-json`, live log) | verified (2.1.302) | reported (`total_cost_usd`) | yes, `--allowedTools` + `--permission-mode dontAsk`; writes scoped to `./**`, read-only dirs via `--add-dir` | yes (only read tools allowed) | no (no flag; timeout only) | stdin |
| cursor-agent CLI (`-p --output-format stream-json`, live log) | verified (2026.04.30) | estimated from reported tokens (pricing.yaml), else unknown | no; agents with run_command get `--force` | yes, `--mode ask` | no | stdin |
| codex CLI | not installed | estimated from tokens (planned) | ? | ? | ? | ? |
| openai-compat API | built, not smoke-tested | estimated (pricing.yaml) | yes (built-in tools) | yes (built-in tools) | yes | n/a |
| anthropic API | built, not smoke-tested | estimated (pricing.yaml) | yes (built-in tools) | yes (built-in tools) | yes | n/a |

cursor-agent has no `--add-dir`: read-only dirs are only named in the prompt and not enforced. On a Plus plan, `--model composer-2.5` is refused, even though Composer is the default model (Composer runs only when `--model` is left out); the Grok ids work.

Our tool names map to Claude Code tools like this: read_file → Read, write_file → Edit(./\*\*) and Write(./\*\*), run_command → Bash, search_code → Grep and Glob, web_search → WebSearch, web_fetch → WebFetch.
Built-in tools for API agents are read_file, write_file, run_command (allowlist, no shell), search_code, find_symbol, search_docs and web_fetch. There is no web_search for them.
The search tools only see what the agent's `rag.scope` allows. Claude CLI agents use their own Grep and Glob instead (find_symbol and search_docs map to Grep); for them, scope is limited only through `--add-dir`.
