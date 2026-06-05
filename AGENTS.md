# AGENTS.md — tawx-harness

This repo is a small PI-inspired, zero-dependency coding-agent harness. Keep it simple: core agent loop + a few built-in tools only. No skills, no MCP, no plugin system.

## Rules when editing this repo
- **No dependencies** unless absolutely required. Prefer Node built-ins.
- `.mjs` ESM files, run directly (no build step). Must work on both `node` and `bun`.
- New tool: add it to `src/tools.mjs` following the `{schema, needsApproval, preview, run}` shape.
- Destructive actions (write/edit/bash) must set `needsApproval: true`.
- User-facing strings: English.

## Test
- `npm test` — the offline checks must always be green.
- With `OPENCODE_API_KEY` set, it also runs the live end-to-end test.

## Endpoint (verified)
- Base: `https://opencode.ai/zen/go/v1` (NOT `zen/v1` — that one debits balance and returns CreditsError).
- Auth: header `authorization: Bearer <Go plan key>`.
- OpenAI-compatible `/chat/completions`; may return extra `reasoning_content` (safe to ignore).

## Model notes (verified 2026-05-29)
- Default `glm-5`: RELIABLE for the agent loop — multi-turn tool use completes (write→read→summary OK).
- `kimi-k2.5`: fast + non-reasoning, generates output directly. BUT **breaks on multi-turn**: works for 1-2 tool calls then the next returns "Provider returned error". Only use for one-shot gen (low max-steps). Not a good default.
- glm-5 / deepseek-v4-pro / minimax-m2.5: reasoning-heavy → burn lots of `reasoning_tokens`, set a higher `TAWX_MAX_TOKENS` for large files.
- Go throughput varies 17–47 tok/s; there is a request-timeout (`TAWX_REQUEST_TIMEOUT`). Stuffing >15k chars into one tool-call `arguments` can trigger provider errors → prefer splitting large files across steps.
