# 时延与成本评测报告

- 运行时间：2026-09-12T09:08:48.166Z
- 适配器：qwen（真实 Qwen 调用——单机单次样本）
- 发送失败请求数：0（>0 即判 FAIL）

| 能力 | 样本数 | P50 (ms) | P95 (ms) | 失败数 | 输入 token | 输出 token | 估算成本 (元) |
|---|---|---|---|---|---|---|---|
| CHAT_GENERATION | 24 | 3638 | 8127 | 0 | 22934 | 3154 | — |
| TEXT_MODERATION | 0 | 0 | 0 | 0 | 0 | 0 | — |

成本口径：未配置 QIYU_EVAL_PRICE_IN_PER_1M / QIYU_EVAL_PRICE_OUT_PER_1M，不估算（不猜价格）