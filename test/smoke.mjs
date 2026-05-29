// Smoke test. Offline parts always run; the live end-to-end runs only if OPENCODE_API_KEY is set.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { TOOLS } from "../src/tools.mjs";
import { loadSkills, skillsIndex } from "../src/skills.mjs";
import { API_KEY } from "../src/config.mjs";
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

const ls = await TOOLS.list_dir.run({ path: "." }, ctx);
assert.ok(ls.includes("a.txt"));
ok("list_dir");

const bash = await TOOLS.bash.run({ command: "echo hi-from-bash" }, ctx);
assert.ok(bash.includes("hi-from-bash") && bash.includes("exit 0"));
ok("bash");

const g = await TOOLS.grep.run({ pattern: "taw", path: "." }, ctx);
assert.ok(g.includes("taw"));
ok("grep");

console.log("OFFLINE skills:");
const skills = loadSkills(process.cwd());
assert.ok(skills.size >= 1, "should load bundled skills");
assert.ok(skillsIndex(skills).includes("git-commit"));
ok(`loaded ${skills.size} skills`);

if (!API_KEY) {
  console.log("\nLIVE test: SKIPPED (OPENCODE_API_KEY not set)");
  console.log(`\n${pass} offline checks passed ✓`);
  process.exit(0);
}

console.log("\nLIVE end-to-end (real call to the Go plan):");
const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), "taw-live-"));
const agent = createAgent({
  cwd: liveDir,
  model: process.env.TAW_MODEL || "glm-5",
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

console.log(`\n${pass} checks passed ✓ — harness works end-to-end on the Go plan.`);
process.exit(0);
