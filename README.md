# ▟▙ tawx-harness

`tawx-harness` is a tiny coding-agent harness inspired by **PI**. It keeps the same simple spirit: a model, a short agent loop, and a few local tools that can read files, edit files, and run commands.

It intentionally does **not** include Skills, MCP, plugin systems, or other heavy extension layers. The goal is a small harness that is easy to understand, easy to hack, and cheap to run.

> PI is great, but its main limitation for this use case is Claude subscription support. `tawx-harness` keeps the minimal PI-style workflow while staying configurable for subscription/API setups through its OpenAI-compatible provider settings.

## What's inside

- 🔁 Minimal model ↔ tool loop with native function-calling.
- 🛠️ Built-in tools only: `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `list_dir`, `bash`, `todo_write`.
- 📋 Project context from `AGENTS.md`, `CLAUDE.md`, `.taw/context.md`, or `.cursorrules`.
- 💬 Interactive TUI with streaming, spinner, and action approval.
- 🤖 Headless `run` and self-verifying `build --verify` modes.
- 🧩 No Skills. No MCP. No plugin layer.
- 🪶 Zero dependencies. Node 20+ or Bun. No build step.

## Install

One line:

```bash
curl -fsSL https://raw.githubusercontent.com/tawgroup/tawx-harness/main/install.sh | bash
```

Manual:

```bash
git clone https://github.com/tawgroup/tawx-harness && cd tawx-harness
npm install -g .
cp .env.example .env
tawx
```

Login once and choose a provider:

```bash
tawx login      # opencode / codex / claude
tawx whoami
```

`tawx login` saves credentials to `~/.taw/auth.json` (`0600`). You can still override with env:

```bash
TAW_PROVIDER=opencode   # opencode | codex | claude
TAW_API_KEY=sk-...
TAW_MODEL=glm-5
TAW_BASE_URL=https://opencode.ai/zen/go/v1
```

## Use

```bash
tawx
tawx run "write a python fibonacci script and run it"
tawx run "fix the build error in this repo" --model qwen3.6-plus
tawx build "make a todo API in Node http with tests" --verify "node --test test.mjs"
tawx login
tawx whoami
tawx models
```

### TUI commands

`/model <id>` · `/models` · `/yolo` · `/safe` · `/clear` · `/exit`

`Ctrl-C` interrupts the running turn; press again when idle to quit.

## Architecture

```text
bin/taw.mjs      CLI (TUI | run | build | models)
src/agent.mjs    model <-> tool loop
src/provider.mjs OpenAI-compatible chat client
src/tools.mjs    read/write/edit/list/grep/bash/todo tools
src/prompt.mjs   system prompt + project context
src/tui.mjs      terminal UI
```

## Test

```bash
npm test
OPENCODE_API_KEY=sk-... npm test
```

MIT · made by [tawgroup](https://github.com/tawgroup)
