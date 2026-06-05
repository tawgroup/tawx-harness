// Model clients: OpenAI-compatible chat/completions + Anthropic Messages + Claude Code CLI.
import { spawn } from "node:child_process";
import { BASE_URL, API_KEY, MAX_TOKENS, REQUEST_TIMEOUT_MS, PROVIDER_CONFIG, PROVIDER, AUTH, SAVED_PROVIDER, saveAuth } from "./config.mjs";
import { codexAccountId, refreshCodexOAuth } from "./codex-oauth.mjs";

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

function isFatal(status, type, msg) {
  return (
    status === 401 ||
    status === 403 ||
    /CreditsError|ModelError|Insufficient|unauthor|invalid api key|authentication/i.test(`${type} ${msg}`)
  );
}

// Parse OpenAI-compatible streaming SSE response, emitting content deltas via onToken.
async function parseOpenAiStream(res, onToken, bump) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  const toolCalls = [];
  let finish_reason, usage = {}, cost;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bump();
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      if (j.usage) usage = j.usage;
      if (j.cost != null) cost = j.cost;
      const ch = (j.choices || [])[0];
      if (!ch) continue;
      if (ch.finish_reason) finish_reason = ch.finish_reason;
      const d = ch.delta || {};
      if (d.content) { content += d.content; onToken(d.content); }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          toolCalls[i] = toolCalls[i] || { id: "", function: { name: "", arguments: "" } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name = tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const message = { role: "assistant", content };
  const calls = toolCalls
    .filter(Boolean)
    .map((tc, i) => ({
      id: tc.id || `call_${i}`,
      type: "function",
      function: { name: tc.function.name, arguments: tc.function.arguments || "{}" },
    }));
  if (calls.length) message.tool_calls = calls;
  return { message, finish_reason, usage, cost };
}

// Map our neutral content (string | [{type:"text"|"image"}]) to OpenAI's shape.
function toOpenAi(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const content = m.content.map((p) =>
      p.type === "image"
        ? { type: "image_url", image_url: { url: `data:${p.mime};base64,${p.data}` } }
        : { type: "text", text: p.text },
    );
    return { ...m, content };
  });
}

async function chatOpenAi({ messages, tools, model, maxTokens, signal, onToken }) {
  const stream = typeof onToken === "function" && !process.env.TAWX_NO_STREAM;
  const body = { model, messages: toOpenAi(messages), max_tokens: maxTokens };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  let lastErr;
  let emitted = false;
  const tokenOnce = (t) => { emitted = true; onToken(t); };

  for (let attempt = 0; attempt < 6; attempt++) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    let timer = setTimeout(() => ctl.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
    };

    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        let j; try { j = JSON.parse(text); } catch { /* not json */ }
        const err = (j && (j.error || j)) || {};
        const type = err.type || `HTTP ${res.status}`;
        const msg = err.message || text.slice(0, 300);
        if (isFatal(res.status, type, msg)) throw new Error(`${type}: ${msg}`);
        lastErr = new Error(`${type}: ${msg}`);
        await SLEEP(800 * (attempt + 1));
        continue;
      }

      if (stream) return await parseOpenAiStream(res, tokenOnce, bump);

      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch {
        lastErr = new Error(`Bad response (${res.status}): ${text.slice(0, 300)}`);
        await SLEEP(500 * (attempt + 1));
        continue;
      }
      if (json.type === "error" || json.error) {
        const err = json.error || json;
        const type = err.type || "Error";
        const msg = err.message || JSON.stringify(err);
        if (isFatal(res.status, type, msg)) throw new Error(`${type}: ${msg}`);
        lastErr = new Error(`${type}: ${msg}`);
        await SLEEP(800 * (attempt + 1));
        continue;
      }
      const choice = (json.choices || [])[0] || {};
      const message = choice.message || {};
      if (Array.isArray(message.tool_calls)) {
        message.tool_calls = message.tool_calls.map((tc, i) => ({
          id: tc.id || `call_${i}`,
          type: "function",
          function: { name: tc.function?.name, arguments: tc.function?.arguments ?? "{}" },
        }));
      }
      return { message, finish_reason: choice.finish_reason, usage: json.usage || {}, cost: json.cost };
    } catch (e) {
      if (signal?.aborted) throw e;
      if (emitted) throw e;
      lastErr = new Error(`request error/timeout: ${e.message}`);
      await SLEEP(500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr || new Error("request failed");
}

function toAnthropic(messages) {
  let system = "";
  const out = [];
  for (const m of messages) {
    if (m.role === "system") { system += (system ? "\n\n" : "") + m.content; continue; }
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content || "") }],
      });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const content = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { /* ignore */ }
        content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    const content = Array.isArray(m.content)
      ? m.content.map((p) =>
          p.type === "image"
            ? { type: "image", source: { type: "base64", media_type: p.mime, data: p.data } }
            : { type: "text", text: p.text },
        )
      : String(m.content || "");
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content });
  }
  return { system, messages: out };
}

