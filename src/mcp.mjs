// Minimal MCP client (zero-dep). Loads tools from MCP servers and exposes them as tawx tools.
// Supports Streamable-HTTP servers (POST JSON-RPC, SSE or JSON responses) and stdio servers.
// Config: ~/.taw/mcp.json or <cwd>/.taw/mcp.json — shape: { "mcpServers": { name: def } } or { name: def }.
//   HTTP def:  { "type": "http", "url": "...", "headers": { "Authorization": "Bearer ..." } }
//   stdio def: { "command": "npx", "args": ["-y", "@playwright/mcp"], "env": { } }
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

function readConfigs(cwd) {
  const servers = {};
  for (const f of [path.join(os.homedir(), ".taw", "mcp.json"), path.join(cwd, ".taw", "mcp.json")]) {
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      const map = j.mcpServers || j;
      for (const [name, def] of Object.entries(map)) servers[name] = def;
    } catch { /* ignore bad config */ }
  }
  return servers;
}

function parseSse(text) {
  const msgs = [];
  for (const line of text.split("\n")) {
    const l = line.trimEnd();
    if (!l.startsWith("data:")) continue;
    const d = l.slice(5).trim();
    if (d && d !== "[DONE]") { try { msgs.push(JSON.parse(d)); } catch { /* skip */ } }
  }
  return msgs;
}

// --- Streamable HTTP transport ---
function httpTransport(def) {
  const sess = { id: null };
  return async function rpc(message, timeoutMs = 60000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(def.url, {
        method: "POST",
        signal: ac.signal,
        headers: {
          ...(def.headers || {}),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sess.id ? { "mcp-session-id": sess.id } : {}),
        },
        body: JSON.stringify(message),
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) sess.id = sid;
      if (message.id == null) { await res.text().catch(() => {}); return null; } // notification
      const ct = res.headers.get("content-type") || "";
      const text = await res.text();
      const msgs = ct.includes("text/event-stream") ? parseSse(text) : (() => { try { return [JSON.parse(text)]; } catch { return []; } })();
      const hit = msgs.find((m) => m.id === message.id) || msgs[msgs.length - 1];
      if (!hit) throw new Error(`no JSON-RPC response (HTTP ${res.status}): ${text.slice(0, 160)}`);
      if (hit.error) throw new Error(hit.error.message || JSON.stringify(hit.error));
      return hit.result;
    } finally {
      clearTimeout(t);
    }
  };
}

// --- stdio transport ---
function stdioTransport(def) {
  const child = spawn(def.command, def.args || [], {
    env: { ...process.env, ...(def.env || {}) },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buf = "";
  const waiters = new Map();
  const pending = new Map(); // responses that arrived before their waiter was registered
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id == null) continue;
      if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
      else pending.set(m.id, m); // buffer until rpc() registers (avoids a resolve-microtask race)
    }
  });
  const settle = (m, res, rej) => (m.error ? rej(new Error(m.error.message || "MCP error")) : res(m.result));
  return async function rpc(message, timeoutMs = 60000) {
    child.stdin.write(JSON.stringify(message) + "\n");
    if (message.id == null) return null;
    if (pending.has(message.id)) { const m = pending.get(message.id); pending.delete(message.id); return new Promise((res, rej) => settle(m, res, rej)); }
    return new Promise((res, rej) => {
      const t = setTimeout(() => { waiters.delete(message.id); rej(new Error("stdio MCP timeout")); }, timeoutMs);
      waiters.set(message.id, (m) => { clearTimeout(t); settle(m, res, rej); });
    });
  };
}

let _id = 1;

// Connect to every configured MCP server and return their tools as tawx tool objects.
export async function loadMcpTools(cwd, onEvent = () => {}) {
  const servers = readConfigs(cwd);
  const tools = [];
  for (const [name, def] of Object.entries(servers)) {
    try {
      const rpc = def.command && !def.url ? stdioTransport(def) : httpTransport(def);
      const call = (method, params) => rpc({ jsonrpc: "2.0", id: _id++, method, params });
      const notify = (method, params) => rpc({ jsonrpc: "2.0", method, params });
      await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "tawx", version: "0.1" } });
      await notify("notifications/initialized", {});
      const listed = await call("tools/list", {});
      for (const mt of (listed?.tools || [])) {
        tools.push({
          schema: {
            type: "function",
            function: {
              name: mt.name,
              description: `[mcp:${name}] ${(mt.description || "").slice(0, 900)}`,
              parameters: mt.inputSchema || { type: "object", properties: {} },
            },
          },
          needsApproval: true,
          preview: (a) => JSON.stringify(a || {}).slice(0, 80),
          async run(args) {
            const r = await call("tools/call", { name: mt.name, arguments: args || {} });
            if (!r) return "(no result)";
            const text = (r.content || []).map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : JSON.stringify(c))).join("\n");
            return (r.isError ? "MCP tool error: " : "") + (text || "(empty)");
          },
        });
      }
      onEvent({ type: "mcp", server: name, count: (listed?.tools || []).length });
    } catch (e) {
      onEvent({ type: "mcp_error", server: name, error: e.message });
    }
  }
  return tools;
}
