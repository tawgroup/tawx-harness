#!/usr/bin/env node
// taw harness CLI entry. Modes: TUI (default), headless run, self-verify build, models, help.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createAgent } from "../src/agent.mjs";
import { runTui } from "../src/tui.mjs";
import { assertKey, GO_MODELS, DEFAULT_MODEL } from "../src/config.mjs";
import { c } from "../src/ui.mjs";

const argv = process.argv.slice(2);

function getFlag(name, def) {
  const i = argv.indexOf(name);
  if (i === -1) return def;
  return argv[i + 1];
}
const hasFlag = (name) => argv.includes(name);

// task = positional args (everything after subcommand that isn't a flag or flag-value)
function parseTask(flagNames) {
  const flagVals = new Set();
  for (const f of flagNames) {
    const i = argv.indexOf(f);
    if (i !== -1) flagVals.add(i), flagVals.add(i + 1);
  }
  return argv.slice(1).filter((_, i) => !flagVals.has(i + 1)).join(" ").trim();
}

// shared headless event printer
const headlessEvents = {
  onEvent(ev) {
    if (ev.type === "assistant") process.stdout.write(c.bold("⏺ ") + ev.text.trim() + "\n");
    else if (ev.type === "tool_call") process.stderr.write(c.green("⚒ ") + ev.name + c.dim(" " + String(ev.preview).split("\n")[0].slice(0, 100)) + "\n");
    else if (ev.type === "tool_result") process.stderr.write(c.dim(String(ev.result).split("\n").slice(0, 3).join("\n").slice(0, 240)) + "\n");
    else if (ev.type === "max_steps") process.stderr.write(c.yellow("⚠ reached step limit\n"));
  },
};

const model = getFlag("--model", DEFAULT_MODEL);

const HELP = `taw harness — coding agent powered by OpenCode Go (cheap models)

Usage:
  taw                          open interactive TUI (chat)
  taw run "<task>"             run one task then exit (headless, auto-approve)
  taw -p "<task>"             alias of run
  taw build "<task>" --verify "<cmd>"
                               self-driving loop: build → run verify command →
                               if it fails, auto-fix → repeat until it PASSES (hands-off)
  taw models                   list OpenCode Go models
  taw --help

Options:
  --model <id>                 pick a model (default ${DEFAULT_MODEL})
  --max-steps <n>              max agent steps per round
  --cwd <path>                 working directory
  --task-file <path>           read the task from a file (keeps the cmdline short & safe)
  --verify "<cmd>"             (build) shell command that proves success (exit 0 = pass)
  --rounds <n>                 (build) max auto-fix rounds (default 4)

Env:
  OPENCODE_API_KEY=<Go plan key>   (required; or put it in .env)
  TAW_REQUEST_TIMEOUT=<ms>         per-request timeout (default 180000)
`;

async function main() {
  const cmd = argv[0];

  if (hasFlag("--help") || hasFlag("-h") || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "models") {
    process.stdout.write(GO_MODELS.join("\n") + "\n");
    return;
  }

  assertKey();

  // headless run
  if (cmd === "run" || cmd === "-p") {
    const taskFile = getFlag("--task-file", "");
    const task = taskFile
      ? fs.readFileSync(taskFile, "utf8").trim()
      : parseTask(["--model", "--max-steps", "--cwd", "--task-file"]);
    if (!task) { process.stderr.write("Missing task.\n"); process.exit(2); }

    const cwd = getFlag("--cwd", process.cwd());
    const maxSteps = Number(getFlag("--max-steps", 0)) || undefined;
    const agent = createAgent({ model, cwd, maxSteps, approve: async () => true, ...headlessEvents });
    try {
      await agent.send(task);
    } catch (e) {
      process.stderr.write(c.red(`✗ ${e.message}\n`));
      process.exit(1);
    }
    return;
  }

  // self-verify build: build -> verify -> auto-fix loop (no human in the loop)
  if (cmd === "build") {
    const taskFile = getFlag("--task-file", "");
    const task = taskFile
      ? fs.readFileSync(taskFile, "utf8").trim()
      : parseTask(["--model", "--max-steps", "--cwd", "--verify", "--rounds", "--task-file"]);
    const verify = getFlag("--verify", "");
    const rounds = Number(getFlag("--rounds", 4)) || 4;
    const cwd = getFlag("--cwd", process.cwd());
    const maxSteps = Number(getFlag("--max-steps", 0)) || undefined;
    if (!task) { process.stderr.write("Missing task.\n"); process.exit(2); }
    if (!verify) { process.stderr.write('build needs --verify "<command>" (exit 0 = pass).\n'); process.exit(2); }

    const agent = createAgent({ model, cwd, maxSteps, approve: async () => true, ...headlessEvents });

    let prompt =
      task +
      "\n\nNOTE: after you finish, the system will AUTOMATICALLY run a verify command to confirm the app really works. " +
      "If a relevant skill exists (e.g. 'fullstack'), call load_skill to follow its playbook (split into small files, isolate test data, map '/'→index.html, self boot+curl).";

    for (let round = 1; round <= rounds; round++) {
      process.stderr.write(c.bold(`\n=== Round ${round}/${rounds} ===\n`));
      try {
        await agent.send(prompt);
      } catch (e) {
        process.stderr.write(c.red(`✗ agent error: ${e.message}\n`));
        process.exit(1);
      }

      process.stderr.write(c.dim(`\n▶ Verify: ${verify}\n`));
      const v = spawnSync("bash", ["-lc", verify], { cwd, encoding: "utf8", timeout: 120000 });
      const out = ((v.stdout || "") + (v.stderr || "")).trim();

      if (v.status === 0) {
        process.stdout.write(c.green(`\n✓ Verify PASSED on round ${round}. Done.\n`));
        if (out) process.stdout.write(out.slice(-1200) + "\n");
        return;
      }

      process.stderr.write(c.yellow(`✗ Verify FAILED (exit ${v.status}). Feeding the error back to the agent.\n`));
      prompt =
        `The verify command \`${verify}\` FAILED (exit code ${v.status}). Output:\n\n` +
        `${out.slice(-4000)}\n\n` +
        "Read the error, fix the root cause, then let the system run it again. Focus on fixing, keep explanations short.";
    }

    process.stderr.write(c.red(`\n✗ Still not passing after ${rounds} rounds. Stopping.\n`));
    process.exit(1);
  }

  // default: TUI
  await runTui({ model });
}

main().catch((e) => {
  process.stderr.write(`✗ ${e.message}\n`);
  process.exit(1);
});