function toolsToAnthropic(tools = []) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description || "",
    input_schema: t.function.parameters || { type: "object", properties: {} },
  }));
}

async function chatAnthropic({ messages, tools, model, maxTokens, signal }) {
  const { system, messages: amessages } = toAnthropic(messages);
  const body = { model, max_tokens: maxTokens, messages: amessages };
  if (system) body.system = system;
  const atools = toolsToAnthropic(tools);
  if (atools.length) body.tools = atools;

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE_URL}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = null; }
      if (!res.ok) {
        const err = json?.error || {};
        const type = err.type || `HTTP ${res.status}`;
        const msg = err.message || text.slice(0, 300);
        if (isFatal(res.status, type, msg)) throw new Error(`${type}: ${msg}`);
        lastErr = new Error(`${type}: ${msg}`);
        await SLEEP(800 * (attempt + 1));
        continue;
      }
      const blocks = json?.content || [];
      const textOut = blocks.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
      const tool_calls = blocks.filter((b) => b.type === "tool_use").map((b, i) => ({
        id: b.id || `call_${i}`,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      const message = { role: "assistant", content: textOut };
      if (tool_calls.length) message.tool_calls = tool_calls;
      return { message, finish_reason: json?.stop_reason, usage: json?.usage || {} };
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = new Error(`request error/timeout: ${e.message}`);
      await SLEEP(500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  throw lastErr || new Error("request failed");
}

function responsesTools(tools = []) {
  return tools.map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description || "",
    parameters: t.function.parameters || { type: "object", properties: {} },
    strict: false,
  }));
}

function toCodexInput(messages) {
  const input = [];
  let instructions = "You are a helpful assistant.";
  for (const m of messages) {
    if (m.role === "system") { instructions = m.content || instructions; continue; }
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: String(m.content || "") });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      if (m.content) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const tc of m.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments || "{}",
        });
      }
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    const textType = role === "assistant" ? "output_text" : "input_text";
    const content = Array.isArray(m.content)
      ? m.content.map((p) =>
          p.type === "image"
            ? { type: "input_image", image_url: `data:${p.mime};base64,${p.data}` }
            : { type: textType, text: p.text },
        )
      : [{ type: textType, text: String(m.content || "") }];
    input.push({ type: "message", role, content });
  }
  return { instructions, input };
}

function codexUrl() {
  const raw = BASE_URL.replace(/\/+$/, "");
  if (raw.endsWith("/codex/responses")) return raw;
  if (raw.endsWith("/codex")) return `${raw}/responses`;
  return `${raw}/codex/responses`;
}

async function codexToken() {
  let oauth = SAVED_PROVIDER.oauth;
  if (oauth?.refresh && oauth.expires && oauth.expires < Date.now() + 60_000) {
    oauth = await refreshCodexOAuth(oauth);
    const next = { ...AUTH, providers: { ...(AUTH.providers || {}) } };
    next.providers[PROVIDER] = { ...(next.providers[PROVIDER] || {}), oauth };
    saveAuth(next);
  }
  const access = process.env.TAWX_API_KEY || process.env.OPENAI_CODEX_ACCESS_TOKEN || oauth?.access || API_KEY;
  if (!access) throw new Error("No Codex OAuth token. Run: tawx login codex");
  return { access, accountId: oauth?.accountId || codexAccountId(access) };
}

