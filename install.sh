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

# 3. Make the `taw` command available
chmod +x "$DIR/bin/taw.mjs"
echo "→ Installing the 'taw' command"
if ( cd "$DIR" && npm install -g . >/dev/null 2>&1 ); then
  echo "  installed globally via npm"
else
  # npm global prefix is often root-owned on Linux — fall back to a user-local symlink (no sudo).
  BIN="$HOME/.local/bin"
  mkdir -p "$BIN"
  ln -sf "$DIR/bin/taw.mjs" "$BIN/taw"
  echo "  npm -g not permitted → linked $BIN/taw"
  case ":$PATH:" in
    *":$BIN:"*) ;;
    *)
      for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
        [ -e "$rc" ] || continue
        grep -q 'taw harness PATH' "$rc" 2>/dev/null || \
          printf '\n# taw harness PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
      done
      echo "  → added ~/.local/bin to PATH. Open a NEW terminal, or run:"
      echo "      export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
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
