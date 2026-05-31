// Tool registry — the model's hands. Each tool: {schema, run(args, ctx)}.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { TOOL_OUTPUT_CAP } from "./config.mjs";

const cap = (s) =>
  s.length > TOOL_OUTPUT_CAP
    ? s.slice(0, TOOL_OUTPUT_CAP) + `\n…[truncated, ${s.length - TOOL_OUTPUT_CAP} more chars]`
    : s;

const resolve = (ctx, p) => (path.isAbsolute(p) ? p : path.join(ctx.cwd, p));

// Directories we never descend into for glob/grep — keeps cheap models from drowning
// in dependency/build noise (and saves tokens). bash can still reach them explicitly.
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".cache",
  "coverage", ".venv", "venv", "__pycache__", "target", ".turbo", ".svelte-kit",
]);

// Convert a glob (supports **, *, ?) to an anchored RegExp matched against a relative path.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } // **/ → any depth (incl. zero)
        else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if ("\\^$.|+()[]{}".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  return new RegExp("^" + re + "$");
}

// Recursively collect file paths (relative to root), skipping IGNORE_DIRS. Bounded for safety.
function walkFiles(root, { limit = 5000 } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        out.push(path.relative(root, full));
      }
    }
  }
  return out;
}

function sh(command, cwd, timeout = 120000) {
  return new Promise((resolve) => {
    execFile("bash", ["-c", command], { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout || "") + (stderr ? (stdout ? "\n" : "") + stderr : "");
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      let s = out.trim();
      if (err && err.killed) s += `\n[timed out after ${timeout}ms]`;
      resolve(`(exit ${code})\n${s || "(no output)"}`);
    });
  });
}

