# ▟▙ tawx

A tiny **from-scratch coding agent harness** — Claude Code style, but running on **OpenCode Go** (cheap coding models: GLM, DeepSeek, Qwen, Kimi, MiniMax…). Hand-written tool-use loop, **zero dependencies**, runs directly on **Node 20+** or **Bun**, no build step.

> Philosophy: a "dirt-cheap" model + a small harness = you can still ship code. No Claude Code needed, no expensive API needed.

## What's inside
- 🔁 **Agent loop** that calls tools until the task is done (native function-calling).
- 🛠️ **Tools**: `read_file` (with offset/limit), `write_file`, `edit_file`, `glob`, `grep` (include-glob + context), `list_dir`, `bash`, `todo_write` (task checklist).
- 📋 **Project context**: auto-loads `AGENTS.md` / `CLAUDE.md` / `.taw/context.md` from the repo into the system prompt — the agent follows your conventions without being told each turn.
- 🧩 **Skills**: Markdown files loaded on demand (like Claude Code skills). Put them in `skills/`, or `.taw/skills/` (project), or `~/.taw/skills/` (user).
- 💬 Interactive **TUI** (color, spinner, action approval) + **headless** mode for CI/auto-build.
- ♻️ **Self-verify build** (`tawx build --verify`): build → run a verify command → auto-fix → repeat until it passes.
- 💸 Runs on the **$10/month OpenCode Go plan** (endpoint `zen/go/v1`, `cost: 0`).

## Install

One line (clones to `~/.taw-harness`, installs the global `tawx` command, seeds `~/.taw/.env`):
```bash
curl -fsSL https://raw.githubusercontent.com/tawgroup/taw-harness/main/install.sh | bash
```

Or manually:
```bash
git clone https://github.com/tawgroup/taw-harness && cd taw-harness
npm install -g .              # global `tawx` command (package exposes the bin)
cp .env.example .env          # then fill in OPENCODE_API_KEY (Go plan key)
tawx                          # open the TUI
```

Then put your key in `~/.taw/.env` (`OPENCODE_API_KEY=sk-...`). Requires: Node ≥ 20 (or Bun). Get a Go plan key at https://opencode.ai → workspace → **API Keys**.

The interactive TUI **streams** replies token-by-token and renders Markdown; it shows the active skill and per-step timing. Headless `run`/`build` output stays plain (pipe-safe).

## Use
```bash
tawx                                         # interactive TUI (chat)
tawx run "write a python fibonacci script and run it"   # headless
tawx run "fix the build error in this repo" --model qwen3.6-plus
tawx build "make a todo API in Node http with tests" --verify "node --test test.mjs"
tawx models                                  # list Go plan models
```

### TUI commands
`/model <id>` · `/models` · `/yolo` (auto-approve) · `/safe` · `/skills` · `/clear` · `/exit`
`Ctrl-C` interrupts the running turn (press again when idle to quit).

## Go plan models
`glm-5.1` `glm-5` · `deepseek-v4-pro` `deepseek-v4-flash` · `qwen3.7-max` `qwen3.6-plus` `qwen3.5-plus` · `kimi-k2.6` `kimi-k2.5` · `minimax-m2.7` `minimax-m2.5` · `mimo-v2.5-pro` `mimo-v2.5`

All support tool-calling. Default is **`glm-5`** — reliable for the multi-step agent loop (stable multi-turn tool use). `kimi-k2.5` is fast + non-reasoning, good for **one-shot gen** (a single file) but **breaks on multi-turn** on the Go endpoint ("Provider returned error" after a few tool-results) → don't use it for multi-step tasks. Reasoning models (`glm`/`deepseek`/`minimax`) need a higher `TAW_MAX_TOKENS` when generating large files.

> ⚠️ Go plan throughput varies (17–47 tok/s); large files can take a few minutes. The harness has a request-timeout (`TAW_REQUEST_TIMEOUT`, default 180s) so it won't hang. Very large files (>15k chars) are best generated across several steps instead of one `write_file`.

## MCP (use external tool servers)
tawx is an **MCP client**: drop a config at `~/.taw/mcp.json` (or `<project>/.taw/mcp.json`) and it connects to those servers on the first turn and exposes their tools to the model. Supports **stdio** servers (spawned) and **Streamable-HTTP** servers (Bearer token in `headers`). No config = zero overhead. See `mcp.example.json`.
```json
{ "mcpServers": {
  "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest", "--headless"] }
} }
```
Verified: with the config above, `tawx run "open example.com and report document.title"` loads 23 browser tools and drives a real browser → "Example Domain". MCP tools need approval like write/bash (auto-approved in headless `run`/`build`).

> Note on remote/OAuth servers: a static Bearer token works but does not auto-refresh — re-paste when it expires. (The hosted shipkit MCP, for instance, is not reachable with a plain platform token; it needs its own OAuth flow.)

## Write a new skill
Create `skills/<name>.md`:
```md
---
name: skill-name
description: one-line summary (shown in the index so the model decides when to load it)
---
Detailed step-by-step instructions...
```

Bundled skills: `fullstack`, `frontend`, `api-design`, `database`, `testing`, `refactor`, `debug`, `python`, `docker`, `security`, `perf`, `docs`, `git-commit`, `git-pr`, `scaffold-node`.

## Test
```bash
npm test            # offline (tools + skills) always runs
OPENCODE_API_KEY=sk-... npm test   # also runs the live end-to-end call to the Go plan
```

## Architecture
```
bin/taw.mjs      CLI (TUI | run | build | models)
src/agent.mjs    model<->tool loop
src/provider.mjs OpenCode Go client (zen/go/v1, OpenAI-compatible)
src/tools.mjs    read/write/edit/list/grep/bash
src/skills.mjs   markdown skill loader
src/prompt.mjs   system prompt
src/tui.mjs      terminal UI
skills/          bundled skills
```

MIT · made by [tawgroup](https://github.com/tawgroup)
