// ANSI helpers for the TUI — zero deps.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

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
};

export function banner(model, version) {
  const line = c.dim("─".repeat(48));
  return (
    "\n" +
    c.bold(c.magenta("  ▟▙ tawx")) +
    (version ? c.dim(` v${version}`) : "") +
    c.dim("  · minimal coding agent harness") +
    "\n" +
    line +
    "\n" +
    c.dim("  model: ") + c.cyan(model) +
    c.dim("   ·  /help for commands  ·  /exit to quit") +
    "\n" +
    line +
    "\n"
  );
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
