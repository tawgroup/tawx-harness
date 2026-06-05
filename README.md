# ▟▙ tawx-harness

A simple coding-agent harness. A model, a short loop, a few local tools — that's it. No Skills, no MCP, no plugins. Zero deps, Node 20+ or Bun.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/tawgroup/tawx-harness/main/install.sh | bash
```

## Setup

```bash
tawx login      # or: tx login — pick provider: opencode / codex / claude
```

## Use

Open the interactive TUI:

```bash
tawx            # or: tx
```

Useful TUI commands:

```text
/model <id>   switch model
/models       list models
/yolo         auto-approve tool use
/safe         ask before risky tools
/clear        clear conversation
/exit         quit
Ctrl-C        interrupt
```

Other helpers: `tawx models` / `tx models` · `tawx whoami` / `tx whoami`

## Tools

`read_file` · `write_file` · `edit_file` · `diff` · `apply_patch` · `undo_last_change` · `glob` · `grep` · `list_dir` · `web_fetch` · `bash`

MIT · [tawgroup](https://github.com/tawgroup)
