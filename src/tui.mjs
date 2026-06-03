// Interactive terminal UI (readline + ANSI). Chat-style, with streaming, tool rendering + approval.
import readline from "node:readline";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createAgent } from "./agent.mjs";
import { c, banner, renderMarkdown, createMdStream } from "./ui.mjs";
import { MODELS, DEFAULT_MODEL, PROVIDER, PROVIDERS, AUTH, AUTH_PATH, saveAuth, VERSION, checkForUpdate, UPDATE_CMD, COMPACT_THRESHOLD } from "./config.mjs";
import { listModels } from "./provider.mjs";
import { saveClipboardImage } from "./clipboard.mjs";
import { loginCodexBrowser, loginCodexDeviceCode } from "./codex-oauth.mjs";

// Live model list for the active provider. Seeded from the hardcoded config list
// (works offline) and refreshed from the provider's GET /models at startup when
// available (see refreshModels in runTui). All model UI reads from here.
let modelList = [...MODELS];

const COMMANDS = ["/help", "/login", "/use", "/model", "/models", "/whoami", "/yolo", "/safe", "/clear", "/exit"];
const COMMAND_DESC = {
  "/help": "show help",
  "/login": "login provider inside TUI",
  "/use": "switch provider/model and restart TUI",
  "/model": "switch model for this TUI session",
  "/models": "list models for active provider",
  "/whoami": "show active provider/model",
  "/yolo": "auto-approve write/edit/bash",
  "/safe": "ask before write/edit/bash",
  "/clear": "clear conversation history",
  "/exit": "quit",
};

function showCommandSuggestions(prefix = "/") {
  const hits = COMMANDS.filter((cmd) => cmd.startsWith(prefix));
  const list = hits.length ? hits : COMMANDS;
  return list.map((cmd) => `  ${c.bold(cmd)} ${c.dim("— " + COMMAND_DESC[cmd])}`).join("\n") + "\n";
}

function showModelSuggestions(prefix = "") {
  const hits = modelList.filter((m) => m.startsWith(prefix));
  const list = hits.length ? hits : modelList;
  return list.map((m) => `  ${c.bold(m)}`).join("\n") + "\n";
}

// Suggestions to draw live under the input as the user types a slash command.
// Each item is { value, label }: `value` is what gets run if picked, `label` is
// the (already-colored) text shown. Returns [] when there's nothing to suggest.
function liveSuggest(line) {
  const s = String(line || "");
  if (!s.startsWith("/")) return [];
  const parts = s.split(/\s+/);
  const head = parts[0];

  if (head === "/login" || head === "/use") {
    const prefix = parts[1] || "";
    return Object.keys(PROVIDERS)
      .filter((p) => p.startsWith(prefix))
      .map((p) => ({ value: `${head} ${p}`, label: `${c.bold(head + " " + p)} ${c.dim("— " + PROVIDERS[p].label)}` }));
  }
  if (head === "/model") {
    const prefix = parts[1] || "";
    return modelList.filter((m) => m.startsWith(prefix)).map((m) => ({ value: `/model ${m}`, label: c.bold(`/model ${m}`) }));
  }
  // Top-level command: only suggest while still typing the command word.
  if (parts.length > 1) return [];
  return COMMANDS.filter((cmd) => cmd.startsWith(head)).map((cmd) => ({
    value: cmd,
    label: `${c.bold(cmd)} ${c.dim("— " + COMMAND_DESC[cmd])}`,
  }));
}

function resolveCommand(raw) {
  const full = raw.startsWith("/") ? raw : `/${raw}`;
  if (COMMANDS.includes(full)) return full.slice(1);
  const hits = COMMANDS.filter((cmd) => cmd.startsWith(full));
  return hits.length === 1 ? hits[0].slice(1) : "";
}

function resolveModel(raw) {
  if (modelList.includes(raw)) return raw;
  const hits = modelList.filter((m) => m.startsWith(raw));
  return hits.length === 1 ? hits[0] : "";
}