export const TOOLS = {
  read_file: {
    schema: {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read the contents of a text file. Returns it with line numbers. " +
          "For a large file, pass offset (1-based start line) and limit (number of lines) to read just a slice.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "file path (absolute or relative to cwd)" },
            offset: { type: "number", description: "1-based line to start from (optional)" },
            limit: { type: "number", description: "max number of lines to read (optional)" },
          },
          required: ["path"],
        },
      },
    },
    needsApproval: false,
    preview: (a) => a.path + (a.offset ? `:${a.offset}` : ""),
    async run(a, ctx) {
      const f = resolve(ctx, a.path);
      if (!fs.existsSync(f)) return `ERROR: not found ${a.path}`;
      if (fs.statSync(f).isDirectory()) return `ERROR: ${a.path} is a directory (use list_dir)`;
      const lines = fs.readFileSync(f, "utf8").split("\n");
      const total = lines.length;
      const start = a.offset && a.offset > 0 ? a.offset - 1 : 0;
      const end = a.limit && a.limit > 0 ? start + a.limit : total;
      const slice = lines.slice(start, end);
      const numbered = slice
        .map((l, i) => `${String(start + i + 1).padStart(5)}  ${l}`)
        .join("\n");
      const note =
        start > 0 || end < total
          ? `\n…[showing lines ${start + 1}-${Math.min(end, total)} of ${total}]`
          : "";
      return cap(numbered + note);
    },
  },

  write_file: {
    schema: {
      type: "function",
      function: {
        name: "write_file",
        description: "Write (create or overwrite) a file's full contents. Creates parent dirs.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    },
    needsApproval: true,
    preview: (a) => `${a.path} (${a.content.length} bytes)`,
    async run(a, ctx) {
      const f = resolve(ctx, a.path);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, a.content);
      return `OK: wrote ${a.path} (${a.content.length} bytes)`;
    },
  },

  edit_file: {
    schema: {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Replace a string in a file. old_string must match exactly once (unless replace_all=true).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    needsApproval: true,
    preview: (a) => a.path,
    async run(a, ctx) {
      const f = resolve(ctx, a.path);
      if (!fs.existsSync(f)) return `ERROR: not found ${a.path}`;
      const data = fs.readFileSync(f, "utf8");
      const count = data.split(a.old_string).length - 1;
      if (count === 0) return `ERROR: old_string not found in ${a.path}`;
      if (count > 1 && !a.replace_all)
        return `ERROR: old_string matches ${count} places. Add replace_all=true or use a longer string.`;
      const next = a.replace_all
        ? data.split(a.old_string).join(a.new_string)
        : data.replace(a.old_string, a.new_string);
      fs.writeFileSync(f, next);
      return `OK: edited ${a.path} (${a.replace_all ? count : 1} place${a.replace_all && count > 1 ? "s" : ""})`;
    },
  },

  list_dir: {
    schema: {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files/directories at a path.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    needsApproval: false,
    preview: (a) => a.path,
    async run(a, ctx) {
      const d = resolve(ctx, a.path);
      if (!fs.existsSync(d)) return `ERROR: not found ${a.path}`;
      const items = fs.readdirSync(d, { withFileTypes: true });
      return cap(
        items
          .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
          .sort()
          .join("\n") || "(empty)",
      );
    },
  },

  grep: {
    schema: {
      type: "function",
      function: {
        name: "grep",
        description:
          "Search for a regex pattern in code. Uses ripgrep if available (else grep). " +
          "Skips node_modules/.git/build dirs. Optional: include (glob like '*.ts' or 'src/**'), " +
          "context (N lines of context around each match).",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string", description: "dir/file, defaults to cwd" },
            include: { type: "string", description: "only search files matching this glob, e.g. '*.mjs'" },
            context: { type: "number", description: "lines of context around each match (like grep -C)" },
          },
          required: ["pattern"],
        },
      },
    },
    needsApproval: false,
    preview: (a) => `"${a.pattern}" in ${a.path || "."}` + (a.include ? ` (${a.include})` : ""),
    async run(a, ctx) {
      const where = a.path ? resolve(ctx, a.path) : ctx.cwd;
      const q = a.pattern.replace(/'/g, "'\\''");
      const ctxN = Number.isFinite(a.context) && a.context > 0 ? ` -C ${Math.min(a.context, 10)}` : "";
      const inc = a.include ? String(a.include).replace(/'/g, "'\\''") : "";

      // ripgrep honours .gitignore + skips binaries automatically; -g filters by glob.
      const rgInc = inc ? ` -g '${inc}'` : "";
      const rg = `rg -n --no-heading${ctxN}${rgInc} -e '${q}' '${where}'`;

      // grep fallback: explicitly exclude the noise dirs ripgrep would have skipped.
      const excl = [...IGNORE_DIRS].map((d) => `--exclude-dir='${d}'`).join(" ");
      const grepInc = inc ? ` --include='${inc}'` : "";
      const grep = `grep -rnI ${excl}${ctxN}${grepInc} -e '${q}' '${where}'`;

      const cmd = `command -v rg >/dev/null 2>&1 && ${rg} || ${grep}`;
      const out = await sh(cmd, ctx.cwd, 30000);
      // exit 1 with no output = "no matches" (both rg and grep): make that explicit for the model.
      if (/^\(exit 1\)\n\(no output\)$/.test(out.trim())) return "(no matches)";
      return cap(out);
    },
  },

  glob: {
    schema: {
      type: "function",
      function: {
        name: "glob",
        description:
          "Find files by glob pattern (supports **, *, ?). e.g. '**/*.mjs', 'src/**/*.ts', '*.json'. " +
          "Returns matching paths (relative to the search root), sorted. Skips node_modules/.git/build dirs.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "glob, e.g. '**/*.ts'" },
            path: { type: "string", description: "root dir to search from, defaults to cwd" },
          },
          required: ["pattern"],
        },
      },
    },
    needsApproval: false,
    preview: (a) => a.pattern + (a.path ? ` in ${a.path}` : ""),
    async run(a, ctx) {
      const root = a.path ? resolve(ctx, a.path) : ctx.cwd;
      if (!fs.existsSync(root)) return `ERROR: not found ${a.path || "."}`;
      const re = globToRegExp(a.pattern);
      const hits = walkFiles(root).filter((rel) => re.test(rel)).sort();
      if (!hits.length) return `(no files match ${a.pattern})`;
      return cap(hits.join("\n") + `\n\n(${hits.length} file${hits.length > 1 ? "s" : ""})`);
    },
  },

  todo_write: {
    schema: {
      type: "function",
      function: {
        name: "todo_write",
        description:
          "Maintain a task checklist for the CURRENT request. Pass the FULL list each time (it replaces the previous one). " +
          "Use it for any multi-step task: write the plan up front, then re-send the list flipping each item to 'in_progress' then 'completed' as you go. " +
          "Keep exactly one item 'in_progress' at a time. Skip it for trivial one-step tasks.",
        parameters: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              description: "the full, ordered task list",
              items: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                },
                required: ["content", "status"],
              },
            },
          },
          required: ["todos"],
        },
      },
    },
    needsApproval: false,
    preview: (a) => `${(a.todos || []).length} item(s)`,
    async run(a, ctx) {
      const todos = Array.isArray(a.todos) ? a.todos : [];
      ctx.todos = todos; // stash for the UI to render
      if (ctx.onEvent) ctx.onEvent({ type: "todos", todos });
      const mark = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };
      const done = todos.filter((t) => t.status === "completed").length;
      const body = todos.map((t) => `  ${mark[t.status] || "[ ]"} ${t.content}`).join("\n");
      return `Updated todo list (${done}/${todos.length} done):\n${body}`;
    },
  },

  bash: {
    schema: {
      type: "function",
      function: {
        name: "bash",
        description:
          "Run a bash shell command in the project cwd. Use for build, test, git, installing deps, running code...",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeout_ms: { type: "number" },
          },
          required: ["command"],
        },
      },
    },
    needsApproval: true,
    preview: (a) => a.command,
    async run(a, ctx) {
      return cap(await sh(a.command, ctx.cwd, a.timeout_ms || 120000));
    },
  },
};

export function toolSchemas(extra = []) {
  return [...Object.values(TOOLS).map((t) => t.schema), ...extra];
}
