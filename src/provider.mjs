// OpenCode Go client — OpenAI-compatible /chat/completions.
import { BASE_URL, API_KEY, MAX_TOKENS, REQUEST_TIMEOUT_MS } from "./config.mjs";

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call the model once.
 * @returns {Promise<{message: object, finish_reason: string, usage: object}>}
 */
export async function chat({ messages, tools, model, maxTokens = MAX_TOKENS, signal }) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    let res;
    // hard timeout so a stalled generation fails fast instead of hanging forever
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error("timeout")), REQUEST_TIMEOUT_MS);
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      // caller aborted -> propagate; our own timeout -> retry
      if (signal?.aborted) throw e;
      lastErr = new Error(`request error/timeout (>${REQUEST_TIMEOUT_MS}ms): ${e.message}`);
      await SLEEP(500 * (attempt + 1));
      continue;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      lastErr = new Error(`Bad response (${res.status}): ${text.slice(0, 300)}`);
      if (res.status >= 500) { await SLEEP(500 * (attempt + 1)); continue; }
      throw lastErr;
    }

    if (json.type === "error" || json.error) {
      const err = json.error || json;
      const type = err.type || "Error";
      const msg = err.message || JSON.stringify(err);
      // fatal: pointless to retry (out of credits, wrong model, wrong key)
      const fatal =
        res.status === 401 ||
        res.status === 403 ||
        /CreditsError|ModelError|Insufficient|unauthor|invalid api key/i.test(`${type} ${msg}`);
      if (fatal) throw new Error(`${type}: ${msg}`);
      // transient (incl. upstream "Provider returned error") -> retry
      lastErr = new Error(`${type}: ${msg}`);
      await SLEEP(800 * (attempt + 1));
      continue;
    }

    const choice = (json.choices || [])[0] || {};
    const message = choice.message || {};
    // normalize: kimi adds a stray top-level `name:null` on tool_calls; strip it
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls = message.tool_calls.map((tc, i) => ({
        id: tc.id || `call_${i}`,
        type: "function",
        function: { name: tc.function?.name, arguments: tc.function?.arguments ?? "{}" },
      }));
    }
    return {
      message,
      finish_reason: choice.finish_reason,
      usage: json.usage || {},
      cost: json.cost,
    };
  }
  throw lastErr || new Error("request failed");
}
