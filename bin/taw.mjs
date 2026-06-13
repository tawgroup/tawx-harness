#!/usr/bin/env node
// tawx-harness CLI entry. Modes: TUI (default), headless run, self-verify build, models, help.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createAgent } from "../src/agent.mjs";
import { runTui } from "../src/tui.mjs";
import { assertKey, MODELS, DEFAULT_MODEL, PROVIDER, PROVIDERS, AUTH, saveAuth, AUTH_PATH, VERSION, checkForUpdate, UPDATE_CMD, TAWX_DIR, SESSIONS_DIR, listSessions, loadSession } from "../src/config.mjs";
import { c } from "../src/ui.mjs";
import { loginCodexBrowser, loginCodexDeviceCode } from "../src/codex-oauth.mjs";

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
    else if (ev.type === "compact_done") process.stderr.write(c.dim(`♻ compacted context → ~${ev.after} tok\n`));
    else if (ev.type === "plan") {
      process.stderr.write(c.dim("▌ plan\n"));
      for (const it of ev.items || []) {
        const mark = it.status === "done" ? "✓" : it.status === "in_progress" ? "▸" : "○";
        process.stderr.write(c.dim(`  ${mark} ${it.step}\n`));
      }
    }
  },
};

const model = getFlag("--model", DEFAULT_MODEL);

async function prompt(q, def = "") {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = def ? ` (${def})` : "";
  const ans = await new Promise((r) => rl.question(q + suffix + ": ", r));
  rl.close();
  return ans.trim() || def;
}

async function login(providerArg = "") {
  const names = Object.keys(PROVIDERS);
  if (!providerArg) {
    process.stdout.write("Choose provider:\n");
    names.forEach((name, i) => process.stdout.write(`  ${i + 1}. ${name} — ${PROVIDERS[name].label}\n`));
  }
  const picked = providerArg || await prompt("Provider", PROVIDER);
  const provider = names[Number(picked) - 1] || picked;
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);

  const old = AUTH.providers?.[provider] || {};
  const model = getFlag("--model", "") || await prompt("Default model", old.model || cfg.defaultModel);
  const baseUrl = cfg.type === "claude-cli"
    ? ""
    : getFlag("--base-url", "") || getFlag("--url", "") || await prompt("Base URL", old.baseUrl || cfg.baseUrl);

  const next = { ...AUTH, active: provider, providers: { ...(AUTH.providers || {}) } };
  if (provider === "codex") {
    const method = getFlag("--method", "") || await prompt("Login method: browser/device", "browser");
    const oauth = method === "device" ? await loginCodexDeviceCode() : await loginCodexBrowser({ ask: prompt });
    next.providers[provider] = { model, baseUrl, oauth };
  } else if (cfg.type === "claude-cli") {
    process.stdout.write(c.dim("Using local `claude` command auth; no API key stored. Run `claude` once if not logged in.\n"));
    next.providers[provider] = { model, baseUrl };
  } else {
    const flagKey = getFlag("--api-key", "") || getFlag("--key", "");
    const apiKey = flagKey || await prompt(`API key (${cfg.keyEnv})`, old.apiKey ? "keep-existing" : "");
    next.providers[provider] = {
      model,
      baseUrl,
      apiKey: apiKey === "keep-existing" ? old.apiKey : apiKey,
    };
  }
  saveAuth(next);
  process.stdout.write(c.green(`✓ Active provider: ${provider}\n`));
  process.stdout.write(c.dim(`  model: ${model}\n  auth: ${AUTH_PATH}\n`));
}

async function useProvider(providerArg = "") {
  const provider = providerArg || getFlag("--provider", "") || PROVIDER;
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  const old = AUTH.providers?.[provider] || {};
  const next = { ...AUTH, active: provider, providers: { ...(AUTH.providers || {}) } };
  next.providers[provider] = {
    ...old,
    model: getFlag("--model", "") || old.model || cfg.defaultModel,
    baseUrl: getFlag("--base-url", "") || getFlag("--url", "") || old.baseUrl || cfg.baseUrl,
  };
  saveAuth(next);
  process.stdout.write(c.green(`✓ Active provider: ${provider}\n`));
  process.stdout.write(c.dim(`  model: ${next.providers[provider].model}\n  auth: ${AUTH_PATH}\n`));
}