function complete(line) {
  const s = String(line || "");
  if (!s.startsWith("/")) return [[], s];

  const parts = s.split(/\s+/);
  if (parts[0] === "/login" || parts[0] === "/use") {
    const prefix = parts[1] || "";
    const hits = Object.keys(PROVIDERS).filter((p) => p.startsWith(prefix)).map((p) => `${parts[0]} ${p}`);
    return [hits.length ? hits : Object.keys(PROVIDERS).map((p) => `${parts[0]} ${p}`), s];
  }
  if (parts[0] === "/model") {
    const prefix = parts[1] || "";
    const hits = modelList.filter((m) => m.startsWith(prefix)).map((m) => `/model ${m}`);
    return [hits.length ? hits : modelList.map((m) => `/model ${m}`), s];
  }

  const hits = COMMANDS.filter((cmd) => cmd.startsWith(s));
  return [hits.length ? hits : COMMANDS, s];
}

function restartTui() {
  process.stdout.write(c.dim("\nrestarting tawx…\n"));
  spawnSync(process.execPath, [process.argv[1]], { stdio: "inherit" });
  process.exit(0);
}

async function tuiLogin(providerName, ask) {
  const names = Object.keys(PROVIDERS);
  let provider = providerName;
  if (!provider) {
    process.stdout.write("  providers:\n" + names.map((p, i) => `    ${i + 1}. ${p} — ${PROVIDERS[p].label}`).join("\n") + "\n");
    const picked = await ask(c.yellow("  provider: "));
    provider = names[Number(picked.trim()) - 1] || picked.trim();
  }
  const cfg = PROVIDERS[provider];
  if (!cfg) { process.stdout.write(c.red(`  unknown provider: ${provider}\n`)); return; }

  const old = AUTH.providers?.[provider] || {};
  const model = (await ask(c.yellow(`  default model [${old.model || cfg.defaultModel}]: `))).trim() || old.model || cfg.defaultModel;
  const baseUrl = cfg.type === "claude-cli"
    ? ""
    : (await ask(c.yellow(`  base URL [${old.baseUrl || cfg.baseUrl}]: `))).trim() || old.baseUrl || cfg.baseUrl;

  const next = { ...AUTH, active: provider, providers: { ...(AUTH.providers || {}) } };
  if (provider === "codex") {
    const method = ((await ask(c.yellow("  codex login method browser/device [browser]: "))).trim() || "browser").toLowerCase();
    const oauth = method === "device" ? await loginCodexDeviceCode() : await loginCodexBrowser({ ask: async (q) => ask(c.yellow("  " + q + ": ")) });
    next.providers[provider] = { model, baseUrl, oauth };
  } else if (cfg.type === "claude-cli") {
    process.stdout.write(c.dim("  using local `claude` command auth; no API key stored. Run `claude` once if not logged in.\n"));
    next.providers[provider] = { model, baseUrl };
  } else {
    const apiKey = (await ask(c.yellow(`  API key ${old.apiKey ? "[keep existing]" : ""}: `))).trim() || old.apiKey || "";
    if (!apiKey) { process.stdout.write(c.red("  missing API key\n")); return; }
    next.providers[provider] = { model, baseUrl, apiKey };
  }
  saveAuth(next);
  process.stdout.write(c.green(`  ✓ logged in: ${provider}\n`) + c.dim(`  saved: ${AUTH_PATH}\n`));
  const r = (await ask(c.yellow("  restart TUI with this provider now? [Y/n] "))).trim().toLowerCase();
  if (r !== "n" && r !== "no") restartTui();
}

async function tuiUse(providerName, modelArg, ask) {
  const provider = providerName || PROVIDER;
  const cfg = PROVIDERS[provider];
  if (!cfg) { process.stdout.write(c.red(`  unknown provider: ${provider}\n`)); return; }
  const old = AUTH.providers?.[provider] || {};
  const model = modelArg || old.model || cfg.defaultModel;
  const next = { ...AUTH, active: provider, providers: { ...(AUTH.providers || {}) } };
  next.providers[provider] = { ...old, model, baseUrl: old.baseUrl || cfg.baseUrl };
  saveAuth(next);
  process.stdout.write(c.green(`  ✓ active provider → ${provider}\n`) + c.dim(`  model → ${model}\n`));
  restartTui();
}

