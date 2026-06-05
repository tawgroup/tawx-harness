# ▟▙ tawx-harness

A simple coding-agent harness. A model, a short loop, a few local tools — that's it. No Skills, no MCP, no plugins. Zero deps, Node 20+ or Bun.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/tawgroup/tawx-harness/main/install.sh | bash
```

## Setup

```bash
tawx login      # pick provider: opencode / codex / claude
```

## Use

```bash
tawx                                          # interactive TUI
tawx run "write a python fibonacci and run it"
tawx build "todo API in node http" --verify "node --test test.mjs"
tawx models
tawx whoami
```

TUI: `/model <id>` · `/models` · `/yolo` · `/safe` · `/clear` · `/exit` · `Ctrl-C` to interrupt.

## Tools

`read_file` · `write_file` · `edit_file` · `diff` · `apply_patch` · `undo_last_change` · `glob` · `grep` · `list_dir` · `bash`

MIT · [tawgroup](https://github.com/tawgroup)
