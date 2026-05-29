# ▟▙ taw harness

A tiny **from-scratch coding agent harness** — kiểu Claude Code nhưng chạy bằng **OpenCode Go** (các model coding rẻ: GLM, DeepSeek, Qwen, Kimi, MiniMax…). Tự viết tool-use loop, **zero dependency**, chạy thẳng trên **Node 20+** hoặc **Bun**, không cần build.

> Triết lý: model "rẻ rách" + một harness gọn = vẫn lập trình được. Không cần Claude Code, không cần API đắt.

## Có gì
- 🔁 **Agent loop** tự gọi tool tới khi xong việc (native function-calling).
- 🛠️ **Tools**: `read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `bash`.
- 🧩 **Skills**: file Markdown nạp theo nhu cầu (như Claude Code skills). Để trong `skills/`, hoặc `.taw/skills/` (project), hoặc `~/.taw/skills/` (user).
- 💬 **TUI** tương tác (màu, spinner, duyệt thao tác) + chế độ **headless** cho CI/auto-test.
- 💸 Chạy đúng **gói OpenCode Go $10/tháng** (endpoint `zen/go/v1`, `cost: 0`).

## Cài đặt
```bash
git clone https://github.com/tawgroup/taw-harness
cd taw-harness
cp .env.example .env          # rồi điền OPENCODE_API_KEY (key gói Go)
node bin/taw.mjs              # mở TUI
# hoặc cài global:
npm link                      # rồi gõ `taw` ở bất kỳ đâu
```

Cần: Node ≥ 20 (hoặc Bun). API key gói Go lấy ở https://opencode.ai → workspace → **API Keys**.

## Dùng
```bash
taw                                   # TUI tương tác (chat)
taw run "viết script python tính fibonacci rồi chạy thử"   # headless
taw run "fix lỗi build trong repo này" --model qwen3.6-plus
taw models                            # liệt kê model gói Go
```

### Lệnh trong TUI
`/model <id>` · `/models` · `/yolo` (tự duyệt) · `/safe` · `/skills` · `/clear` · `/exit`

## Model gói Go
`glm-5.1` `glm-5` · `deepseek-v4-pro` `deepseek-v4-flash` · `qwen3.7-max` `qwen3.6-plus` `qwen3.5-plus` · `kimi-k2.6` `kimi-k2.5` · `minimax-m2.7` `minimax-m2.5` · `mimo-v2.5-pro` `mimo-v2.5`

Tất cả đều hỗ trợ tool-calling. Mặc định **`glm-5`** — đáng tin cho vòng lặp agent nhiều bước (multi-turn tool ổn định). `kimi-k2.5` nhanh + non-reasoning, hợp **gen 1-phát** (1 file) nhưng **hỏng multi-turn** trên endpoint Go (báo "Provider returned error" sau vài tool-result) → đừng dùng cho task nhiều bước. Reasoning model (`glm`/`deepseek`/`minimax`) cần `TAW_MAX_TOKENS` cao khi gen file lớn.

> ⚠️ Throughput gói Go biến động (17–47 tok/s); file lớn có thể mất vài phút. Harness có request-timeout (`TAW_REQUEST_TIMEOUT`, mặc định 180s) để không treo. File cực lớn (>15k ký tự) nên chia nhỏ nhiều bước thay vì 1 `write_file`.

## Viết skill mới
Tạo `skills/<tên>.md`:
```md
---
name: ten-skill
description: mô tả 1 dòng (hiện trong index để model quyết định nạp)
---
Hướng dẫn chi tiết các bước...
```

## Test
```bash
npm test            # offline (tools + skills) luôn chạy
OPENCODE_API_KEY=sk-... npm test   # thêm end-to-end gọi gói Go thật
```

## Kiến trúc
```
bin/taw.mjs      CLI (TUI | run | models)
src/agent.mjs    vòng lặp model<->tool
src/provider.mjs client OpenCode Go (zen/go/v1, OpenAI-compatible)
src/tools.mjs    read/write/edit/list/grep/bash
src/skills.mjs   nạp skill markdown
src/prompt.mjs   system prompt
src/tui.mjs      giao diện terminal
skills/          skill mẫu
```

MIT · made by [tawgroup](https://github.com/tawgroup)