const HELP = `
${c.bold("Commands:")}
  /help            show help
  /login [name]    login provider in TUI: opencode | codex | claude
  /use <name>      switch provider in TUI and restart
  /model <id>      switch model for this TUI session (e.g. /model qwen3.6-plus)
  /models          list models for active provider
  /whoami          show active provider/model
  /yolo            auto-approve every action (default)
  /safe            ask before write/edit/bash
  /clear           clear conversation history
  /exit            quit

  Live suggest     type / and matches show under the input as you type
  ↑/↓              move through the suggestion list (Enter picks the highlighted one)
  Tab / →          accept the highlighted suggestion into the input
  Prefixes work   e.g. /lo = /login, /wh = /whoami when unique
  ↑/↓ (no list)    recall previous inputs
  Ctrl-C           interrupt the running turn (press again when idle to quit)
`;

// Ask the terminal for its size directly (DSR cursor-position report). Needed for
// terminals that don't expose process.stdout.rows until the first resize
// (e.g. VibeTerminal). Must run BEFORE readline takes over stdin.
async function queryTerminalSize() {
  if (!process.stdout.isTTY || !process.stdin.isTTY || !process.stdin.setRawMode) return null;
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = "";
    const done = (val) => {
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      try { stdin.setRawMode(false); } catch { /* ignore */ }
      stdin.pause();
      resolve(val);
    };
    const onData = (d) => {
      buf += d.toString("latin1");
      const m = buf.match(/\x1b\[(\d+);(\d+)R/);
      if (m) done({ rows: Number(m[1]), cols: Number(m[2]) });
    };
    const timer = setTimeout(() => done(null), 400);
    try { stdin.setRawMode(true); } catch { /* ignore */ }
    stdin.resume();
    stdin.on("data", onData);
    // park cursor far bottom-right, report position (= size), then restore
    process.stdout.write("\x1b7\x1b[9999;9999H\x1b[6n\x1b8");
  });
}

