// Tool registry — the model's hands. Each tool: {schema, run(args, ctx)}.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

const UNDO_DIR = path.join(os.homedir(), ".taw", "undo");

function remember(ctx, files) {
  const touched = [];
  for (const p of files) {
    const f = resolve(ctx, p);
    const exists = fs.existsSync(f);
    touched.push({ path: p, exists, content: exists && fs.statSync(f).isFile() ? fs.readFileSync(f, "utf8") : null });
  }
  fs.mkdirSync(UNDO_DIR, { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(path.join(UNDO_DIR, `${id}.json`), JSON.stringify({ cwd: ctx.cwd, touched }, null, 2) + "\n", { mode: 0o600 });
  return id;
}

function latestUndo() {
  try {
    return fs.readdirSync(UNDO_DIR).filter((f) => f.endsWith(".json")).sort().at(-1);
  } catch { return null; }
}

function fileDiff(file, before, after) {
  const a = String(before ?? "").split("\n"), b = String(after ?? "").split("\n");
  const out = [`--- a/${file}`, `+++ b/${file}`];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`-${a[i]}`);
    if (b[i] !== undefined) out.push(`+${b[i]}`);
  }
  return out.join("\n");
}

// Parse a unified diff into [{ path, hunks: [{ lines: [{op, text}] }] }].
// Tolerant of: a//b/ prefixes or none, /dev/null, stray "diff --git" lines,
// and "\ No newline at end of file" markers (which cheap models rarely emit).
function parsePatch(patch) {
  const files = [];
  let cur = null, hunk = null;
  const lines = String(patch).split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // drop trailing-newline artifact
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (line.startsWith("diff --git")) { cur = null; hunk = null; continue; }
    if ((m = line.match(/^--- (.+?)\s*$/))) {
      const next = lines[i + 1] || "";
      const t = next.match(/^\+\+\+ (.+?)\s*$/);
      const strip = (s) => s.replace(/^[ab]\//, "");
      const target = t && t[1] !== "/dev/null" ? strip(t[1]) : strip(m[1]);
      cur = { path: target, hunks: [] };
      files.push(cur);
      if (t) i++;            // consume the matching +++ line
      hunk = null;
      continue;
    }
    if (line.startsWith("+++ ")) continue;             // stray header
    if (line.startsWith("@@")) {
      if (!cur) { cur = { path: null, hunks: [] }; files.push(cur); }
      hunk = { lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (line === "\\ No newline at end of file") continue;
    if (!hunk) continue;
    const op = line[0];
    if (op === " " || op === "+" || op === "-") hunk.lines.push({ op, text: line.slice(1) });
    else if (line === "") hunk.lines.push({ op: " ", text: "" }); // blank context line
  }
  return files.filter((f) => f.hunks.length);
}

// Locate `needle` (the hunk's old lines) in `haystack`, getting progressively
// more forgiving: exact → ignore trailing whitespace → ignore all indentation.
// Returns the start index, or -1 if no normalization level matches.
function findBlock(haystack, needle, start) {
  if (needle.length === 0) return Math.min(start, haystack.length);
  const norms = [(s) => s, (s) => s.replace(/\s+$/, ""), (s) => s.trim()];
  for (const norm of norms) {
    const N = needle.map(norm);
    for (let i = start; i + N.length <= haystack.length; i++) {
      let ok = true;
      for (let j = 0; j < N.length; j++) if (norm(haystack[i + j]) !== N[j]) { ok = false; break; }
      if (ok) return i;
    }
  }
  return -1;
}

// Apply parsed hunks to file text in pure JS — no git apply, so it survives
// wrong @@ line numbers and missing no-newline markers. Preserves the file's
// original trailing-newline style.
function applyParsedToText(text, hunks, label) {
  const hadTrailing = text === "" ? true : text.endsWith("\n"); // new files get a trailing newline, like git
  const lines = text.length ? text.replace(/\n$/, "").split("\n") : [];
  let cursor = 0;
  for (const h of hunks) {
    const oldLines = h.lines.filter((l) => l.op === " " || l.op === "-").map((l) => l.text);
    const newLines = h.lines.filter((l) => l.op === " " || l.op === "+").map((l) => l.text);
    let at = findBlock(lines, oldLines, cursor);
    if (at < 0) at = findBlock(lines, oldLines, 0); // hunks may be out of order
    if (at < 0) throw new Error(`hunk did not match in ${label}:\n${oldLines.join("\n")}`);
    lines.splice(at, oldLines.length, ...newLines);
    cursor = at + newLines.length;
  }
  return lines.join("\n") + (hadTrailing ? "\n" : "");
}

// Reduce an HTML document to readable text: drop scripts/styles/comments, turn
// block-level closers and <br>/<li> into line breaks, strip the rest of the
// tags, decode common entities, and collapse whitespace. Keeps web_fetch output
// token-cheap (raw markup is ~90% noise for an LLM).
function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|tr|h[1-6]|section|article|header|footer|ul|ol|pre|blockquote|table|head|title)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  const ent = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
  s = s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ent[m]).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  s = s.replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
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
      const id = remember(ctx, [a.path]);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, a.content);
      return `OK: wrote ${a.path} (${a.content.length} bytes, undo: ${id})`;
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
      const id = remember(ctx, [a.path]);
      fs.writeFileSync(f, next);
      return `OK: edited ${a.path} (${a.replace_all ? count : 1} place${a.replace_all && count > 1 ? "s" : ""}, undo: ${id})`;
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


  diff: {
    schema: {
      type: "function",
      function: {
        name: "diff",
        description: "Preview a simple text replacement as a unified diff without changing files.",
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
    needsApproval: false,
    preview: (a) => a.path,
    async run(a, ctx) {
      const f = resolve(ctx, a.path);
      if (!fs.existsSync(f)) return `ERROR: not found ${a.path}`;
      const before = fs.readFileSync(f, "utf8");
      const count = before.split(a.old_string).length - 1;
      if (count === 0) return `ERROR: old_string not found in ${a.path}`;
      if (count > 1 && !a.replace_all) return `ERROR: old_string matches ${count} places. Add replace_all=true or use a longer string.`;
      const after = a.replace_all ? before.split(a.old_string).join(a.new_string) : before.replace(a.old_string, a.new_string);
      return cap(fileDiff(a.path, before, after));
    },
  },

  apply_patch: {
    schema: {
      type: "function",
      function: {
        name: "apply_patch",
        description: "Apply a unified diff patch. Saves an undo checkpoint first; use undo_last_change to revert.",
        parameters: {
          type: "object",
          properties: {
            patch: { type: "string", description: "unified diff, usually with --- a/file and +++ b/file headers" },
          },
          required: ["patch"],
        },
      },
    },
    needsApproval: true,
    preview: (a) => String(a.patch).split("\n").slice(0, 12).join("\n"),
    async run(a, ctx) {
      const files = parsePatch(a.patch);
      if (!files.length) return "ERROR: no file hunks found in patch";
      const plan = [];
      for (const file of files) {
        if (!file.path) return "ERROR: patch hunk has no file path (missing --- / +++ header)";
        const f = resolve(ctx, file.path);
        const before = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
        try { plan.push({ path: file.path, f, after: applyParsedToText(before, file.hunks, file.path) }); }
        catch (e) { return `ERROR: ${e.message}`; }
      }
      const id = remember(ctx, plan.map((p) => p.path));
      for (const p of plan) {
        fs.mkdirSync(path.dirname(p.f), { recursive: true });
        fs.writeFileSync(p.f, p.after);
      }
      return `OK: applied patch to ${plan.map((p) => p.path).join(", ")} (undo: ${id})`;
    },
  },

  undo_last_change: {
    schema: {
      type: "function",
      function: {
        name: "undo_last_change",
        description: "Undo the most recent write_file/edit_file/apply_patch change saved by tawx.",
        parameters: { type: "object", properties: {} },
      },
    },
    needsApproval: true,
    preview: () => "restore last tawx checkpoint",
    async run(_a, ctx) {
      const file = latestUndo();
      if (!file) return "ERROR: no undo checkpoint found";
      const full = path.join(UNDO_DIR, file);
      const snap = JSON.parse(fs.readFileSync(full, "utf8"));
      if (snap.cwd !== ctx.cwd) return `ERROR: latest undo belongs to ${snap.cwd}, current cwd is ${ctx.cwd}`;
      for (const t of snap.touched.reverse()) {
        const f = resolve(ctx, t.path);
        if (t.exists) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t.content ?? ""); }
        else if (fs.existsSync(f)) fs.rmSync(f, { recursive: true, force: true });
      }
      fs.unlinkSync(full);
      return `OK: reverted ${snap.touched.length} file(s)`;
    },
  },

  web_fetch: {
    schema: {
      type: "function",
      function: {
        name: "web_fetch",
        description:
          "Fetch an http(s) URL and return it as clean readable text (HTML stripped to prose, length-capped). Use to read external docs, API references, GitHub issues/PRs or release notes when the answer isn't in the repo. Prefer local docs, `<cmd> --help`, and grep FIRST; reach for the web only when you need an external source and know (or can guess) the URL.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "http:// or https:// URL" },
            timeout_ms: { type: "number", description: "request timeout, default 20000" },
          },
          required: ["url"],
        },
      },
    },
    needsApproval: true,
    preview: (a) => a.url,
    async run(a, _ctx) {
      const url = String(a.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return "ERROR: url must start with http:// or https://";
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), a.timeout_ms || 20000);
      try {
        const res = await fetch(url, {
          redirect: "follow",
          signal: ctrl.signal,
          headers: { "user-agent": "tawx-harness (+https://github.com/tawgroup/tawx-harness)", accept: "text/html,text/plain,*/*" },
        });
        const ctype = (res.headers.get("content-type") || "").split(";")[0].trim();
        const raw = await res.text();
        const body = /html/i.test(ctype) ? htmlToText(raw) : raw;
        return cap(`# ${url}\n[${res.status}${ctype ? " " + ctype : ""}]\n\n${body || "(empty body)"}`);
      } catch (e) {
        return `ERROR: fetch failed: ${e.name === "AbortError" ? `timeout after ${a.timeout_ms || 20000}ms` : e.message}`;
      } finally {
        clearTimeout(timer);
      }
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