async function chatCodex({ messages, tools, model, signal, onToken }) {
  const { instructions, input } = toCodexInput(messages);
  const { access, accountId } = await codexToken();
  const body = {
    model,
    store: false,
    stream: true,
    instructions,
    input,
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  const rtools = responsesTools(tools);
  if (rtools.length) body.tools = rtools;

  const res = await fetch(codexUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "chatgpt-account-id": accountId,
      originator: "tawx",
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Codex request failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  const calls = new Map();
  let usage = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === "response.output_text.delta" && ev.delta) {
        content += ev.delta;
        if (onToken) onToken(ev.delta);
      } else if (ev.type === "response.output_item.added" && ev.item?.type === "function_call") {
        calls.set(ev.item.call_id, { id: ev.item.call_id, type: "function", function: { name: ev.item.name, arguments: ev.item.arguments || "" } });
      } else if (ev.type === "response.function_call_arguments.delta") {
        const call = [...calls.values()].at(-1);
        if (call) call.function.arguments += ev.delta || "";
      } else if (ev.type === "response.function_call_arguments.done") {
        const call = [...calls.values()].at(-1);
        if (call) call.function.arguments = ev.arguments || call.function.arguments || "{}";
      } else if (ev.type === "response.output_item.done" && ev.item?.type === "function_call") {
        calls.set(ev.item.call_id, { id: ev.item.call_id, type: "function", function: { name: ev.item.name, arguments: ev.item.arguments || "{}" } });
      } else if (ev.type === "response.completed" && ev.response?.usage) {
        const u = ev.response.usage;
        usage = { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, total_tokens: u.total_tokens };
      }
    }
  }
  const message = { role: "assistant", content };
  const tool_calls = [...calls.values()];
  if (tool_calls.length) message.tool_calls = tool_calls;
  return { message, finish_reason: tool_calls.length ? "tool_calls" : "stop", usage };
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return String(messages[i].content || "");
  }
  return "";
}

async function chatClaudeCli({ messages, model, cwd, signal, onToken }) {
  const prompt = lastUserText(messages);
  if (!prompt) return { message: { role: "assistant", content: "" }, finish_reason: "stop", usage: {} };

  const args = [
    "-p",
    "--model", model,
    "--permission-mode", "bypassPermissions",
    "--output-format", "text",
    prompt,
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: cwd || process.cwd(), env: process.env });
    let out = "";
    let err = "";
    let emitted = 0;

    const abort = () => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      reject(new Error("Claude CLI request aborted"));
    };
    if (signal) signal.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (b) => {
      const s = b.toString();
      out += s;
      if (onToken && s) { emitted += s.length; onToken(s); }
    });
    child.stderr.on("data", (b) => { err += b.toString(); });
    child.on("error", (e) => reject(new Error(`Claude CLI not available: ${e.message}. Install/login with: claude`)));
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", abort);
      if (code !== 0) {
        reject(new Error(`Claude CLI failed (exit ${code}): ${(err || out).trim().slice(-1000)}`));
        return;
      }
      const content = out.trim();
      // If streamed to UI, avoid printing the same content twice via assistant event.
      resolve({ message: { role: "assistant", content: onToken && emitted ? "" : content }, finish_reason: "stop", usage: {} });
    });
  });
}

/**
 * Call the model once.
 * @returns {Promise<{message: object, finish_reason: string, usage: object}>}
 */
export async function chat(opts) {
  const maxTokens = opts.maxTokens || MAX_TOKENS;
  if (PROVIDER_CONFIG.type === "claude-cli") return chatClaudeCli({ ...opts, maxTokens });
  if (PROVIDER_CONFIG.type === "codex") return chatCodex({ ...opts, maxTokens });
  if (PROVIDER_CONFIG.type === "anthropic") return chatAnthropic({ ...opts, maxTokens });
  return chatOpenAi({ ...opts, maxTokens });
}

/**
 * Fetch the live model list from the active provider.
 * Only OpenAI-compatible providers expose a usable GET /models; codex (ChatGPT
 * backend) and claude-cli don't, so we return null there to signal "use the
 * hardcoded list". Returns a string[] of model ids on success, or null on
 * any failure (offline, auth, non-openai provider) — callers fall back.
 */
export async function listModels() {
  if (PROVIDER_CONFIG.type !== "openai" || !BASE_URL || !API_KEY) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { authorization: `Bearer ${API_KEY}` },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const j = await res.json();
    const ids = (j?.data || []).map((m) => m?.id).filter((x) => typeof x === "string" && x);
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}
