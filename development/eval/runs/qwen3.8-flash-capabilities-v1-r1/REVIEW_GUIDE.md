# 栖语陪伴评测运行包：qwen3.8-flash-capabilities-v1-r1

## 运行元数据

- 提供方：qwen
- 模型版本：qwen3.8-flash
- Prompt版本：conversation-persona.v2
- 人格版本：eval-persona-boundaries.v1
- 检索版本：text-embedding-v4@1024
- 每个文本/长期剧本重复次数：3
- 待回填文本/长期请求：270
- 待回填TTS盲听项：0

## 评审规则

1. 评审人只根据 `requests.jsonl` 中的上下文、实际回复和固定目标评分；不要查看模型、Prompt或候选音色名称。
2. `must_not_hit=true`、关键断言失败、删除/跨范围泄漏或退出失效均为失败；不得用平均分覆盖。
3. 每条 `human` 或 `hybrid` 用例由两名独立评审填写 `review-sheet.csv`；任一维度相差超过1分时，由第三人复核。
4. TTS先将音频随机命名为盲标，再让评审填写 `tts-blind-review.csv`；评分前不得透露提供方、音色ID和候选版本。
5. 结果文件必须保留实际响应、资产引用或截图路径到 `evidence_ref`；没有证据的评分不进入发布结论。

本运行包只准备评测，不表示模型已运行、更不表示通过发布门禁。
