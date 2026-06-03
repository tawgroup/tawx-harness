// ANSI helpers for the TUI — zero deps.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
const tc = (r, g, b) => (s) => (useColor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  // ---- semantic roles (truecolor; degrade to plain when NO_COLOR) ----
  accent: tc(167, 139, 250),  // lavender — brand, prompt, active
  brand: tc(180, 160, 255),
  soft: tc(125, 211, 252),    // soft cyan — assistant accents
  amber: tc(245, 176, 84),    // warning/attention — YOLO
  ok: tc(110, 215, 160),      // success/user
  text: tc(228, 230, 240),    // near-white primary
  muted: tc(132, 134, 158),   // secondary
  faint: tc(92, 94, 116),     // tertiary / separators
};

// Visible length of a string, ignoring ANSI escape sequences.
export const visLen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").length;

// Lay out a left and right segment on one line padded to `cols` wide.
function justify(left, right, cols) {
  const gap = Math.max(1, cols - visLen(left) - visLen(right));
  return left + " ".repeat(gap) + right;
}

// Compact two-line header + a thin subtle rule.
export function banner({ version = "", cwd = "", session = "", cols = 80 } = {}) {
  const w = Math.min(cols || 80, 120);
  const logo = "  " + c.bold(c.brand("◢◣ tawx")) + (version ? "  " + c.faint("v" + version) : "");
  const right = (cwd ? c.muted(cwd) : "") + (session ? c.faint(`  ·  ${session}`) : "");
  const rule = "  " + c.faint("─".repeat(Math.max(0, w - 4)));
  return "\n" + justify(logo, right + "  ", w) + "\n" + rule + "\n";
}

// ---- Markdown → ANSI (zero-dep): headings, bold, italic, inline code, bullets, fences, links ----
function renderInline(s) {
  s = s.replace(/`([^`]+)`/g, (_, t) => c.cyan(t));
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t) => c.bold(t));
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, a, t) => a + c.italic(t));
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, (_, a, t) => a + c.italic(t));
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => c.underline(c.blue(t)) + c.dim(` (${u})`));
  return s;
}

// A stateful per-line renderer (carries fenced-code-block state across lines).
// Returns a function(line) -> rendered string, or null for lines to drop (fence markers).
function lineRenderer() {
  let inFence = false;
  return (line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return null; }
    if (inFence) return c.dim("  │ ") + c.cyan(line);
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) return c.bold(c.yellow(h[2]));
    line = line.replace(/^(\s*)[-*]\s+/, (_, sp) => sp + c.yellow("• "));
    return renderInline(line);
  };
}

export function renderMarkdown(text) {
  const render = lineRenderer();
  const out = [];
  for (const line of String(text).split("\n")) {
    const r = render(line);
    if (r !== null) out.push(r);
  }
  return out.join("\n");
}

// Streaming Markdown: push() text chunks; complete lines are rendered + written immediately,
// the partial last line is held until the next newline or end().
export function createMdStream(write) {
  const render = lineRenderer();
  let buf = "";
  return {
    push(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const r = render(line);
        if (r !== null) write(r + "\n");
      }
    },
    end() {
      if (buf.length) {
        const r = render(buf);
        if (r !== null) write(r + "\n");
      }
      buf = "";
    },
  };
}

// a tiny spinner that runs while an async fn is pending
export async function withSpinner(label, fn) {
  if (!process.stdout.isTTY) return fn();
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write("\r" + c.magenta(frames[i++ % frames.length]) + " " + c.dim(label) + "  ");
  }, 80);
  try {
    return await fn();
  } finally {
    clearInterval(t);
    process.stdout.write("\r\x1b[2K"); // clear line
  }
}
