// Smoke test. Offline parts always run; the live end-to-end runs only if OPENCODE_API_KEY is set.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { TOOLS } from "../src/tools.mjs";
import { loadProjectContext, systemPrompt } from "../src/prompt.mjs";
import { API_KEY, DEFAULT_MODEL, PROVIDER } from "../src/config.mjs";
import { createAgent } from "../src/agent.mjs";

let pass = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); pass++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "taw-smoke-"));
const ctx = { cwd: tmp };

console.log("OFFLINE tools:");
await TOOLS.write_file.run({ path: "a.txt", content: "hello\nworld" }, ctx);
assert.equal(fs.readFileSync(path.join(tmp, "a.txt"), "utf8"), "hello\nworld");
ok("write_file");

const r = await TOOLS.read_file.run({ path: "a.txt" }, ctx);
assert.ok(r.includes("hello") && r.includes("1  "));
ok("read_file (numbered)");

await TOOLS.edit_file.run({ path: "a.txt", old_string: "world", new_string: "taw" }, ctx);
assert.ok(fs.readFileSync(path.join(tmp, "a.txt"), "utf8").includes("taw"));
ok("edit_file");

const d = await TOOLS.diff.run({ path: "a.txt", old_string: "taw", new_string: "TAW" }, ctx);
assert.ok(d.includes("--- a/a.txt") && d.includes("+TAW"), "diff previews replacement");
ok("diff preview");

const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n hello\n-taw\n+TAW\n";
const ap = await TOOLS.apply_patch.run({ patch }, ctx);
assert.ok(ap.includes("OK: applied patch"), "apply_patch should apply unified diff");
assert.ok(fs.readFileSync(path.join(tmp, "a.txt"), "utf8").includes("TAW"));
ok("apply_patch");

const un = await TOOLS.undo_last_change.run({}, ctx);
assert.ok(un.includes("OK: reverted"), "undo should restore last patch checkpoint");
assert.ok(fs.readFileSync(path.join(tmp, "a.txt"), "utf8").includes("taw"));
ok("undo_last_change");

// Lenient apply: bogus @@ line numbers must still apply by matching content.
await TOOLS.write_file.run({ path: "x.js", content: "line1\nline2\nline3\n" }, ctx);
const wrong = await TOOLS.apply_patch.run(
  { patch: "--- a/x.js\n+++ b/x.js\n@@ -999,3 +999,3 @@\n line1\n-line2\n+LINE2\n line3\n" }, ctx);
assert.ok(wrong.startsWith("OK"), "apply_patch ignores wrong @@ numbers");
assert.equal(fs.readFileSync(path.join(tmp, "x.js"), "utf8"), "line1\nLINE2\nline3\n");
ok("apply_patch (wrong line numbers)");

// New file via /dev/null, ending with a trailing newline like git.
const created = await TOOLS.apply_patch.run(
  { patch: "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+brand\n+new\n" }, ctx);
assert.ok(created.startsWith("OK"), "apply_patch creates new files");
assert.equal(fs.readFileSync(path.join(tmp, "new.txt"), "utf8"), "brand\nnew\n");
ok("apply_patch (new file)");

const ls = await TOOLS.list_dir.run({ path: "." }, ctx);
assert.ok(ls.includes("a.txt"));
ok("list_dir");

const bash = await TOOLS.bash.run({ command: "echo hi-from-bash" }, ctx);
assert.ok(bash.includes("hi-from-bash") && bash.includes("exit 0"));
ok("bash");

const g = await TOOLS.grep.run({ pattern: "taw", path: "." }, ctx);
assert.ok(g.includes("taw"));
ok("grep");

const gInc = await TOOLS.grep.run({ pattern: "taw", path: ".", include: "*.md" }, ctx);
assert.ok(gInc.includes("no matches") || !gInc.includes("a.txt"), "include glob should filter out a.txt");
ok("grep include filter");

// read_file offset/limit (partial read)
await TOOLS.write_file.run({ path: "many.txt", content: "L1\nL2\nL3\nL4\nL5" }, ctx);
const slice = await TOOLS.read_file.run({ path: "many.txt", offset: 2, limit: 2 }, ctx);
assert.ok(slice.includes("L2") && slice.includes("L3") && !slice.includes("L5"), "partial read");
assert.ok(/lines 2-3 of 5/.test(slice), "partial-read note");
ok("read_file offset/limit");

// glob
await TOOLS.write_file.run({ path: "src/deep/x.mjs", content: "export const x=1" }, ctx);
await TOOLS.write_file.run({ path: "node_modules/junk/y.mjs", content: "skip me" }, ctx);
const gl = await TOOLS.glob.run({ pattern: "**/*.mjs", path: "." }, ctx);
assert.ok(gl.includes("src/deep/x.mjs"), "glob finds nested file");
assert.ok(!gl.includes("node_modules"), "glob skips node_modules");
ok("glob (** + ignore dirs)");

console.log("OFFLINE project context:");
fs.writeFileSync(path.join(tmp, "AGENTS.md"), "Use 2-space indent. Prefer fp style.");
const pc = loadProjectContext(tmp);
assert.ok(pc && pc.name === "AGENTS.md" && /2-space indent/.test(pc.text), "loads AGENTS.md");
const sys = systemPrompt({ cwd: tmp, model: "glm-5" });
assert.ok(sys.includes("Project instructions") && sys.includes("2-space indent"), "injects into prompt");
assert.ok(sys.includes("glob") && sys.includes("bash"), "prompt advertises tools");
ok("AGENTS.md auto-loaded into system prompt");

if (!API_KEY) {
  console.log("\nLIVE test: SKIPPED (OPENCODE_API_KEY not set)");
  console.log(`\n${pass} offline checks passed ✓`);
  process.exit(0);
}

console.log("\nLIVE end-to-end (real call to the Go plan):");
const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), "taw-live-"));
const agent = createAgent({
  cwd: liveDir,
  model: process.env.TAW_MODEL || DEFAULT_MODEL,
  maxSteps: 15,
  approve: async () => true,
  onEvent: (ev) => {
    if (ev.type === "tool_call") console.log(`    ⚒ ${ev.name} ${String(ev.preview).slice(0, 60)}`);
  },
});

await agent.send(
  'Create a file hello.mjs that prints the line "TAW OK", then run it with node to prove it works.',
);

const made = fs.existsSync(path.join(liveDir, "hello.mjs"));
assert.ok(made, "agent should create hello.mjs");
ok("agent created a file via tool");
const content = fs.readFileSync(path.join(liveDir, "hello.mjs"), "utf8");
assert.ok(/TAW OK/.test(content), "file should contain TAW OK");
ok("file content is correct");

console.log(`\n${pass} checks passed ✓ — harness works end-to-end on ${PROVIDER}.`);
process.exit(0);
