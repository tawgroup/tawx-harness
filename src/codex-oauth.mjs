// Minimal ChatGPT Plus/Pro Codex OAuth, adapted from PI's OpenAI Codex flow.
import http from "node:http";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) => buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

function decodeJwt(token) {
  try {
    const [, payload] = token.split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch { return null; }
}

export function codexAccountId(accessToken) {
  const payload = decodeJwt(accessToken);
  const id = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  if (!id) throw new Error("Failed to extract ChatGPT account id from Codex token");
  return id;
}

function normalizeToken(json) {
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error(`Codex token response missing fields: ${JSON.stringify(json)}`);
  }
  const access = json.access_token;
  return { type: "oauth", access, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000, accountId: codexAccountId(access) };
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Codex token request failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  return normalizeToken(await res.json());
}

export async function refreshCodexOAuth(oauth) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: oauth.refresh, client_id: CLIENT_ID });
}

async function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url) {
  try {
    if (process.platform === "darwin") execFileSync("open", [url], { stdio: "ignore" });
    else if (process.platform === "win32") execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    else execFileSync("xdg-open", [url], { stdio: "ignore" });
  } catch { /* user can copy URL */ }
}

function startServer(state) {
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "", "http://localhost");
    if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) {
      res.writeHead(400, { "content-type": "text/html" });
      res.end("<h1>Codex login failed</h1>");
      return;
    }
    const code = url.searchParams.get("code");
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h1>Codex login complete</h1><p>You can close this tab.</p>");
    settle(code || "");
  });
  return new Promise((resolve) => {
    server.listen(1455, "127.0.0.1", () => resolve({ wait: () => done, close: () => server.close() }));
    server.on("error", () => resolve({ wait: async () => "", close: () => {} }));
  });
}

function parseCode(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  try { return new URL(s).searchParams.get("code") || s; } catch { /* not url */ }
  if (s.includes("code=")) return new URLSearchParams(s).get("code") || s;
  return s;
}

export async function loginCodexBrowser({ ask }) {
  const { verifier, challenge } = await pkce();
  const state = crypto.randomBytes(16).toString("hex");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "tawx");

  const server = await startServer(state);
  console.log(`Open this URL if the browser does not open:\n${url}\n`);
  openBrowser(url.toString());
  // Do NOT prompt while the callback server is waiting. A live readline question cannot be
  // cancelled cleanly when the browser callback wins, which leaves the TUI looking "stuck".
  let code = await Promise.race([server.wait(), sleep(120_000).then(() => "")]);
  if (!code) code = await ask("Paste authorization code/full redirect URL if browser callback failed");
  server.close();
  code = parseCode(code);
  if (!code) throw new Error("Missing authorization code");
  return tokenRequest({ grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: REDIRECT_URI });
}

export async function loginCodexDeviceCode() {
  const res = await fetch(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!res.ok) throw new Error(`Codex device login failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  const device = await res.json();
  console.log(`Open: ${DEVICE_VERIFICATION_URI}`);
  console.log(`Code: ${device.user_code}`);
  openBrowser(DEVICE_VERIFICATION_URI);
  const started = Date.now();
  const intervalMs = Math.max(1, Number(device.interval || 5)) * 1000;
  while (Date.now() - started < 15 * 60 * 1000) {
    await sleep(intervalMs);
    const poll = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
    });
    if (poll.ok) {
      const j = await poll.json();
      return tokenRequest({ grant_type: "authorization_code", client_id: CLIENT_ID, code: j.authorization_code, code_verifier: j.code_verifier, redirect_uri: DEVICE_REDIRECT_URI });
    }
    if (![403, 404].includes(poll.status)) throw new Error(`Codex device poll failed (${poll.status}): ${await poll.text().catch(() => poll.statusText)}`);
  }
  throw new Error("Codex device login timed out");
}
