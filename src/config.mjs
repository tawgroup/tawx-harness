// tawx-harness config — resolves provider, API key, base URL, model from env/.env/auth.json/CLI.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const TAW_DIR = path.join(os.homedir(), ".taw");
export const AUTH_PATH = path.join(TAW_DIR, "auth.json");

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

function readAuth() {
  try {
    if (!fs.existsSync(AUTH_PATH)) return {};
    return JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
  } catch {
    return {};
  }
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
    type: "openai",
    label: "OpenAI / Codex",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5-codex",
    models: ["gpt-5-codex", "gpt-5", "gpt-4.1", "gpt-4o"],
  },
  claude: {
    type: "anthropic",
    label: "Claude / Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-5",
    models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5", "claude-3-5-sonnet-latest"],
  },
};

export const PROVIDER = process.env.TAW_PROVIDER || AUTH.active || "opencode";
export const PROVIDER_CONFIG = PROVIDERS[PROVIDER] || PROVIDERS.opencode;
const saved = AUTH.providers?.[PROVIDER] || {};

export const BASE_URL =
  process.env.TAW_BASE_URL || saved.baseUrl || PROVIDER_CONFIG.baseUrl;

export const API_KEY =
  process.env.TAW_API_KEY ||
  process.env[PROVIDER_CONFIG.keyEnv] ||
  saved.apiKey ||
  // Back-compat for old opencode setup.
  (PROVIDER === "opencode" ? process.env.OPENCODE_API_KEY : "") ||
  "";

export const DEFAULT_MODEL = process.env.TAW_MODEL || saved.model || PROVIDER_CONFIG.defaultModel;
export const MODELS = PROVIDER_CONFIG.models;
export const GO_MODELS = PROVIDERS.opencode.models; // backwards-compatible export

export const MAX_STEPS = Number(process.env.TAW_MAX_STEPS || 40);
export const MAX_TOKENS = Number(process.env.TAW_MAX_TOKENS || 8192);
export const COMPACT_THRESHOLD = Number(process.env.TAW_COMPACT_THRESHOLD || 60000);
export const REQUEST_TIMEOUT_MS = Number(process.env.TAW_REQUEST_TIMEOUT || 180000);
export const TOOL_OUTPUT_CAP = Number(process.env.TAW_TOOL_CAP || 30000);

export function assertKey() {
  if (!API_KEY) {
    throw new Error(
      `No API key for provider "${PROVIDER}". Run: tawx login\n` +
        `Or set ${PROVIDER_CONFIG.keyEnv}=... / TAW_API_KEY=... in env or .env.`,
    );
  }
}
