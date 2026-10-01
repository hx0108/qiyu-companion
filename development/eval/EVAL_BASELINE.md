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
| `npm run eval:dataset:validate:capabilities` | 六项能力扩展数据集 `qiyu-capabilities-v0.1`（100 条七类 + 50 干扰资产 + channel-replay 10 + multi-day 20）结构校验，不调模型 | 数量/分布/标记断言全过（fail-loud） |
| `npm run eval:followup-policy` | 主动跟进许可固定回归：`evaluateFollowupPublish` 唯一写者 15 分支 (action,reason) 精确对（PUBLISH 1 + CANCEL 9 + EXPIRE 3 + DEFER 2） | 零容差，任一漂移判败 |
| `npm run eval:plan-card` | 计划提议与卡片固定回归：三路回退 3 + schema 拒绝 4 + 卡片边界 3 | 零容差（HTML/链接/未知动作一律拒绝而非转义） |
| `npm run verify:plan-proposer` | 真实 Qwen 计划提议器验收（10 探针经生产 composer 路径；医疗禁词/注入产物/施压话术硬断言） | 硬断言全过 + 人工语义复核销账；key 不可用退出 1 不假装跑过 |
| `npm run test:pg-worker-contention` | 双进程 Worker 竞争（spawn 两个真实 run-workers）：恰一胜/崩溃租约重领/零重复投递 | 全断言 PASS（连跑三轮无 flaky） |
| `npm run verify:deletion-recovery-drill` | 删除账本本地恢复演练：九域造数→pg_dump→注销→恢复→账本重放→九域清零 | 全链通过；本地合成数据非生产备份介质 |

六项能力 A4 新增口径：`eval:companion:prepare --dataset qiyu-capabilities-v0.1` 展开运行包（channel-replay 标记的 10 条由 `test/life-event-channel-parity.test.js` 三通道奇偶性测试消费，不进运行包避免双计费）；`eval:companion:execute --dry-run` 先产 `budget-estimate.md`（上限口径=门禁、经验口径=参考，动态采样既有运行包实测 usage），真实执行三道门禁：预算表必须存在、单价必须配置（不猜价格）、上限口径超 `QIYU_EVAL_BUDGET_FEN`（默认 5000 分）退出码 2 拒跑；执行中按实际 usage 熔断，剩余条目标 `EXECUTION_SKIPPED_BUDGET` 如实登记。评审边界：运行包（模型输出）双人盲评不变；数据集题目为设计产物，产品过目 + manifest 冻结即生效，题目本身不盲评。

## 栖语陪伴质量数据集 v0.1

`development/eval/datasets/qiyu-companion-v0.1/` 提供独立于现有小型自动回归集的扩展评测材料：64 条短场景、8 组跨会话长期剧本和 24 条 TTS 盲听脚本。它覆盖陪伴质量、人格/OOC、关系记忆、安全与退出、主动互动、多模态一致性和故障降级，并将确定性硬门禁与双人盲评分开。

```powershell
npm run eval:dataset:validate
```

该命令只校验数据结构、规模、唯一 ID 和关键门禁声明，不会调用模型，也不代表任何模型通过评测。执行与评分规范见数据集目录中的 `README.md`。

### 运行包与双人盲评

先由运行包生成器冻结本轮的模型、Prompt、人格和检索版本，并将 64 条核心场景与 8 组长期剧本按重复次数展开为待执行请求；它同时生成独立的双人评分表和 24 条 TTS 盲听表。该步骤不读取密钥、不调用模型、不会覆盖旧报告：

```powershell
npm run eval:companion:prepare -- --run-id qwen-20260917-r1 `
  --provider qwen --model-version qwen3.8-flash --prompt-version p12 `
  --persona-version persona-v3 --retrieval-version text-embedding-v4 --repetitions 3
```

输出位于 `development/eval/runs/<run-id>/`：`requests.jsonl` 供受控运行器消费，`review-sheet.csv` 供两名评审独立填写，`tts-blind-review.csv` 用于随机盲标后的语音打分。没有实际响应和 `evidence_ref` 的评分不得进入门禁结论。

> Prompt 版本登记：`CONVERSATION_PROMPT_VERSION` 已于 2026-09-30 从 `conversation-persona.v1` 升至 `conversation-persona.v2`（六项能力 A1：`confirmed_assets` 带 `asset_id` 时加 `[尾4位/v版本]` 标注、新增 `active-life-event-data` 事件块）。两处变化都只在 A1 开关开启的请求出现；开关关闭的请求 prompt 文本与 v1 逐字一致。既有以 v1 冻结的运行包结论不受影响。

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