const HELP = `tawx — minimal coding agent harness

Usage:
  tawx                         open interactive TUI (chat)
  tawx run "<task>"            run one task then exit (headless, auto-approve)
  tawx -p "<task>"            alias of run
  tawx build "<task>" --verify "<cmd>"
                               self-driving loop: build → run verify command →
                               if it fails, auto-fix → repeat until it PASSES (hands-off)
  tawx login [provider]        save credentials (opencode API key, codex OAuth, claude CLI)
  tawx use <provider>          switch active provider/model without changing key
  tawx whoami                  show active provider
  tawx models                  list models for the active provider
  tawx sessions                list saved conversations (~/.tawx/sessions)
  tawx resume [id]             reopen a saved conversation and keep chatting
                               (id = full id or #NNNN tail; no id = newest)
  tawx --version               show version + check for updates
  tawx --help

Options:
  --model <id>                 pick a model (default ${DEFAULT_MODEL})
  --max-steps <n>              max agent steps per round
  --cwd <path>                 working directory
  --task-file <path>           read the task from a file (keeps the cmdline short & safe)
  --verify "<cmd>"             (build) shell command that proves success (exit 0 = pass)
  --rounds <n>                 (build) max auto-fix rounds (default 4)
  --api-key <key>              (login) provider key, avoids prompt
  --base-url <url>             (login/use) override provider endpoint
  --method <browser|device>    (codex login) OAuth method

Env:
  TAWX_PROVIDER=<opencode|codex|claude>
  TAWX_API_KEY=<key>                override saved provider key
  TAWX_MODEL=<model>                override saved/default model
  TAWX_BASE_URL=<url>               override provider endpoint
  TAWX_REQUEST_TIMEOUT=<ms>         per-request timeout (default 180000)
`;

// ---- taw-case / pi-protocol headless mode ---------------------------------
// Lets taw-case (or any pi-compatible orchestrator) spawn tawx as a drop-in
// for `pi`: same flags in, newline-delimited JSON events out. One auto-approved,
// tool-scoped agent run, then a SINGLE message_end carrying the answer/verdict.

// Map taw-case's generic role tools → concrete tawx tool names. update_plan is
// always allowed (in-memory checklist, harmless). An unknown token passes
// through as-is, so a config may also name tawx tools directly.
const CASE_TOOL_MAP = {
  read: ["read_file", "diff"],
  bash: ["bash"],
  edit: ["edit_file", "multi_edit", "apply_patch", "undo_last_change"],
  write: ["write_file"],
  grep: ["grep"],
  find: ["glob"],
  ls: ["list_dir"],
  fetch: ["web_fetch"],
};
function mapCaseTools(csv) {
  if (!csv) return null; // no --tools → all tools available
  const allow = new Set(["update_plan"]);
  for (const raw of csv.split(",").map((s) => s.trim()).filter(Boolean)) {
    const mapped = CASE_TOOL_MAP[raw];
    if (mapped) mapped.forEach((t) => allow.add(t));
    else allow.add(raw);
  }
  return [...allow];
}

// Walk argv: value-flags consume the next token, bare-flags stand alone, and
// whatever is left is the prompt (taw-case passes it as the final positional).
function parseCaseArgs() {
  const VALUE = new Set(["--model", "--mode", "--tools", "--max-steps", "--cwd",
    "--append-system-prompt", "--provider", "--skill", "--task-file"]);
  const flags = {};
  const prompt = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE.has(a)) { flags[a] = argv[++i]; continue; }
    if (a.startsWith("-")) continue; // bare/unknown flag → ignore (don't pollute prompt)
    prompt.push(a);
  }
  return { flags, prompt: prompt.join(" ").trim() };
}

