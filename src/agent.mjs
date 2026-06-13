// The agent loop: model <-> tools until the task is done.
import fs from "node:fs";
import { chat } from "./provider.mjs";
import { TOOLS, renderPlan } from "./tools.mjs";
import { systemPrompt } from "./prompt.mjs";
import { maybeCompact } from "./compact.mjs";
import { DEFAULT_MODEL, MAX_STEPS } from "./config.mjs";

const IMG_EXT = /\.(png|jpe?g|webp|gif)$/i;
const IMG_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

// If the user's text references local image files (e.g. a path pasted via Ctrl+V),
// read them, base64-encode, and return a multimodal content array so the model
// can actually SEE them. No images → returns the plain string (back-compatible).
function buildUserContent(text) {
  const images = [];
  const used = new Set();
  for (const tok of String(text).split(/\s+/)) {
    if (!IMG_EXT.test(tok) || used.has(tok)) continue;
    try {
      if (fs.existsSync(tok) && fs.statSync(tok).isFile()) {
        const ext = tok.split(".").pop().toLowerCase();
        images.push({ type: "image", mime: IMG_MIME[ext] || "image/png", data: fs.readFileSync(tok).toString("base64") });
        used.add(tok);
      }
    } catch { /* not a readable file — leave it as text */ }
  }
  if (!images.length) return text;
  // Strip the recognized image paths from the visible text; keep the rest as the prompt.
  const rest = String(text).split(/\s+/).filter((t) => !used.has(t)).join(" ").trim();
  const parts = [];
  if (rest) parts.push({ type: "text", text: rest });
  parts.push(...images);
  return parts;
}

function safeParse(s) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return null;
  }
}

/**
 * Create a stateful agent session (keeps conversation across turns).
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.model
 * @param {(ev:object)=>void} opts.onEvent
 * @param {(tool:object,args:object)=>Promise<boolean>} opts.approve  // return true to run
 */