export async function runTui({ model = DEFAULT_MODEL } = {}) {
  // Probe the real terminal size before readline grabs stdin — but ONLY when the
  // OS didn't give us one (some terminals report rows=0 until the first resize).
  // Terminals that report size normally skip this and pay no startup latency.
  const probed = process.stdout.rows ? null : await queryTerminalSize();

  // historySize:0 hands ↑/↓ to us — we drive the suggestion dropdown with them
  // (and fall back to our own input history when no dropdown is showing).
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer: complete, historySize: 0 });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  // Refresh the model list from the provider's live /models in the background.
  // Non-blocking: the hardcoded seed is already usable; this just freshens it.
  listModels().then((ids) => { if (ids?.length) modelList = ids; }).catch(() => {});

  // Kick off the update check now so it usually resolves "for free" before the
  // banner/agent setup finishes; we await it (bounded) below before the prompt.
  const updateCheck = checkForUpdate();

  const inputHist = [];   // our own recall list for ↑/↓ when no dropdown is up

  // Main prompt with live, as-you-type slash-command suggestions drawn below the
  // input line, navigable with ↑/↓ and selectable with Enter/Tab. readline's
  // `completer` only fires on Tab; this renders on every keystroke. We draw the
  // block via save/restore-cursor so the input stays put, and wipe it on submit.
  const MAX_SUGGEST = 8;
  const setLine = (text) => { rl.line = text; rl.cursor = text.length; rl._refreshLine?.(); };
  const askMain = (q) =>
    new Promise((resolve) => {
      let items = [];     // current { value, label } suggestions
      let sel = -1;       // highlighted index, -1 = nothing selected (Enter runs typed text)
      let hpos = inputHist.length; // cursor into inputHist for ↑/↓ recall
      let pasting = false;   // inside a bracketed paste (ESC[200~ … ESC[201~)
      let pasteParts = [];   // lines captured while pasting (readline submits each \n)
      let realWrite = null;  // saved process.stdout.write while we mute echo during a paste

      const draw = () => {
        process.stdout.write("\x1b7");      // save cursor (at the input position)
        process.stdout.write("\n\x1b[J");   // drop below input, clear everything beneath
        if (items.length) {
          const rows = items.slice(0, MAX_SUGGEST).map((it, i) =>
            i === sel ? c.magenta("› ") + c.inverse(" " + it.label + " ") : "  " + it.label,
          );
          process.stdout.write(rows.join("\n"));
        }
        process.stdout.write("\x1b8");      // restore cursor back to the input
        drawFooter();                       // \x1b[J above wiped it — repaint
      };

      let pending = false;
      const recompute = () => {
        pending = false;
        const next = liveSuggest(rl.line);
        // keep selection only if the list is unchanged in length, else reset
        if (next.length !== items.length) sel = -1;
        items = next;
        draw();
      };

      const onKey = (_str, key) => {
        if (!key) return;
        const name = key.name;

        // Bracketed paste: terminal wraps pasted text in paste-start/paste-end.
        // readline still fires `line` on every embedded newline, so we mute echo,
        // collect the pieces, and rebuild them into ONE input on paste-end —
        // a multi-line paste must NOT submit until the user hits Enter for real.
        if (name === "paste-start") {
          pasting = true; pasteParts = [];
          realWrite = process.stdout.write.bind(process.stdout);
          process.stdout.write = (chunk, enc, cb) => { const f = typeof enc === "function" ? enc : cb; if (typeof f === "function") f(); return true; };
          return;
        }
        if (name === "paste-end") {
          pasting = false;
          if (realWrite) { process.stdout.write = realWrite; realWrite = null; }
          // join captured lines + the trailing segment still in the buffer;
          // collapse whitespace so it stays one editable line (newlines → space).
          const full = [...pasteParts, rl.line].join(" ").replace(/[ \t]*\n[ \t]*/g, " ").replace(/\s+/g, " ").trim();
          pasteParts = [];
          setLine(full);
          if (!pending) { pending = true; setImmediate(recompute); }
          return;
        }
        if (pasting && (name === "return" || name === "enter")) return; // swallow during paste

        if (name === "return" || name === "enter") return; // handled in onLine

        // Ctrl+V: pull an image out of the clipboard, save it to a temp file, and
        // insert its path at the cursor (terminals can't paste image bytes, so we
        // read the OS clipboard ourselves — same trick pi uses).
        if (key.ctrl && name === "v") {
          const img = saveClipboardImage();
          if (img) {
            rl.write(img + " ");            // insert path at cursor
            if (!pending) { pending = true; setImmediate(recompute); }
          }
          return;
        }

        // ↑/↓ drive the dropdown when it's visible…
        if (items.length && (name === "down" || name === "up")) {
          const n = Math.min(items.length, MAX_SUGGEST);
          if (name === "down") sel = sel + 1 >= n ? 0 : sel + 1;
          else sel = sel - 1 < 0 ? n - 1 : sel - 1;
          draw();
          return;
        }
        // …otherwise ↑/↓ recall our own input history.
        if (!items.length && (name === "up" || name === "down")) {
          if (name === "up" && hpos > 0) hpos--;
          else if (name === "down" && hpos < inputHist.length) hpos++;
          setLine(inputHist[hpos] || "");
          return;
        }
        // Tab / → accepts the highlighted item into the line (then re-suggest).
        if (sel >= 0 && (name === "tab" || name === "right")) {
          setLine(items[sel].value);
          sel = -1;
          if (!pending) { pending = true; setImmediate(recompute); }
          return;
        }
        // any other edit → recompute suggestions (deferred so rl.line is updated)
        if (!pending) { pending = true; setImmediate(recompute); }
      };

      const onLine = (line) => {
        // An embedded newline inside a paste — capture it, don't submit yet.
        if (pasting) { pasteParts.push(line); return; }
        process.stdin.removeListener("keypress", onKey);
        rl.removeListener("line", onLine);
        process.stdout.write("\x1b[J");     // wipe the suggestion block beneath the input
        drawFooter();                       // \x1b[J wiped the footer — repaint
        const picked = sel >= 0 && items[sel] ? items[sel].value : line;
        const trimmed = picked.trim();
        if (trimmed && inputHist[inputHist.length - 1] !== trimmed) inputHist.push(trimmed);
        resolve(picked);
      };

      process.stdin.on("keypress", onKey);
      rl.on("line", onLine);
      rl.setPrompt(q);
      rl.prompt();
    });

  let autoApprove = true;
  let spin = null;
  let turnStart = 0;        // wall-clock of the current model turn
  let mdStream = null;      // streaming markdown renderer for the current assistant message
  let lastTokens = 0;       // total_tokens of the last turn ≈ current context size
  let lastSecs = 0;         // last response time
  let totalCost = 0;        // cumulative cost this session

  // PI-style status bar PINNED to the bottom row via a scroll region (DECSTBM):
  // chat output scrolls in rows 1..rows-1, the last row stays fixed as the footer.
  const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));
  // Prefer the live size; fall back to the size we probed before readline started.
  const probedRows = probed?.rows || 0, probedCols = probed?.cols || 0;
  const getRows = () => process.stdout.rows || probedRows || 0;
  const getCols = () => process.stdout.columns || probedCols || 80;
  const footerOn = () => !!(process.stdout.isTTY && getRows());

  // Build the footer as {plain,col} segments so we can fit it to the width.
  const statusSegs = () => {
    const home = os.homedir();
    let dir = process.cwd();
    if (dir === home) dir = "~"; else if (dir.startsWith(home + "/")) dir = "~" + dir.slice(home.length);
    const segs = [
      { plain: dir, col: c.cyan(dir) },
      { plain: `${agent.model} · ${PROVIDER}`, col: c.dim(`${agent.model} · ${PROVIDER}`) },
      { plain: autoApprove ? "yolo" : "safe", col: autoApprove ? c.yellow("yolo") : c.dim("safe") },
    ];
    if (lastTokens) {
      const pct = Math.round((lastTokens / COMPACT_THRESHOLD) * 100);
      segs.push({ plain: `ctx ${fmtK(lastTokens)}/${fmtK(COMPACT_THRESHOLD)} ${pct}%`,
        col: c.dim(`ctx ${fmtK(lastTokens)}/${fmtK(COMPACT_THRESHOLD)} `) + (pct >= 80 ? c.yellow(`${pct}%`) : c.dim(`${pct}%`)) });
    }
    if (lastSecs) segs.push({ plain: `${lastSecs.toFixed(1)}s`, col: c.dim(`${lastSecs.toFixed(1)}s`) });
    if (totalCost > 0) segs.push({ plain: `$${totalCost.toFixed(3)}`, col: c.dim(`$${totalCost.toFixed(3)}`) });
    return segs;
  };
  const statusLine = (maxCols) => {
    let segs = statusSegs();
    const width = () => segs.reduce((n, s, i) => n + s.plain.length + (i ? 3 : 0), 2);
    if (maxCols) {
      if (width() > maxCols) { const b = segs[0].plain.split("/").pop() || segs[0].plain; segs[0] = { plain: b, col: c.cyan(b) }; }
      while (segs.length > 3 && width() > maxCols) segs.pop();
    }
    return "  " + segs.map((s) => s.col).join(c.dim(" · "));
  };

  const drawFooter = () => {
    if (!footerOn()) return;
    const rows = getRows();
    process.stdout.write(`\x1b7\x1b[${rows};1H\x1b[2K${statusLine(getCols() - 1)}\x1b8`);
  };
  const setupFooter = () => {
    if (!footerOn()) return;
    const rows = getRows();
    process.stdout.write(`\x1b7\x1b[1;${rows - 1}r\x1b8`); // reserve bottom row (keep cursor)
    drawFooter();
  };
  const teardownFooter = () => {
    if (!footerOn()) return;
    const rows = getRows();
    process.stdout.write(`\x1b[r\x1b[${rows};1H\x1b[2K`); // release region + clear footer line
  };
  // Some terminals (e.g. VibeTerminal) report their window size LATE — rows is 0
  // at launch and only set after the first resize. Poll briefly until it's known
  // so the footer shows up without the user having to resize the window.
  let footerReady = false;
  const ensureFooter = (attempt = 0) => {
    if (footerReady) return;
    try { process.stdout._refreshSize?.(); } catch { /* ignore */ } // re-read winsize (no SIGWINCH needed)
    if (footerOn()) { footerReady = true; setupFooter(); return; }
    if (attempt < 40) setTimeout(() => ensureFooter(attempt + 1), 150); // ~6s
  };
  const stopSpin = () => {
    if (spin) { clearInterval(spin); spin = null; process.stdout.write("\r\x1b[2K"); }
  };

  const agent = createAgent({
    model,
    stream: true,
    onEvent(ev) {
      if (ev.type !== "thinking") stopSpin();
      switch (ev.type) {
        case "thinking": {
          turnStart = Date.now();
          const fr = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]; let i = 0;
          spin = setInterval(() => process.stdout.write("\r" + c.magenta(fr[i++ % fr.length]) + c.dim(` ${ev.model} thinking…`) + "  "), 80);
          break;
        }
        case "assistant_delta":
          if (!mdStream) {
            process.stdout.write(c.bold("⏺ "));
            mdStream = createMdStream((s) => process.stdout.write(s));
          }
          mdStream.push(ev.text);
          break;
        case "assistant":
          if (mdStream) { mdStream.end(); mdStream = null; }
          else process.stdout.write(c.bold("⏺ ") + renderMarkdown(ev.text.trim()) + "\n");
          break;
        case "tool_call":
          process.stdout.write(c.green("  ⚒ ") + c.bold(ev.name) + c.dim("  " + String(ev.preview).split("\n")[0].slice(0, 80)) + "\n");
          break;
        case "tool_result": {
          const lines = String(ev.result).split("\n");
          const head = lines.slice(0, 6).map((l) => c.dim("    │ " + l.slice(0, 100))).join("\n");
          process.stdout.write(head + (lines.length > 6 ? c.dim(`\n    └ …(+${lines.length - 6} lines)`) : "") + "\n");
          break;
        }
        case "tool_denied":
          process.stdout.write(c.red("    ✗ denied\n"));
          break;
        case "usage":
          if (ev.usage?.total_tokens) {
            lastTokens = ev.usage.total_tokens;
            lastSecs = turnStart ? (Date.now() - turnStart) / 1000 : 0;
            if (ev.cost != null) totalCost += Number(ev.cost) || 0;
            const secs = lastSecs ? `, ${lastSecs.toFixed(1)}s` : "";
            process.stdout.write(c.gray(`    · ${ev.usage.total_tokens} tok` + (ev.cost != null ? `, cost ${ev.cost}` : "") + secs) + "\n");
            drawFooter();
          }
          break;
        case "max_steps":
          process.stdout.write(c.yellow("  ⚠ reached step limit\n"));
          break;
        case "compact_start":
          process.stdout.write(c.dim(`  ♻ compacting context (~${ev.before} tok)…\n`));
          break;
        case "compact_done":
          process.stdout.write(c.dim(`  ♻ compacted → ~${ev.after} tok\n`));
          break;
      }
    },
    async approve(name, args, preview) {
      if (autoApprove) return true;
      stopSpin();
      const a = (await ask(c.yellow(`  ? run ${c.bold(name)}(${String(preview).slice(0, 60)})? [y/N/a=always] `))).trim().toLowerCase();
      if (a === "a") { autoApprove = true; return true; }
      return a === "y" || a === "yes";
    },
  });
  agent.setModel(model);

  // Ctrl-C: cancel the in-flight turn (like Claude Code). Pressing it when idle exits.
  let aborter = null;
  rl.on("SIGINT", () => {
    if (aborter) {
      aborter.abort();
      stopSpin();
      if (mdStream) { mdStream.end(); mdStream = null; }
      process.stdout.write(c.yellow("\n  ⎋ interrupting…\n"));
    } else {
      teardownFooter();
      process.stdout.write("\x1b[?2004l"); // disable bracketed paste
      rl.close();
      process.stdout.write(c.dim("\nbye 👋\n"));
      process.exit(0);
    }
  });

  process.stdout.write("\x1b[?2004h"); // enable bracketed paste so multi-line pastes don't auto-submit
  process.stdout.write(banner(`${agent.model} · ${PROVIDER} · yolo`, VERSION));

  // Show an update notice (bounded wait so it never lands mid-input and corrupts
  // the prompt line). Silent when up to date / offline.
  const latest = await Promise.race([updateCheck, new Promise((r) => setTimeout(() => r(null), 1500))]);
  if (latest) {
    process.stdout.write(
      c.yellow(`  ⚑ update available: v${VERSION} → v${latest}\n`) + c.dim(`    ${UPDATE_CMD}\n\n`),
    );
  }

  process.stdout.on("resize", () => { footerReady = true; setupFooter(); }); // re-reserve on resize
  process.on("exit", () => { try { teardownFooter(); } catch { /* ignore */ } }); // never leave a reserved row behind
  // Nudge Node to re-read the winsize (pi's trick: SIGWINCH is lost while a
  // terminal sets size late). Then draw — using the size we probed via DSR if
  // the OS winsize is still 0.
  try { if (process.platform !== "win32") process.kill(process.pid, "SIGWINCH"); } catch { /* ignore */ }
  ensureFooter(); // draw now if size is known, else poll until the terminal reports it

  for (;;) {
    drawFooter(); // refresh (mode/cwd may have changed) before prompting
    const input = (await askMain(c.magenta("› "))).trim();
    if (!input) continue;

    // Treat as a slash command only if the first token is a single word — an
    // absolute file path ("/var/folders/…png", e.g. a pasted image) also starts
    // with "/" but must go to the agent, not the command parser.
    if (input.startsWith("/") && !input.slice(1).split(/\s+/)[0].includes("/")) {
      const [cmdRaw, ...rest] = input.slice(1).split(/\s+/);
      const cmd = cmdRaw === "quit" ? "exit" : resolveCommand(cmdRaw);
      if (!cmd) {
        process.stdout.write(c.dim("  suggestions:\n") + showCommandSuggestions(`/${cmdRaw}`));
        continue;
      }
      if (cmd === "exit") break;
      else if (cmd === "help") process.stdout.write(HELP + "\n");
      else if (cmd === "login") await tuiLogin(rest[0], ask);
      else if (cmd === "use") await tuiUse(rest[0], rest[1], ask);
      else if (cmd === "models") {
        const ids = await listModels();
        if (ids?.length) { modelList = ids; process.stdout.write(c.dim(`  ${ids.length} models (live from ${PROVIDER}):\n`)); }
        else process.stdout.write(c.dim("  models (built-in list):\n"));
        process.stdout.write("  " + modelList.join("\n  ") + "\n");
      }
      else if (cmd === "whoami") process.stdout.write(`  provider: ${PROVIDER}\n  model: ${agent.model}\n  note: use \`tawx login\` or \`tawx use\` outside TUI to switch provider persistently\n`);
      else if (cmd === "model") {
        const picked = rest[0] ? resolveModel(rest[0]) : "";
        if (!rest[0]) process.stdout.write(c.dim("  choose a model:\n") + showModelSuggestions());
        else if (!picked) process.stdout.write(c.yellow(`  model not unique/known: ${rest[0]}\n`) + c.dim("  suggestions:\n") + showModelSuggestions(rest[0]));
        else {
          agent.setModel(picked);
          // Persist for the active provider so the choice survives a restart.
          const cur = AUTH.providers?.[PROVIDER] || {};
          AUTH.providers = { ...(AUTH.providers || {}), [PROVIDER]: { ...cur, model: picked, baseUrl: cur.baseUrl || PROVIDERS[PROVIDER]?.baseUrl || "" } };
          AUTH.active = AUTH.active || PROVIDER;
          saveAuth(AUTH);
          process.stdout.write(c.dim(`  model → ${picked} (saved for ${PROVIDER})\n`));
        }
      }
      else if (cmd === "yolo") { autoApprove = true; process.stdout.write(c.yellow("  YOLO: auto-approving every action\n")); }
      else if (cmd === "safe") { autoApprove = false; process.stdout.write(c.dim("  SAFE: ask before write/edit/bash\n")); }
      else if (cmd === "clear") { agent.reset(); process.stdout.write(c.dim("  history cleared\n")); }
      else process.stdout.write(c.dim("  suggestions:\n") + showCommandSuggestions(input));
      continue;
    }

    try {
      aborter = new AbortController();
      await agent.send(input, { signal: aborter.signal });
    } catch (e) {
      stopSpin();
      if (mdStream) { mdStream.end(); mdStream = null; }
      if (aborter?.signal.aborted) process.stdout.write(c.yellow("  ⎋ stopped\n"));
      else process.stdout.write(c.red(`  ✗ ${e.message}\n`));
    } finally {
      aborter = null;
    }
  }
  teardownFooter();
  process.stdout.write("\x1b[?2004l"); // disable bracketed paste
  rl.close();
  process.stdout.write(c.dim("bye 👋\n"));
}
