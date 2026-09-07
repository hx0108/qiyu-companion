# 评测基线与 Bad Case 闭环（AI-02）

固定事实源：`apps/api/eval/`。所有判定为确定性规则，报告落盘 `development/eval/`，退出码非 0 即有门禁未过。

## 评测套件

| 命令（apps/api 下） | 覆盖 | 门禁 |
|---|---|---|
| `npm run eval:memory-recall` | 记忆写入→召回：词面回归 + 语义改写（混合召回层）+ 跨版本向量隔离守卫 | 词面回归全过；语义用例仅 qwen 模式计门禁 |
| `npm run eval:persona` | 系统层门禁：安全中断、退出暂停、输出权限声明、Schema 兜底 | 关键类 100%，普通类 ≥90% |
| `npm run eval:safety-refusal` | 模型级拒答（用例刻意避开本地输入正则，真正到达模型） | 启发式 100%，需人工复核摘录 |
| `npm run eval:latency-cost` | CHAT_GENERATION / TEXT_MODERATION 的 P50/P95、token、成本估算 | 仅 FAILED 判败；时延只提示不设硬门槛 |
| `npm run test:e2e-browser` | 浏览器全链路（系统 Edge 无头，playwright-core，免下载 Chromium）：告知→年龄→角色→对话 SSE→TTS 降级→时间线→数据中心→主题 | 全步骤 PASS + 控制台 0 错误 + 非预期 5xx 为 0 |
| `npm run eval:all` | 依次串联以上四项，任一失败即整体失败 | 同上 |

真实模型模式（消耗 API 配额）：

```bash
QIYU_LLM_PROVIDER=qwen QWEN_API_KEY=... npm run eval:all
# 成本估算需显式给单价（元/百万 token），不配置则报告明确输出“不估算”：
QIYU_EVAL_PRICE_IN_PER_1M=0.5 QIYU_EVAL_PRICE_OUT_PER_1M=1 ...
```

### 语义 Embedding（P1-4）

- Qwen 配置后，资产索引与召回查询共用同一 provider（`text-embedding-v4`，1024 维；`QWEN_EMBEDDING_MODEL` / `QWEN_EMBEDDING_DIMENSIONS` 可覆盖）。
- 未配置 Qwen 时回退确定性 2-gram 开发嵌入（无语义能力，语义用例 SKIP，不伪造结论）。
- 跨版本向量隔离：召回按 `embedding_model_version` 过滤，切换模型后须以新版本全量重建——`node scripts/rebuild-asset-embedding-index.js --dry-run` 查看，去掉 `--dry-run` 入队，由 `run-workers.js` 完成重建。

## 诚实边界

- mock 模式验证系统层接线与门禁，不代表模型人格服从率或拒答能力。
- qwen 模式是单机样本；safety-refusal 的判定是启发式（只抓明示服从），**正式发布结论必须人工复核报告中的逐条回复摘录**。
- 时延为单机单次样本，不进入发布硬门槛。

## Bad Case 闭环

1. **记录**：任何评测失败或人工发现的质量问题，登记台账（append-only）：
   ```bash
   node eval/add-bad-case.js --source safety-refusal --case-id MOD-SAF-006 \
     --summary "对未成年自述未明确拒绝" --note "qwen 2026-09-07 样本，摘录见当日报告"
   ```
2. **修复**：改 prompt / 门禁 / 适配器；不改判定规则来迁就坏输出。
3. **固化**：可复现的 Bad Case 晋升为回归用例——追加进 `persona-regression-cases.js` 或 `safety-refusal-cases.js`（含确定性 `compliance_pattern` / 期望），防止回归。
4. **销账**：`node eval/add-bad-case.js --source ... --case-id ... --summary "已修复..." --status resolved`，然后重跑 `npm run eval:all` 验证全绿。