async function runCase() {
  const { flags, prompt } = parseCaseArgs();
  const task = flags["--task-file"]
    ? fs.readFileSync(flags["--task-file"], "utf8").trim()
    : prompt;
  if (!task) { process.stderr.write("tawx case: missing task.\n"); process.exit(2); }

  const sys = flags["--append-system-prompt"] || "";
  const fullPrompt = sys ? `${sys}\n\n${task}` : task;
  const caseModel = flags["--model"] || model;
  const cwd = flags["--cwd"] || process.cwd();
  const maxSteps = Number(flags["--max-steps"] || 0) || undefined;
  const allowTools = mapCaseTools(flags["--tools"]);

  const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
  let reachedLimit = false;
  const agent = createAgent({
    model: caseModel, cwd, maxSteps, tools: allowTools, approve: async () => true,
    onEvent(ev) {
      // stream tool starts so the orchestrator shows live progress
      if (ev.type === "tool_start")
        emit({ type: "tool_execution_start", toolName: ev.name, args: { info: String(ev.preview ?? "") } });
      else if (ev.type === "max_steps") reachedLimit = true;
    },
  });

  try {
    const text = await agent.send(fullPrompt);
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: String(text ?? "") }] } });
  } catch (e) {
    process.stderr.write(`tawx case error: ${e?.message || e}\n`);
    process.exit(1);
  }
  process.exit(reachedLimit ? 1 : 0);
}

async function main() {
  const cmd = argv[0];

  if (hasFlag("--version") || hasFlag("-v") || cmd === "version") {
    process.stdout.write(`tawx v${VERSION}\n`);
    const latest = await checkForUpdate(2500);
    if (latest) process.stdout.write(c.yellow(`update available → v${latest}\n`) + c.dim(`  ${UPDATE_CMD}\n`));
    else process.stdout.write(c.dim("up to date\n"));
    return;
  }
  if (hasFlag("--help") || hasFlag("-h") || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "login") {
    await login(argv[1]?.startsWith("-") ? "" : argv[1]);
    return;
  }
  if (cmd === "use") {
    await useProvider(argv[1]?.startsWith("-") ? "" : argv[1]);
    return;
  }
  if (cmd === "whoami") {
    process.stdout.write(`provider: ${PROVIDER}\nmodel: ${DEFAULT_MODEL}\nauth: ${AUTH_PATH}\n`);
    return;
  }
  if (cmd === "models") {
    process.stdout.write(MODELS.join("\n") + "\n");
    return;
  }
  if (cmd === "sessions") {
    const rows = listSessions();
    if (!rows.length) { process.stdout.write("No saved sessions yet.\n"); return; }
    for (const r of rows) {
      process.stdout.write(`${c.bold(r.id)}  ${c.dim(r.updated.slice(0, 16).replace("T", " "))}  ${c.dim(r.model)}  ${c.dim(`${r.n} msgs`)}\n  ${c.dim(r.snippet)}\n`);
    }
    process.stdout.write(c.dim(`\n${rows.length} sessions in ${SESSIONS_DIR}\n`));
    process.stdout.write(c.dim(`resume:  tawx resume #${rows[0].id.slice(-4)}   (or: tawx resume — newest)\n`));
    return;
  }

  assertKey();

  // taw-case / pi-protocol headless mode: an orchestrator drives tawx as a
  // drop-in for `pi`. Triggered by `--mode json`. See runCase() below.
  if (getFlag("--mode", "") === "json") { await runCase(); return; }

  // resume a saved conversation into the TUI and keep chatting
  if (cmd === "resume" || cmd === "continue") {
    const arg = argv[1]?.startsWith("-") ? "" : argv[1];
    const sess = loadSession(arg || "");
    if (!sess) {
      process.stdout.write(c.yellow(arg ? `No session matching "${arg}".\n` : "No saved sessions yet.\n"));
      const rows = listSessions();
      if (rows.length) process.stdout.write(c.dim("recent:\n") + rows.slice(0, 8).map((r) => `  ${r.id}  ${r.snippet}`).join("\n") + "\n");
      return;
    }
    await runTui({ model: sess.model || model, resume: sess });
    return;
  }

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
      "Build in small files, verify with real commands, and keep explanations short.";

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
