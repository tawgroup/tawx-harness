// tawx-harness config — resolves provider, auth, base URL, model from env/.env/auth.json/CLI.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Local installed version (from package.json). Source of truth for update checks.
export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8")).version || "0.0.0"; }
  catch { return "0.0.0"; }
})();

// Repo on GitHub — used by the install one-liner and the update check.
export const REPO_RAW = "https://raw.githubusercontent.com/tawgroup/tawx-harness/main";
export const UPDATE_CMD = `curl -fsSL ${REPO_RAW}/install.sh | bash`;

// a > b for dotted numeric versions ("0.2.0" > "0.1.9"). Non-numeric parts → 0.
export function versionGt(a, b) {
  const pa = String(a).split("."), pb = String(b).split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// Fetch the latest published version from the repo's package.json. Returns the
// version string if it is NEWER than the local one, else null (also null on any
// network/parse failure or offline — the caller stays silent).
export async function checkForUpdate(timeoutMs = 1500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`${REPO_RAW}/package.json`, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    if (!res.ok) return null;
    const latest = (await res.json())?.version;
    return latest && versionGt(latest, VERSION) ? latest : null;
  } catch {
    return null;
  }
}

export const TAW_DIR = path.join(os.homedir(), ".taw");
export const AUTH_PATH = path.join(TAW_DIR, "auth.json");
export const PI_AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");

