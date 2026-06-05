// Interactive terminal UI (readline + ANSI). Chat-style, with streaming, tool rendering + approval.
import readline from "node:readline";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createAgent } from "./agent.mjs";
import { c, banner, renderMarkdown, createMdStream, bgLine, BG, visLen } from "./ui.mjs";
import { MODELS, DEFAULT_MODEL, PROVIDER, PROVIDERS, AUTH, AUTH_PATH, saveAuth, VERSION, checkForUpdate, UPDATE_CMD, contextWindowFor, TAW_DIR, listSessions, loadSession } from "./config.mjs";
import { listModels } from "./provider.mjs";
import { saveClipboardImage } from "./clipboard.mjs";
import { loginCodexBrowser, loginCodexDeviceCode } from "./codex-oauth.mjs";

// Live model list for the active provider. Seeded from the hardcoded config list
// (works offline) and refreshed from the provider's GET /models at startup when
// available (see refreshModels in runTui). All model UI reads from here.
let modelList = [...MODELS];

const COMMANDS = ["/help", "/tree", "/resume", "/login", "/use", "/model", "/models", "/whoami", "/yolo", "/safe", "/clear", "/exit"];
const COMMAND_DESC = {
  "/help": "show help",
  "/tree": "browse the conversation timeline — jump back to any You/tawx point & branch",
  "/resume": "reopen a saved conversation and keep chatting",
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
  process.stdout.write("\x1b[r"); // release any scroll region before handing the terminal to the child
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
  /tree            jump back to / branch from an earlier turn (clean context)
  /resume          pick a saved conversation to reopen and continue
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

export async function runTui({ model = DEFAULT_MODEL, resume = null } = {}) {
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
      let pastePrefix = "";  // text already in the buffer when the paste started
      const pasteStore = new Map(); // id -> full pasted text (kept out of the visible line)
      let pasteSeq = 0;

      // Render the suggestion + footer chrome on every keystroke.
      //  - LAYOUT mode: the composer is pinned to a fixed bottom row. readline has
      //    already redrawn the input line (and wiped the footer below it via its
      //    clearScreenDown), so we repaint the one-line hint + footer at their
      //    fixed rows, then re-anchor the cursor back onto the composer.
      //  - FALLBACK mode: old content-flow behaviour — dropdown + footer drawn
      //    just below the input via save/restore-cursor.
      const draw = () => {
        if (layoutOn) {
          drawHint(items, sel);
          drawFooter();
          process.stdout.write(at(COMPOSER_ROW(), COMPOSER_PROMPT_W + (rl.cursor || 0) + 1));
          return;
        }
        process.stdout.write("\x1b7");      // save cursor (at the input position)
        process.stdout.write("\n\x1b[J");   // drop below input, clear everything beneath
        const out = [];
        if (items.length) {
          out.push(...items.slice(0, MAX_SUGGEST).map((it, i) =>
            i === sel ? c.accent("❯ ") + c.inverse(" " + it.label + " ") : "  " + it.label));
        }
        out.push(statusLine((process.stdout.columns || 80) - 1)); // footer, always last
        process.stdout.write(out.join("\n"));
        process.stdout.write("\x1b8");      // restore cursor back to the input
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
          pasting = true; pasteParts = []; pastePrefix = rl.line;
          realWrite = process.stdout.write.bind(process.stdout);
          process.stdout.write = (chunk, enc, cb) => { const f = typeof enc === "function" ? enc : cb; if (typeof f === "function") f(); return true; };
          return;
        }
        if (name === "paste-end") {
          pasting = false;
          if (realWrite) { process.stdout.write = realWrite; realWrite = null; }
          // The buffer now holds: pastePrefix + last paste segment. Earlier segments
          // are in pasteParts. Reconstruct the pasted blob (newlines preserved).
          let tail = rl.line;
          if (pastePrefix && tail.startsWith(pastePrefix)) tail = tail.slice(pastePrefix.length);
          const blob = [...pasteParts, tail].join("\n").trim();
          pasteParts = [];
          // Big / multi-line paste → keep it OUT of the visible line; show a chip.
          // The real text is restored on submit (see onLine). Short paste stays inline.
          if (blob.length > 200 || blob.includes("\n")) {
            const id = ++pasteSeq;
            pasteStore.set(id, blob);
            setLine(pastePrefix + `[pasted ${blob.length} chars #${id}] `);
          } else {
            setLine(pastePrefix + blob + " ");
          }
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
        // The strip highlights the first item by default (sel === -1), so Tab/→
        // accept that one too — matching what the user sees as selected.
        if (items.length && (name === "tab" || name === "right")) {
          setLine(items[sel >= 0 ? sel : 0].value);
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
        if (layoutOn) {
          // Clear the composer + hint rows, then drop the cursor back to the
          // transcript continue-point we saved on entry so output flows in-region.
          process.stdout.write(at(HINT_ROW()) + "\x1b[2K" + at(COMPOSER_ROW()) + "\x1b[2K");
          process.stdout.write("\x1b8");
        } else {
          process.stdout.write("\x1b[J");   // wipe the suggestion+footer block beneath the input
        }
        let picked = sel >= 0 && items[sel] ? items[sel].value : line;
        // Expand any [pasted N chars #id] chips back into the real pasted text.
        picked = picked.replace(/\[pasted \d+ chars #(\d+)\]/g, (m, id) => pasteStore.get(Number(id)) ?? m);
        const trimmed = picked.trim();
        if (trimmed && inputHist[inputHist.length - 1] !== trimmed) inputHist.push(trimmed);
        resolve(picked);
      };

      process.stdin.on("keypress", onKey);
      rl.on("line", onLine);
      if (layoutOn) {
        // Pin the composer to its fixed row: save the transcript continue-point,
        // move down to the composer row, and let readline render there.
        process.stdout.write("\x1b7" + at(COMPOSER_ROW()) + "\x1b[2K");
        rl.setPrompt(COMPOSER_PROMPT);
      } else {
        rl.setPrompt(q);
      }
      rl.prompt();
      draw(); // show the footer immediately, under the fresh (empty) prompt
    });

  let autoApprove = true;
  let spin = null;
  let turnStart = 0;        // wall-clock of the current model turn
  let mdStream = null;      // streaming markdown renderer for the current assistant message
  let lastTokens = 0;       // total_tokens of the last turn ≈ current context size
  let lastSecs = 0;         // last response time
  let totalCost = 0;        // cumulative cost this session

  // PI-style status footer drawn right under the input (see draw() in askMain).
  const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n));

  // Build the footer as {plain,col} segments so we can fit it to the width.
  const statusSegs = () => {
    const home = os.homedir();
    let dir = process.cwd();
    if (dir === home) dir = "~"; else if (dir.startsWith(home + "/")) dir = "~" + dir.slice(home.length);
    const sid = `#${sessionId.slice(-4)}`; // conversation id (matches the header + the ~/.taw/sessions filename tail)
    const segs = [
      { plain: dir, col: c.accent(dir) },
      { plain: sid, col: c.muted(sid) },
      { plain: agent.model, col: c.soft(agent.model) },
      { plain: PROVIDER, col: c.muted(PROVIDER) },
      { plain: autoApprove ? "YOLO" : "safe", col: autoApprove ? c.amber("YOLO") : c.muted("safe") },
    ];
    if (lastTokens) {
      const win = contextWindowFor(agent.model);
      const pct = Math.round((lastTokens / win) * 100);
      segs.push({ plain: `ctx ${fmtK(lastTokens)}/${fmtK(win)} ${pct}%`,
        col: c.muted(`ctx ${fmtK(lastTokens)}/${fmtK(win)} `) + (pct >= 80 ? c.amber(`${pct}%`) : c.muted(`${pct}%`)) });
    }
    if (lastSecs) segs.push({ plain: `${lastSecs.toFixed(1)}s`, col: c.muted(`${lastSecs.toFixed(1)}s`) });
    if (totalCost > 0) segs.push({ plain: `$${totalCost.toFixed(3)}`, col: c.muted(`$${totalCost.toFixed(3)}`) });
    segs.push({ plain: "/help", col: c.faint("/help") });
    return segs;
  };
  const statusLine = (maxCols) => {
    let segs = statusSegs();
    const width = () => segs.reduce((n, s, i) => n + s.plain.length + (i ? 3 : 0), 2);
    if (maxCols) {
      if (width() > maxCols) { const b = segs[0].plain.split("/").pop() || segs[0].plain; segs[0] = { plain: b, col: c.accent(b) }; }
      while (segs.length > 3 && width() > maxCols) segs.pop();
    }
    return "  " + segs.map((s) => s.col).join(c.faint(" · "));
  };

  const stopSpin = () => {
    if (spin) { clearInterval(spin); spin = null; process.stdout.write("\r\x1b[2K"); }
  };

  // Writer that indents every line of streamed assistant output by 2 spaces, so
  // the answer reads as an indented block under the "◆ tawx" label.
  const indentWriter = () => {
    let atStart = true;
    return (s) => {
      let out = "";
      for (const ch of s) {
        if (atStart) { out += "  "; atStart = false; }
        out += ch;
        if (ch === "\n") atStart = true;
      }
      process.stdout.write(out);
    };
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
          spin = setInterval(() => process.stdout.write("\r  " + c.accent(fr[i++ % fr.length]) + c.muted(` ${ev.model} thinking…`) + "  "), 80);
          break;
        }
        case "assistant_delta":
          if (!mdStream) {
            process.stdout.write("\n  " + c.soft("◆") + " " + c.bold(c.soft("tawx")) + "\n");
            mdStream = createMdStream(indentWriter());
          }
          mdStream.push(ev.text);
          break;
        case "assistant":
          if (mdStream) { mdStream.end(); mdStream = null; }
          else if (ev.text?.trim()) {
            const body = renderMarkdown(ev.text.trim()).replace(/\n/g, "\n  ");
            process.stdout.write("\n  " + c.soft("◆") + " " + c.bold(c.soft("tawx")) + "\n  " + body + "\n");
          }
          break;
        case "tool_call": {
          // pi-style card header: a soft accent bar + the tool name, on a card bg.
          const w = panelW();
          const prev = String(ev.preview).split("\n")[0].slice(0, w - visLen(ev.name) - 8);
          process.stdout.write(PANEL_PAD + bgLine(" " + c.soft("▌") + " " + c.bold(c.soft(ev.name)) + c.faint("  " + prev), w, BG.card) + "\n");
          break;
        }
        case "tool_result": {
          // Result body inside the same card: a faint left rail per line, bg-filled.
          const w = panelW();
          const lines = String(ev.result).split("\n");
          for (const l of lines.slice(0, 6)) {
            process.stdout.write(PANEL_PAD + bgLine(" " + c.faint("▎") + " " + c.muted(l.slice(0, w - 4)), w, BG.card) + "\n");
          }
          if (lines.length > 6) process.stdout.write(PANEL_PAD + bgLine(" " + c.faint("▎ … +" + (lines.length - 6) + " lines"), w, BG.card) + "\n");
          break;
        }
        case "tool_denied":
          process.stdout.write(PANEL_PAD + bgLine(" " + c.red("▌ ✗ denied"), panelW(), BG.card) + "\n");
          break;
        case "usage":
          if (ev.usage?.total_tokens) {
            lastTokens = ev.usage.total_tokens;
            lastSecs = turnStart ? (Date.now() - turnStart) / 1000 : 0;
            if (ev.cost != null) totalCost += Number(ev.cost) || 0;
            // metadata lives in the sticky footer — refresh it around the live cursor.
            if (layoutOn) { process.stdout.write("\x1b7"); drawFooter(); process.stdout.write("\x1b8"); }
          }
          break;
        case "max_steps":
          process.stdout.write("  " + c.amber("⚠ reached step limit") + "\n");
          break;
        case "compact_start":
          process.stdout.write("  " + c.faint(`♻ compacting context (~${ev.before} tok)…`) + "\n");
          break;
        case "compact_done":
          process.stdout.write("  " + c.faint(`♻ compacted → ~${ev.after} tok`) + "\n");
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

  // Session log: each run gets an id and is saved to ~/.taw/sessions/<id>.json so
  // you can review it later (see `tawx sessions`). Updated after every turn.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "").replace(/-/g, "");
  // let, not const: /resume (and `tawx resume`) repoint these at the reopened
  // session so continued turns append back to its original file.
  let sessionId = `${stamp}-${Math.floor(Math.random() * 1e4).toString().padStart(4, "0")}`;
  const SESS_DIR = path.join(TAW_DIR, "sessions");
  let sessionFile = path.join(SESS_DIR, `${sessionId}.json`);
  let startedAt = new Date().toISOString();
  // Drop heavy base64 image data when persisting (keep a marker so the log is readable + small).
  const sanitize = (msgs) => msgs.map((m) => {
    if (!Array.isArray(m.content)) return m;
    return { ...m, content: m.content.map((p) => (p.type === "image" ? { type: "image", mime: p.mime, bytes: (p.data || "").length } : p)) };
  });
  const saveSession = () => {
    try {
      fs.mkdirSync(SESS_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(sessionFile, JSON.stringify({
        id: sessionId, started: startedAt, updated: new Date().toISOString(),
        model: agent.model, provider: PROVIDER, cwd: process.cwd(),
        messages: sanitize(agent.messages),
      }, null, 2));
    } catch { /* never block the session on a save error */ }
  };

  // Reprint the top banner (used at startup and when re-rendering after a rewind).
  const printBanner = () => {
    const home = os.homedir();
    let proj = process.cwd();
    if (proj === home) proj = "~"; else if (proj.startsWith(home + "/")) proj = "~" + proj.slice(home.length);
    process.stdout.write(banner({ version: VERSION, cwd: proj, session: `session ${sessionId.slice(-4)}`, cols: process.stdout.columns || 80 }));
  };

  // Pull human-readable text out of a message's content (string OR multimodal array).
  const textOf = (content) => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((p) => (p.type === "text" ? p.text : p.type === "image" ? "[image]" : "")).filter(Boolean).join(" ");
    return "";
  };

  // ---- Fixed-viewport layout (pi-style chrome) ---------------------------
  // The transcript scrolls inside a top region; the composer + status footer are
  // pinned to the bottom rows as persistent chrome OUTSIDE that region, so they
  // never float into the middle of a short chat. The bottom CHROME_H rows are,
  // top→bottom: a divider, a one-line suggestion strip, the composer input, and
  // the status footer. Everything degrades to the old content-flow rendering when
  // stdout isn't a TTY or the terminal is too small to host the chrome.
  const CHROME_H = 4;
  const bigEnough = () => (process.stdout.rows || 0) >= 12 && (process.stdout.columns || 0) >= 40;
  // Inline REPL model (like pi): the prompt is just the last line of a normally
  // scrolling transcript, NOT a composer docked in a fixed scroll region. Each
  // submitted "❯ …" line stays in history with the reply right below it. The
  // old fixed-viewport chrome stays guarded behind layoutOn (off) for reference.
  let layoutOn = false;
  const ROWS = () => process.stdout.rows || 24;
  const COLS = () => process.stdout.columns || 80;
  const REGION_BOTTOM = () => Math.max(2, ROWS() - CHROME_H);
  const DIVIDER_ROW = () => ROWS() - 3;
  const HINT_ROW = () => ROWS() - 2;
  const COMPOSER_ROW = () => ROWS() - 1;
  const FOOTER_ROW = () => ROWS();
  const at = (row, col = 1) => `\x1b[${row};${col}H`;

  // pi-style tool "card": a 2-col left margin (outside the panel) + a bg-filled
  // panel up to a comfortable width. Read in the tool_call/tool_result handlers.
  const PANEL_PAD = "  ";
  const panelW = () => Math.max(20, Math.min(COLS() - 4, 96));

  // An accent gutter + chevron marks the composer as the active input surface —
  // the "highlight" the redesign asks for, without fighting readline over a
  // full-row background. COMPOSER_PROMPT_W is its visible width (for cursor math).
  const COMPOSER_PROMPT = c.accent("▌ ❯ ");
  const COMPOSER_PROMPT_W = 4;

  const setRegion = () => { if (layoutOn) process.stdout.write(`\x1b[1;${REGION_BOTTOM()}r`); };
  const resetRegion = () => process.stdout.write("\x1b[r"); // back to full-screen scrolling

  // Truncate a string to `w` visible columns, preserving ANSI colour escapes.
  const truncVisible = (s, w) => {
    let out = "", vis = 0, i = 0;
    while (i < s.length && vis < w) {
      if (s[i] === "\x1b") { const m = s.slice(i).match(/^\x1b\[[0-9;]*m/); if (m) { out += m[0]; i += m[0].length; continue; } }
      out += s[i]; vis++; i++;
    }
    return out;
  };

  const drawDivider = () => process.stdout.write(at(DIVIDER_ROW()) + "\x1b[2K" + c.faint("─".repeat(COLS())));
  const drawFooter = () => process.stdout.write(at(FOOTER_ROW()) + "\x1b[2K" + bgLine(statusLine(COLS() - 1), COLS(), BG.bar));
  // One-line suggestion strip (replaces the old multi-row dropdown — only one
  // chrome row is reserved). Highlights the active item; blank when none.
  const drawHint = (items = [], sel = -1) => {
    let s = "";
    if (items.length) {
      const i = sel >= 0 ? sel : 0;
      const list = items.slice(0, 6).map((it, k) => (k === i ? c.inverse(" " + it.value + " ") : c.dim(it.value))).join("  ");
      s = truncVisible("  " + list + c.faint("   ↑↓ · → accept"), COLS() - 1);
    }
    process.stdout.write(at(HINT_ROW()) + "\x1b[2K" + s);
  };
  const drawComposerIdle = () => process.stdout.write(at(COMPOSER_ROW()) + "\x1b[2K" + c.faint("▌ ") + c.faint("type to chat · / for commands"));
  // Repaint the whole bottom chrome around the LIVE cursor (used when idle / during
  // output). Save+restore keeps the transcript continue-point untouched.
  const drawChromeIdle = () => {
    if (!layoutOn) return;
    process.stdout.write("\x1b7");
    drawDivider(); drawHint([], -1); drawComposerIdle(); drawFooter();
    process.stdout.write("\x1b8");
  };

  // ---- Conversation tree (pi-style branching) ----
  // Each TURN contributes two nodes so /tree shows both sides of the dialogue and
  // you can rewind to either: a "user" node (context up to & incl. your prompt —
  // rewinding here re-asks from your prompt) and a "tawx" node (full context after
  // the reply). A node carries a snapshot of the live context at that point +
  // parentId. Jumping rewinds the live context AND re-renders the chat view so the
  // screen reflects the rewound timeline; the abandoned turns stay as sibling
  // branches you can jump back to.
  const tree = [];           // { id, parentId, role, snapshot, title, ts }
  let leafId = null;         // current position in the tree
  let nodeSeq = 0;
  const addNode = (role, title, snapshot) => {
    const node = { id: (++nodeSeq).toString(36), parentId: leafId, role, snapshot, title: (title || "").replace(/\s+/g, " ").trim().slice(0, 72) || (role === "user" ? "(empty)" : "(no text reply)"), ts: Date.now() };
    tree.push(node);
    leafId = node.id;
  };
  const recordTurn = (userText) => {
    const msgs = agent.messages;
    // This turn's user message = the last user message in the live context.
    let userIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === "user") { userIdx = i; break; } }
    if (userIdx === -1) return;
    // user node: context up to & including the prompt (assistant reply excluded).
    addNode("user", userText, msgs.slice(0, userIdx + 1));
    // tawx node: full context after the reply. Title = last assistant text.
    let lastAsst = null;
    for (let i = msgs.length - 1; i > userIdx; i--) { if (msgs[i].role === "assistant") { lastAsst = msgs[i]; break; } }
    addNode("assistant", textOf(lastAsst?.content), [...msgs]);
  };
  // Flatten the tree depth-first. A linear chain stays flat; we only indent at
  // genuine branch points (a parent with >1 child) so single-path history reads
  // as a simple list, and branches show ├─ / └─ connectors.
  const flattenTree = () => {
    const kids = new Map();
    for (const n of tree) { const k = n.parentId ?? "ROOT"; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(n); }
    const rows = [];
    const walk = (key, depth) => {
      const arr = kids.get(key) || [];
      const branch = arr.length > 1;
      arr.forEach((n, i) => {
        rows.push({ id: n.id, role: n.role, label: n.title, depth, branch, isLast: i === arr.length - 1 });
        walk(n.id, depth + (branch ? 1 : 0));
      });
    };
    walk("ROOT", 0);
    return rows;
  };
  const rewindTo = (id) => {
    const node = tree.find((n) => n.id === id);
    if (!node) return false;
    agent.setMessages(node.snapshot);
    leafId = id;
    return true;
  };
  // Rebuild the conversation tree from a flat message list (used after resuming a
  // saved session) so /tree shows the reopened history too. Mirrors recordTurn,
  // one (user, tawx) pair per turn, cumulative snapshots.
  const seedTreeFromMessages = () => {
    tree.length = 0; leafId = null;
    const msgs = agent.messages;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== "user") continue;
      addNode("user", textOf(msgs[i].content), msgs.slice(0, i + 1));
      let j = i + 1, lastAsst = null;
      while (j < msgs.length && msgs[j].role !== "user") { if (msgs[j].role === "assistant") lastAsst = msgs[j]; j++; }
      if (lastAsst) addNode("assistant", textOf(lastAsst.content), msgs.slice(0, j));
    }
  };
  // Repaint the whole conversation from the live context. Clears the screen,
  // reprints the banner + transcript (which flows inside the scroll region in
  // layout mode), optionally ends on a "Rewound here" marker, and re-pins the
  // bottom chrome. Used on rewind (/tree), resize, /clear and startup.
  const renderConversation = (marker = false) => {
    if (layoutOn) { resetRegion(); process.stdout.write("\x1b[2J\x1b[3J" + at(1)); setRegion(); }
    else process.stdout.write("\x1b[3J\x1b[2J\x1b[H");
    printBanner();
    for (const m of agent.messages) {
      if (m.role === "user") {
        const t = textOf(m.content).trim();
        if (t) process.stdout.write("\n" + c.accent("❯ ") + t + "\n");
      } else if (m.role === "assistant") {
        const t = textOf(m.content).trim();
        if (t) {
          const body = renderMarkdown(t).replace(/\n/g, "\n  ");
          process.stdout.write("\n  " + c.soft("◆") + " " + c.bold(c.soft("tawx")) + "\n  " + body + "\n");
        }
        if (m.tool_calls?.length) {
          const names = m.tool_calls.map((tc) => tc.function?.name).filter(Boolean).join(", ");
          process.stdout.write(PANEL_PAD + bgLine(" " + c.soft("▌") + " " + c.muted(names || "tools"), panelW(), BG.card) + "\n");
        }
      }
    }
    if (marker) process.stdout.write("\n" + c.green("  ↪ Rewound here") + c.dim(" — keep typing to start a new branch · /tree to jump again") + "\n");
    drawChromeIdle();
  };
  const renderTranscript = () => renderConversation(true);  // after a rewind
  const repaint = () => renderConversation(false);          // after a resize / clear

  // Load a saved session into the live context and continue from it: swap in its
  // messages, repoint the session file so new turns append back to it, rebuild
  // the tree, and repaint. Returns false if the session has no usable messages.
  const resumeInto = (sess) => {
    const msgs = (sess?.messages || []).filter((m) => m.role !== "system");
    if (!msgs.length) return false;
    agent.setMessages(msgs);
    if (sess.model) agent.setModel(sess.model);
    if (sess.id) { sessionId = sess.id; sessionFile = path.join(SESS_DIR, `${sessionId}.json`); }
    if (sess.started) startedAt = sess.started;
    seedTreeFromMessages();
    repaint();
    return true;
  };

  // Modal picker over saved sessions — ↑/↓ move, Enter open, Esc cancel. Returns
  // a session id or null. Renders in the transcript region like selectFromTree.
  const selectFromSessions = () => new Promise((resolve) => {
    const rows = listSessions();
    if (!rows.length) { resolve(null); return; }
    let sel = rows.findIndex((r) => r.id === sessionId);
    if (sel < 0) sel = 0;
    const render = () => {
      process.stdout.write("\x1b7\n\x1b[J");
      const lines = rows.slice(0, 12).map((r, i) => {
        const when = (r.updated || "").slice(0, 16).replace("T", " ");
        const head = `${r.id.slice(-4)}  ${when}  ${r.n} msgs`;
        const body = `${head}  ${r.snippet}`;
        const cur = r.id === sessionId ? c.ok("●") : c.faint("○");
        const label = i === sel ? c.inverse(" " + body + " ") : c.dim(body);
        return (i === sel ? c.accent("❯ ") : "  ") + cur + " " + label;
      });
      process.stdout.write(lines.join("\n"));
      process.stdout.write("\x1b8");
    };
    const cleanup = () => { process.stdin.removeListener("keypress", onKey); rl.removeListener("line", onLine); process.stdout.write("\x1b[J"); };
    const onKey = (_s, key) => {
      if (!key) return;
      const n = Math.min(rows.length, 12);
      if (key.name === "up") { sel = (sel - 1 + n) % n; render(); }
      else if (key.name === "down") { sel = (sel + 1) % n; render(); }
      else if (key.name === "escape") { cleanup(); resolve(null); }
    };
    const onLine = () => { cleanup(); resolve(rows[sel]?.id ?? null); };
    process.stdin.on("keypress", onKey);
    rl.on("line", onLine);
    rl.setPrompt(c.dim("  pick a conversation — ↑/↓ move · Enter open · Esc cancel "));
    rl.prompt();
    render();
  });

  // Modal picker over the tree — ↑/↓ move, Enter jump, Esc cancel. Returns node id or null.
  const selectFromTree = () => new Promise((resolve) => {
    const rows = flattenTree();
    if (!rows.length) { resolve(null); return; }
    let sel = Math.max(0, rows.findIndex((r) => r.id === leafId));
    const render = () => {
      process.stdout.write("\x1b7\n\x1b[J");
      const lines = rows.map((r, i) => {
        const marker = r.id === leafId ? c.ok("●") : c.faint("○");
        const indent = "   ".repeat(r.depth);
        const connector = r.depth > 0 && r.branch ? (r.isLast ? "└─ " : "├─ ") : "";
        const tag = r.role === "user" ? c.accent("You ") : c.soft("tawx");
        const label = i === sel ? c.inverse(" " + r.label + " ") : (r.id === leafId ? r.label : c.dim(r.label));
        return (i === sel ? c.accent("❯ ") : "  ") + indent + connector + marker + " " + tag + " " + label;
      });
      process.stdout.write(lines.join("\n"));
      process.stdout.write("\x1b8");
    };
    const cleanup = () => { process.stdin.removeListener("keypress", onKey); rl.removeListener("line", onLine); process.stdout.write("\x1b[J"); };
    const onKey = (_s, key) => {
      if (!key) return;
      if (key.name === "up") { sel = (sel - 1 + rows.length) % rows.length; render(); }
      else if (key.name === "down") { sel = (sel + 1) % rows.length; render(); }
      else if (key.name === "escape") { cleanup(); resolve(null); }
    };
    const onLine = () => { cleanup(); resolve(rows[sel]?.id ?? null); };
    process.stdin.on("keypress", onKey);
    rl.on("line", onLine);
    rl.setPrompt(c.dim("  pick a point — ↑/↓ move · Enter jump · Esc cancel "));
    rl.prompt();
    render();
  });

  // Release the scroll region (and park the cursor at the bottom) so the user's
  // shell isn't left with a constrained scrolling area after we exit.
  const cleanupLayout = () => { if (layoutOn) { resetRegion(); process.stdout.write(at(ROWS())); } };
  // Last-resort safety: always release the region on process exit.
  process.on("exit", () => { try { process.stdout.write("\x1b[r"); } catch { /* noop */ } });

  // On the way out, print the one command that reopens this conversation — but
  // only if we actually chatted (skip empty sessions).
  const printResumeHint = () => {
    if (!tree.length) return;
    process.stdout.write(c.dim(`continue later:  tawx resume #${sessionId.slice(-4)}\n`));
  };

  // Ctrl-C: cancel the in-flight turn (like Claude Code). Pressing it when idle exits.
  let aborter = null;
  rl.on("SIGINT", () => {
    if (aborter) {
      aborter.abort();
      stopSpin();
      if (mdStream) { mdStream.end(); mdStream = null; }
      process.stdout.write(c.yellow("\n  ⎋ interrupting…\n"));
    } else {
      cleanupLayout();
      process.stdout.write("\x1b[?2004l"); // disable bracketed paste
      rl.close();
      process.stdout.write(c.dim("\nbye 👋\n"));
      printResumeHint();
      process.exit(0);
    }
  });

  // Inline REPL needs no resize handling — the terminal reflows the transcript
  // itself, and we must NOT clear+repaint (that would wipe the user's scrollback).

  process.stdout.write("\x1b[?2004h"); // enable bracketed paste so multi-line pastes don't auto-submit
  if (layoutOn) { process.stdout.write("\x1b[2J\x1b[3J" + at(1)); setRegion(); }
  printBanner();

  // Show an update notice (bounded wait so it never lands mid-input and corrupts
  // the prompt line). Silent when up to date / offline.
  const latest = await Promise.race([updateCheck, new Promise((r) => setTimeout(() => r(null), 1500))]);
  if (latest) {
    process.stdout.write(
      c.yellow(`  ⚑ update available: v${VERSION} → v${latest}\n`) + c.dim(`    ${UPDATE_CMD}\n\n`),
    );
  }
  // If launched via `tawx resume`, load that conversation now (repaints itself);
  // otherwise just pin the composer + footer before the first prompt.
  if (resume && resumeInto(resume)) {
    process.stdout.write(c.dim(`  ↩ resumed #${sessionId.slice(-4)} — keep chatting, or /tree to jump back\n`));
  } else {
    drawChromeIdle();
  }

  for (;;) {
    if (!layoutOn) process.stdout.write("\n"); // breathing room between turns (layout has fixed chrome)
    const input = (await askMain(c.accent("❯ "))).trim();
    if (!input) continue;
    // In layout mode readline echoed the input into the (now-cleared) composer, not
    // the transcript — so replay it into the scroll region as the user's turn.
    if (layoutOn) process.stdout.write("\n" + c.accent("❯ ") + input + "\n");

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
      else if (cmd === "clear") { agent.reset(); tree.length = 0; leafId = null; if (layoutOn) repaint(); else process.stdout.write(c.dim("  history cleared\n")); }
      else if (cmd === "tree") {
        if (!tree.length) { process.stdout.write(c.dim("  no history yet — chat first, then /tree to jump back or branch\n")); continue; }
        const id = await selectFromTree();
        if (id && id !== leafId && rewindTo(id)) {
          // Re-render the whole chat view from the rewound context so the screen
          // matches the active timeline (post-checkpoint turns vanish).
          renderTranscript();
        } else { process.stdout.write(c.dim("  (stayed here)\n")); drawChromeIdle(); /* the picker overwrote the chrome */ }
      }
      else if (cmd === "resume") {
        const sessions = listSessions();
        if (!sessions.length) { process.stdout.write(c.dim("  no saved conversations yet\n")); continue; }
        // /resume <id|#NNNN> loads directly; bare /resume opens the picker.
        const arg = rest[0];
        const id = arg ? (loadSession(arg)?.id ?? null) : await selectFromSessions();
        if (!id) { process.stdout.write(c.dim(arg ? `  no session matching "${arg}"\n` : "  (cancelled)\n")); drawChromeIdle(); continue; }
        if (id === sessionId) { process.stdout.write(c.dim("  (already on this conversation)\n")); drawChromeIdle(); continue; }
        const sess = loadSession(id);
        if (sess && resumeInto(sess)) process.stdout.write(c.green(`  ↩ resumed #${sessionId.slice(-4)}`) + c.dim(" — keep chatting, or /tree to jump back\n"));
        else { process.stdout.write(c.red("  couldn't load that conversation\n")); drawChromeIdle(); }
      }
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
    recordTurn(input); // snapshot this turn into the conversation tree
    saveSession();     // persist the conversation after each turn
  }
  cleanupLayout();
  process.stdout.write("\x1b[?2004l"); // disable bracketed paste
  rl.close();
  process.stdout.write(c.dim("bye 👋\n"));
  printResumeHint();
}
