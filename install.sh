#!/usr/bin/env bash
# taw harness installer. One-liner:
#   curl -fsSL https://raw.githubusercontent.com/tawgroup/taw-harness/main/install.sh | bash
set -euo pipefail

REPO="https://github.com/tawgroup/taw-harness.git"
DIR="${TAW_HOME:-$HOME/.taw-harness}"

echo "▟▙ taw harness installer"

# 1. Node check (>= 20)
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Install Node >= 20 first (https://nodejs.org)." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node >= 20 required (found $(node -v))." >&2
  exit 1
fi

# 2. Clone or update
if [ -d "$DIR/.git" ]; then
  echo "→ Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "→ Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

# 3. Global install (creates the `taw` command)
echo "→ Installing the global 'taw' command"
if ! ( cd "$DIR" && npm install -g . >/dev/null 2>&1 ); then
  echo "  npm -g failed (permissions?). Trying 'npm link'…"
  ( cd "$DIR" && npm link ) || \
    echo "  Could not install globally. Run directly: node $DIR/bin/taw.mjs" >&2
fi

# 4. Env / key
mkdir -p "$HOME/.taw" && chmod 700 "$HOME/.taw"
if [ ! -f "$HOME/.taw/.env" ]; then
  printf 'OPENCODE_API_KEY=\nTAW_MODEL=glm-5\n' > "$HOME/.taw/.env"
  chmod 600 "$HOME/.taw/.env"
  echo "→ Created ~/.taw/.env — add your OpenCode Go key:  OPENCODE_API_KEY=sk-..."
fi

echo ""
echo "✓ Done. Try:  taw --help    (or just: taw)"
echo "  Get a key: https://opencode.ai → workspace → API Keys"
