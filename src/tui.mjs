// Interactive terminal UI (readline + ANSI). Chat-style, with streaming, tool rendering + approval.
import readline from "node:readline";
import { createAgent } from "./agent.mjs";
import { c, banner, renderMarkdown, createMdStream } from "./ui.mjs";
import { MODELS, DEFAULT_MODEL, PROVIDER } from "./config.mjs";

const COMMANDS = ["/help", "/model", "/models", "/whoami", "/yolo", "/safe", "/clear", "/exit"];
const COMMAND_DESC = {
  "/help": "show help",
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
  const hits = MODELS.filter((m) => m.startsWith(prefix));
  const list = hits.length ? hits : MODELS;
  return list.map((m) => `  ${c.bold(m)}`).join("\n") + "\n";
}

function complete(line) {
  const s = String(line || "");
  if (!s.startsWith("/")) return [[], s];

  const parts = s.split(/\s+/);
  if (parts[0] === "/model") {
    const prefix = parts[1] || "";
    const hits = MODELS.filter((m) => m.startsWith(prefix)).map((m) => `/model ${m}`);
    return [hits.length ? hits : MODELS.map((m) => `/model ${m}`), s];
  }

  const hits = COMMANDS.filter((cmd) => cmd.startsWith(s));
  return [hits.length ? hits : COMMANDS, s];
}

const HELP = `
${c.bold("Commands:")}
  /help            show help
  /model <id>      switch model for this TUI session (e.g. /model qwen3.6-plus)
  /models          list models for active provider
  /whoami          show active provider/model
  /yolo            auto-approve every action (write/edit/bash)
  /safe            turn off auto-approve (default)
  /clear           clear conversation history
  /exit            quit

  Tab              autocomplete slash commands and model ids
  Ctrl-C           interrupt the running turn (press again when idle to quit)
`;

export async function runTui({ model = DEFAULT_MODEL } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer: complete });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  let autoApprove = false;
  let spin = null;
  let turnStart = 0;        // wall-clock of the current model turn
  let mdStream = null;      // streaming markdown renderer for the current assistant message
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
        case "todos": {
          const sym = { pending: c.dim("○"), in_progress: c.yellow("◐"), completed: c.green("●") };
          const out = ev.todos
            .map((t) => "    " + (sym[t.status] || c.dim("○")) + " " +
              (t.status === "completed" ? c.dim(t.content) : t.status === "in_progress" ? c.bold(t.content) : t.content))
            .join("\n");
          process.stdout.write(c.cyan("  ☑ plan\n") + out + "\n");
          break;
        }
        case "usage":
          if (ev.usage?.total_tokens) {
            const secs = turnStart ? `, ${((Date.now() - turnStart) / 1000).toFixed(1)}s` : "";
            process.stdout.write(c.gray(`    · ${ev.usage.total_tokens} tok` + (ev.cost != null ? `, cost ${ev.cost}` : "") + secs) + "\n");
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
      rl.close();
      process.stdout.write(c.dim("\nbye 👋\n"));
      process.exit(0);
    }
  });

  process.stdout.write(banner(`${agent.model} · ${PROVIDER}`));

  for (;;) {
    const input = (await ask(c.magenta("› "))).trim();
    if (!input) continue;

    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.slice(1).split(/\s+/);
      if (cmd === "exit" || cmd === "quit") break;
      else if (cmd === "help") process.stdout.write(HELP + "\n");
      else if (cmd === "models") process.stdout.write("  " + MODELS.join("\n  ") + "\n");
      else if (cmd === "whoami") process.stdout.write(`  provider: ${PROVIDER}\n  model: ${agent.model}\n  note: use \`tawx login\` or \`tawx use\` outside TUI to switch provider persistently\n`);
      else if (cmd === "model") {
        if (!rest[0]) process.stdout.write(c.dim("  choose a model:\n") + showModelSuggestions());
        else if (!MODELS.includes(rest[0])) process.stdout.write(c.yellow(`  model not in known list: ${rest[0]}\n`) + c.dim("  suggestions:\n") + showModelSuggestions(rest[0]));
        else { agent.setModel(rest[0]); process.stdout.write(c.dim(`  model → ${rest[0]} (this session)\n`)); }
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
  rl.close();
  process.stdout.write(c.dim("bye 👋\n"));
}
