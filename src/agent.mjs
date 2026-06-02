// The agent loop: model <-> tools until the task is done.
import { chat } from "./provider.mjs";
import { TOOLS, toolSchemas } from "./tools.mjs";
import { systemPrompt } from "./prompt.mjs";
import { maybeCompact } from "./compact.mjs";
import { DEFAULT_MODEL, MAX_STEPS } from "./config.mjs";

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

  const registry = { ...TOOLS };
  const tools = toolSchemas();
  const ctx = { cwd, onEvent }; // onEvent lets tools (e.g. todo_write) surface UI events

  const messages = [
    { role: "system", content: systemPrompt({ cwd, model }) },
  ];

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
    reconcileToolCalls();
    messages.push({ role: "user", content: userText });

    for (let step = 0; step < maxSteps; step++) {
      // Compact older turns if the conversation has grown too large for the context window.
      await maybeCompact(messages, { model, signal, onEvent });
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
        onEvent({ type: "done" });
        return message.content || "";
      }

      for (const call of calls) {
        const name = call.function?.name;
        const tool = registry[name];
        const args = safeParse(call.function?.arguments);
        if (!tool || args === null) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: !tool ? `ERROR: no such tool "${name}"` : "ERROR: arguments are not valid JSON",
          });
          continue;
        }
        onEvent({ type: "tool_call", name, preview: tool.preview ? tool.preview(args) : "" });

        if (tool.needsApproval) {
          const ok = await approve(name, args, tool.preview ? tool.preview(args) : "");
          if (!ok) {
            onEvent({ type: "tool_denied", name });
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: "The user DENIED running this tool. Try another approach or ask.",
            });
            continue;
          }
        }

        let result;
        try {
          result = await tool.run(args, ctx);
        } catch (e) {
          result = `ERROR running tool: ${e.message}`;
        }
        onEvent({ type: "tool_result", name, result });
        messages.push({ role: "tool", tool_call_id: call.id, content: String(result) });
      }
    }
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
    },
    reset() {
      messages.length = 1; // keep system
    },
    messages,
  };
}
