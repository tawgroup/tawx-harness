// Interactive terminal UI (readline + ANSI). Chat-style, with streaming, tool rendering + approval.
import readline from "node:readline";
import { createAgent } from "./agent.mjs";
import { c, banner, renderMarkdown, createMdStream } from "./ui.mjs";
import { GO_MODELS, DEFAULT_MODEL } from "./config.mjs";

const HELP = `
${c.bold("Commands:")}
  /help            show help
  /model <id>      switch model (e.g. /model qwen3.6-plus)
  /models          list OpenCode Go models
  /yolo            auto-approve every action (write/edit/bash)
  /safe            turn off auto-approve (default)
  /skills          list available skills
  /clear           clear conversation history
  /exit            quit
`;

export async function runTui({ model = DEFAULT_MODEL } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  let autoApprove = false;
  let spin = null;
  let activeSkill = null;   // last skill loaded via load_skill
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
          const tag = activeSkill ? c.dim(` · skill:${activeSkill}`) : "";
          spin = setInterval(() => process.stdout.write("\r" + c.magenta(fr[i++ % fr.length]) + c.dim(` ${ev.model} thinking…`) + tag + "  "), 80);
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
          if (ev.name === "load_skill") activeSkill = String(ev.preview).trim();
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
            const secs = turnStart ? `, ${((Date.now() - turnStart) / 1000).toFixed(1)}s` : "";
            process.stdout.write(c.gray(`    · ${ev.usage.total_tokens} tok` + (ev.cost != null ? `, cost ${ev.cost}` : "") + secs) + "\n");
          }
          break;
        case "max_steps":
          process.stdout.write(c.yellow("  ⚠ reached step limit\n"));
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

  process.stdout.write(banner(agent.model));

  for (;;) {
    const input = (await ask(c.magenta("› "))).trim();
    if (!input) continue;

    if (input.startsWith("/")) {
      const [cmd, ...rest] = input.slice(1).split(/\s+/);
      if (cmd === "exit" || cmd === "quit") break;
      else if (cmd === "help") process.stdout.write(HELP + "\n");
      else if (cmd === "models") process.stdout.write("  " + GO_MODELS.join("\n  ") + "\n");
      else if (cmd === "model") { if (rest[0]) { agent.setModel(rest[0]); process.stdout.write(c.dim(`  model → ${rest[0]}\n`)); } }
      else if (cmd === "yolo") { autoApprove = true; process.stdout.write(c.yellow("  YOLO: auto-approving every action\n")); }
      else if (cmd === "safe") { autoApprove = false; process.stdout.write(c.dim("  SAFE: ask before write/edit/bash\n")); }
      else if (cmd === "skills") process.stdout.write([...agent.skills.values()].map((s) => `  ${c.bold(s.name)} — ${c.dim(s.description)}`).join("\n") + "\n" || "  (no skills)\n");
      else if (cmd === "clear") { agent.reset(); activeSkill = null; process.stdout.write(c.dim("  history cleared\n")); }
      else process.stdout.write(c.red(`  unknown command: /${cmd}\n`));
      continue;
    }

    try {
      await agent.send(input);
    } catch (e) {
      stopSpin();
      if (mdStream) { mdStream.end(); mdStream = null; }
      process.stdout.write(c.red(`  ✗ ${e.message}\n`));
    }
  }
  rl.close();
  process.stdout.write(c.dim("bye 👋\n"));
}
