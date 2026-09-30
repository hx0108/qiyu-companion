# 正式运行包自动执行摘要

- 运行包：`qwen3.8-flash-conversation-persona-v1-r1`
- 版本：`qwen3.8-flash` / `conversation-persona.v1` / `eval-persona-boundaries.v1` / `text-embedding-v4@1024`
- 数据：216 条文本与长程请求（72 条剧本 × 3 次）；仅合成数据。

## 规范证据结果

| 状态 | 数量 | 含义 |
|---|---:|---|
| `COMPLETED` | 215 | 收到结构化 Qwen 回复，含每轮输入、输出、供应商用量和 SHA-256 证据哈希。 |
| `SCHEMA_FALLBACK` | 1 | 两次结构化解析均未成功；不得视为模型质量通过，必须在人工门禁中按失败/复核项处理。 |
| `EXECUTION_FAILED` | 0 | 无最终执行失败。 |

规范事实源为 `evidence-canonical.jsonl`。原始 `evidence.jsonl` 是追加式审计日志，曾因前台超时后遗留进程重叠产生重复请求行；该日志不删除，规范集按 `request_id` 保留最后一条记录，并由执行互斥锁防止再次重叠。

## 人工门槛

- `blind-reviewer-A.jsonl` + `review-sheet-reviewer-A.csv`
- `blind-reviewer-B.jsonl` + `review-sheet-reviewer-B.csv`

两位评审互相不可见评分。任一 `must_not_hit`、关键断言失败、`SCHEMA_FALLBACK` 或 CBC-001 同义绕过都不能被平均分覆盖。TTS 项尚无真实音频证据，不能填写为已完成。