// ---- minimal .env loader (zero-dep) ----
function loadDotenv(dir) {
  const p = path.join(dir, ".env");
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotenv(process.cwd());
loadDotenv(TAW_DIR);

function readJson(p) {
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function readAuth() {
  const auth = readJson(AUTH_PATH);
  // If the user already logged into PI's ChatGPT Codex subscription, reuse it.
  const piAuth = readJson(PI_AUTH_PATH);
  const piCodex = piAuth["openai-codex"];
  if (piCodex && !auth.providers?.codex?.oauth) {
    auth.providers = { ...(auth.providers || {}) };
    auth.providers.codex = { ...(auth.providers.codex || {}), oauth: piCodex };
  }
  return auth;
}

export function saveAuth(auth) {
  fs.mkdirSync(TAW_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(AUTH_PATH, 0o600); } catch { /* ignore */ }
}

export const AUTH = readAuth();

export const PROVIDERS = {
  opencode: {
    type: "openai",
    label: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    keyEnv: "OPENCODE_API_KEY",
    defaultModel: "glm-5",
    models: [
      "glm-5.1", "glm-5",
      "deepseek-v4-pro", "deepseek-v4-flash",
      "qwen3.7-max", "qwen3.6-plus", "qwen3.5-plus",
      "kimi-k2.6", "kimi-k2.5",
      "minimax-m2.7", "minimax-m2.5",
      "mimo-v2.5-pro", "mimo-v2.5",
    ],
  },
  codex: {
    type: "codex",
    label: "ChatGPT Plus/Pro (Codex Subscription)",
    baseUrl: "https://chatgpt.com/backend-api",
    keyEnv: "OPENAI_CODEX_ACCESS_TOKEN",
    defaultModel: "gpt-5.5",
    models: ["gpt-5.5", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5-codex"],
  },
  claude: {
    type: "claude-cli",
    label: "Claude Code CLI (subscription)",
    baseUrl: "",
    keyEnv: "",
    defaultModel: "sonnet",
    models: ["sonnet", "opus", "haiku"],
  },
};

export const PROVIDER = process.env.TAW_PROVIDER || AUTH.active || "opencode";
export const PROVIDER_CONFIG = PROVIDERS[PROVIDER] || PROVIDERS.opencode;
export const SAVED_PROVIDER = AUTH.providers?.[PROVIDER] || {};

export const BASE_URL =
  process.env.TAW_BASE_URL || SAVED_PROVIDER.baseUrl || PROVIDER_CONFIG.baseUrl;

export const API_KEY =
  process.env.TAW_API_KEY ||
  (PROVIDER_CONFIG.keyEnv ? process.env[PROVIDER_CONFIG.keyEnv] : "") ||
  SAVED_PROVIDER.apiKey ||
  SAVED_PROVIDER.oauth?.access ||
  // Back-compat for old opencode setup.
  (PROVIDER === "opencode" ? process.env.OPENCODE_API_KEY : "") ||
  "";

export const DEFAULT_MODEL = SAVED_PROVIDER.model || process.env.TAW_MODEL || PROVIDER_CONFIG.defaultModel;
export const MODELS = PROVIDER_CONFIG.models;
export const GO_MODELS = PROVIDERS.opencode.models; // backwards-compatible export

export const MAX_STEPS = Number(process.env.TAW_MAX_STEPS || 40);
export const MAX_TOKENS = Number(process.env.TAW_MAX_TOKENS || 8192);
export const REQUEST_TIMEOUT_MS = Number(process.env.TAW_REQUEST_TIMEOUT || 180000);

// ---- Context window per model (tokens) — drives auto-compaction + footer % ----
// pi-style: compact when used > window - reserve, keeping the last keepTokens.
// These are the built-in DEFAULTS. Providers' /models endpoints don't expose a
// context-length field, so there's nothing to fetch live — instead the numbers
// live in an editable JSON at ~/.taw/context-windows.json that overrides (and is
// checked before) these built-ins. Edit that file to tweak a window; no code
// change / release needed.
const CONTEXT_WINDOWS = [
  [/gpt-5|codex/i, 272000],
  [/claude|sonnet|opus|haiku/i, 200000],
  [/glm|kimi|qwen|deepseek|minimax|mimo|hy3/i, 200000], // opencode models
];

export const CONTEXT_WINDOWS_PATH = path.join(TAW_DIR, "context-windows.json");

// Load user overrides from ~/.taw/context-windows.json. Shape is a flat object
// { "<regex source>": <tokens> } — keys are matched (case-insensitive) against
// the model id in insertion order, BEFORE the built-ins, so the first match wins.
// Keys starting with "_" (e.g. "_comment") are ignored. Seeds an editable example
// file on first run so it's discoverable. Resolved once at startup.
function loadContextOverrides() {
  try {
    if (!fs.existsSync(CONTEXT_WINDOWS_PATH)) {
      const seed = {
        _comment: "Override/add model→context-window (tokens). Key = regex matched (case-insensitive) against the model id; first match wins and these are checked BEFORE the built-in defaults. Edit freely — no code change needed. Env TAW_CONTEXT_WINDOW overrides everything.",
        "gpt-5.5": 272000,
      };
      fs.mkdirSync(TAW_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(CONTEXT_WINDOWS_PATH, JSON.stringify(seed, null, 2) + "\n", { mode: 0o600 });
    }
    const obj = readJson(CONTEXT_WINDOWS_PATH);
    const entries = [];
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("_")) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      try { entries.push([new RegExp(k, "i"), n]); } catch { /* skip invalid regex key */ }
    }
    return entries;
  } catch {
    return [];
  }
}
const CONTEXT_OVERRIDES = loadContextOverrides();

export function contextWindowFor(model = "") {
  if (process.env.TAW_CONTEXT_WINDOW) return Number(process.env.TAW_CONTEXT_WINDOW);
  for (const [re, n] of CONTEXT_OVERRIDES) if (re.test(model)) return n; // user file first
  for (const [re, n] of CONTEXT_WINDOWS) if (re.test(model)) return n;   // then built-ins
  return 128000; // safe default
}
export const COMPACT_RESERVE = Number(process.env.TAW_COMPACT_RESERVE || 16384); // headroom kept free
export const COMPACT_KEEP_TOKENS = Number(process.env.TAW_COMPACT_KEEP || 20000); // recent tail kept verbatim
export const COMPACT_ENABLED = process.env.TAW_COMPACT !== "0";
export const TOOL_OUTPUT_CAP = Number(process.env.TAW_TOOL_CAP || 30000);

export function assertKey() {
  if (PROVIDER_CONFIG.type === "claude-cli") return;
  if (!API_KEY) {
    throw new Error(
      `No auth for provider "${PROVIDER}". Run: tawx login ${PROVIDER}\n` +
        (PROVIDER === "codex"
          ? "Codex uses ChatGPT Plus/Pro OAuth subscription login (not an OpenAI API key)."
          : `Or set ${PROVIDER_CONFIG.keyEnv}=... / TAW_API_KEY=... in env or .env.`),
    );
  }
}
