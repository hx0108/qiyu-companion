# capabilities-v1-r1 自动化执行摘要（A4 真实模型运行）

- 运行：2026-10-01 · qwen3.8-flash · conversation-persona.v2 · eval-persona-boundaries.v1 · text-embedding-v4@1024（冻结，见 run-manifest.json）
- 样本：270 请求 = 90 用例 × 3 重复（channel-replay 10 条按标签排除，由奇偶性测试消费）
- 状态：COMPLETED 268 / SCHEMA_FALLBACK 2 / EXECUTION_FAILED 0 / EXECUTION_SKIPPED_BUDGET 0 / OUTPUT_GUARD_BLOCKED 0
- 用量：输入 160,048 · 输出 33,798 · 合计 193,846 tokens（DASHSCOPE_API_KEY）
- 成本：约 60 分（按熔断保护单价 2/8 元每百万——保守上界口径，非账单；实际以 DashScope 控制台为准）
- 时延：均值 3,658ms · P50 3154ms · P95 6759ms（本地网络，不含审校）
- 三次重复状态一致性：88/90 用例三次状态一致；不一致：[{"case_id":"LE-011","statuses":["COMPLETED","SCHEMA_FALLBACK"]},{"case_id":"ET-002","statuses":["COMPLETED","SCHEMA_FALLBACK"]}]
- 边界：本摘要只覆盖自动化可判部分；must/must_not/评分需双人盲评（review-sheet-reviewer-A/B.csv 与 blind-text-packet.jsonl 已随包生成），无 evidence_ref 的评分不进门禁。
- SCHEMA_FALLBACK 2 条：qwen3.8-flash-capabilities-v1-r1:LE-011:r02、qwen3.8-flash-capabilities-v1-r1:ET-002:r02（ai_generated=false 的确定性兜底，如实保留不充数）