export function createAgent(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  let model = opts.model || DEFAULT_MODEL;
  const onEvent = opts.onEvent || (() => {});
  const approve = opts.approve || (async () => true);
  const maxSteps = opts.maxSteps || MAX_STEPS;
  const stream = opts.stream || false;

  // Optional tool allowlist (case / CI mode): restrict the model's hands so a
  // scoped role like "reviewer" physically CANNOT edit. null/empty = all tools.
  const allow = opts.tools?.length ? new Set(opts.tools) : null;
  const registry = allow
    ? Object.fromEntries(Object.entries(TOOLS).filter(([k]) => allow.has(k)))
    : { ...TOOLS };
  const tools = Object.values(registry).map((t) => t.schema);
  // ctx.plan is the source of truth for the checklist. The update_plan tool writes
  // here; the loop re-pins a fresh copy at the end of context each turn (below).
  const ctx = { cwd, onEvent, plan: [] };

  const messages = [
    { role: "system", content: systemPrompt({ cwd, model }) },
  ];

  // Plan "pinning": the live plan lives in ctx.plan, NOT as a permanent message.
  // Each turn we strip last turn's pinned copy and append a fresh one at the very
  // end, so the checklist is always current, always in view, and survives compaction
  // (it's regenerated from ctx.plan rather than summarized away).
  const PIN = "__pinnedPlan";
  function stripPin() {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i][PIN]) messages.splice(i, 1);
  }
  function pinPlan() {
    if (!ctx.plan?.length) return;
    messages.push({
      role: "user",
      [PIN]: true,
      content:
        "[Current plan — keep this updated via update_plan as you finish each step]\n" +
        renderPlan(ctx.plan),
    });
  }

  // After an interrupt, the log can end on an assistant tool_calls message whose tool
  // results never got pushed. Most providers reject that. Synthesize the missing results
  // so the next turn starts from a coherent state.
  function reconcileToolCalls() {
    let ai = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].tool_calls?.length) { ai = i; break; }
      if (messages[i].role === "user") break;
    }
    if (ai === -1) return;
    const answered = new Set(
      messages.slice(ai + 1).filter((m) => m.role === "tool").map((m) => m.tool_call_id),
    );
    for (const call of messages[ai].tool_calls) {
      if (!answered.has(call.id))
        messages.push({ role: "tool", tool_call_id: call.id, content: "(interrupted by user)" });
    }
  }

  async function send(userText, { signal } = {}) {
    stripPin();              // ephemeral; never let a stale pin linger into a new turn
    reconcileToolCalls();
    messages.push({ role: "user", content: buildUserContent(userText) });

    for (let step = 0; step < maxSteps; step++) {
      stripPin();            // remove last step's pin before compaction sees it
      // Compact older turns if the conversation has grown too large for the context window.
      await maybeCompact(messages, { model, signal, onEvent });
      pinPlan();             // re-pin the live checklist at the very end of context
      onEvent({ type: "thinking", model });
      const { message, finish_reason, usage, cost } = await chat({
        messages,
        tools,
        model,
        cwd,
        signal,
        onToken: stream ? (t) => onEvent({ type: "assistant_delta", text: t }) : undefined,
      });

      const calls = message.tool_calls || [];
      // record assistant turn (content may be empty when only tool_calls)
      messages.push({
        role: "assistant",
        content: message.content || "",
        ...(calls.length ? { tool_calls: calls } : {}),
      });

      if (message.content) onEvent({ type: "assistant", text: message.content });
      onEvent({ type: "usage", usage, cost });

      if (!calls.length) {
        stripPin();          // don't persist the ephemeral pin into the saved session
        onEvent({ type: "done" });
        return message.content || "";
      }

      // Phase 1 — validate + approve SEQUENTIALLY (approval is an interactive
      // prompt; can't run several at once). Build a plan of what to execute.
      const plan = [];
      for (const call of calls) {
        const name = call.function?.name;
        const tool = registry[name];
        const args = safeParse(call.function?.arguments);
        if (!tool || args === null) {
          plan.push({ call, content: !tool ? `ERROR: no such tool "${name}"` : "ERROR: arguments are not valid JSON" });
          continue;
        }
        const preview = tool.preview ? tool.preview(args) : "";
        onEvent({ type: "tool_call", id: call.id, name, preview });
        if (tool.needsApproval) {
          const ok = await approve(name, args, preview);
          if (!ok) {
            onEvent({ type: "tool_denied", name });
            plan.push({ call, content: "The user DENIED running this tool. Try another approach or ask." });
            continue;
          }
        }
        plan.push({ call, name, tool, args, preview, run: true });
      }

      // Phase 2 — run the approved tools IN PARALLEL (like pi). Independent
      // reads/greps no longer wait on each other.
      await Promise.all(
        plan.filter((p) => p.run).map(async (p) => {
          try {
            onEvent({ type: "tool_start", id: p.call.id, name: p.name, preview: p.preview });
            p.result = await p.tool.run(p.args, ctx);
          } catch (e) {
            p.result = `ERROR running tool: ${e.message}`;
          }
        }),
      );

      // Phase 3 — emit results + push tool messages IN ORDER (tool_call_id must
      // line up with the assistant's call order regardless of finish order).
      for (const p of plan) {
        if (p.run) {
          onEvent({ type: "tool_result", id: p.call.id, name: p.name, result: p.result });
          messages.push({ role: "tool", tool_call_id: p.call.id, content: String(p.result) });
        } else {
          messages.push({ role: "tool", tool_call_id: p.call.id, content: p.content });
        }
      }
    }
    stripPin();
    onEvent({ type: "max_steps" });
    return "(reached step limit)";
  }

  return {
    send,
    get model() {
      return model;
    },
    setModel(m) {
      model = m;
      // Keep the system prompt's stated model name in sync, otherwise the agent
      // keeps introducing itself as the old model after a /model switch.
      messages[0] = { role: "system", content: systemPrompt({ cwd, model }) };
    },
    reset() {
      messages.length = 1; // keep system
    },
    // Replace the live context (used by the conversation tree to rewind/branch).
    // Keeps message[0] = the current system prompt regardless of what's passed.
    setMessages(arr) {
      const sys = messages[0];
      messages.splice(0, messages.length, sys, ...arr.filter((m) => m.role !== "system"));
    },
    messages,
  };
}
