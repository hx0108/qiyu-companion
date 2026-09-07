# 交付状态台账（2026-09-08 更新）

延续 `CURRENT_DELIVERY_AUDIT_2026-09-05.md` 的口径：以下条目均为本地开发切片内的可复现事实，不构成外部封测或公开上线批准。

## 本轮新增（P0/P1 缺口收敛）

| 条目 | 交付物 | 验证方式 | 证据边界 |
|---|---|---|---|
| P0 后台任务化 | 图片任务由常驻 Worker 推进（`domain/image-job-advance.js`），保留期/权利清理/注销清理并入 `scripts/run-workers.js`；Compose 三容器编排 | `test/image-job-advance.test.js` + 全量 256 用例 | 本地合成数据；真实供应商链路仍按环境变量门禁 |
| P0 数据删除与恢复 | 注销清理 Worker + 删除账本/回执（迁移 048）+ 备份重放演练脚本 `run-deletion-ledger-replay.js` 与 runbook | `test/deletion-orchestration.test.js` | 演练为脚本级重放，未在真实备份介质上执行 |
| P0 模型质量评测 | 模型级拒答评测集（8 用例刻意避开本地正则）、时延/成本报告（token 计价需显式单价）、Bad Case JSONL 台账 + `eval:all` 串联 | `development/eval/*.md` 报告 | 拒答判定是启发式，正式结论需人工复核逐条摘录；mock 模式只验接线 |
| P1 语义记忆检索 | Qwen embedding 索引/查询同源（跨版本向量隔离）、维度参数化（迁移 049 摘除 256 维钉死）、重建脚本、语义改写评测用例 | `test/asset-embedding.test.js` + memory-recall 报告 | 语义用例仅 qwen 模式计门禁；mock 模式如实 SKIP |
| P1 浏览器 E2E | `scripts/run-browser-e2e.js`（系统 Edge 无头，playwright-core 免下载）固化 8 步全链路 | `development/eval/browser-e2e-*.md` | 安全中心前端暂无入口按钮（见已知问题），未纳入 |
| P1 可观测性 | `/internal/metrics` Prometheus 导出、`deploy/monitoring/prometheus-rules.yml`、`OPERATIONS_RUNBOOK.md`；feature-flags 端点改报运行时真实值 | `test/internal-reviewer.test.js` | PG 请求作用域 store 下端点为账户样本，全实例口径待独立导出 |
| P1 AIGC 标识 | PNG tEXt/JPEG COM 隐式标识注入（交付时）、下载响应头 `x-qiyu-aigc-label`、导出 JSON 顶层 `aigc_disclosure`、TTS mark_version 真实化 | `test/production-hardening.test.js` | WebP 无轻量注释位（如实 passthrough）；像素级显式水印依赖供应商（混元 logoadd 已配置） |

## 已知问题与未竟项

1. **安全中心无前端入口**：`apps/web/app.js` 存在 `open-safety` 处理器与 `route=safety` 渲染，但没有任何按钮触发（`grep data-action="open-safety"` 为 0）。需前端补入口后纳入浏览器 E2E。
2. **生产 PG 全实例指标导出**：`/internal/metrics` 在 Postgres 请求作用域 store 下只反映单账户样本；需独立 Worker 从汇总表导出（OPERATIONS_RUNBOOK 已注明）。
3. **P2 未开始**：运营安全流程（值班/升级/复盘/权限分离/审计文档）与真实短信登录/通知/反滥用仍待做。
4. C 盘在 2026-09-07 一度 100% 满（已清 npm 缓存腾出 ~1.7G）；建议做一次真正的磁盘清理。

## 复现命令

```bash
cd apps/api
npm test                      # 256 用例
npm run eval:all              # 记忆/人格/拒答/时延成本（mock 模式）
npm run test:e2e-browser      # 浏览器全链路（需系统 Edge）
QIYU_LLM_PROVIDER=qwen QWEN_API_KEY=... npm run eval:all   # 真实模型模式（消耗配额）
```
