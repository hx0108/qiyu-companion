# 交付状态台账（2026-09-08 更新）

延续 `CURRENT_DELIVERY_AUDIT_2026-09-05.md` 的口径：以下条目均为本地开发切片内的可复现事实，不构成外部封测或公开上线批准。

## 本轮新增（P0/P1 缺口收敛）

| 条目 | 交付物 | 验证方式 | 证据边界 |
|---|---|---|---|
| P0 后台任务化 | 图片任务、保留期与注销清理由常驻 Worker 推进（`domain/image-job-advance.js` / `scripts/run-workers.js`）；内容权利物理清理使用独立最小权限数据库连接 | 受控参考图审核撤销 → Outbox → Worker → 私有 COS 删除已跑通；删除回执为 `COMPLETED`、`object_delete_count=1`，且仅验证该受控随机对象为 COS not-found | 该验证不删除真实用户对象；生产仍须按审批和告警流程执行 |
| P0 数据删除与恢复 | 注销清理 Worker + 删除账本/回执（迁移 048）+ 备份重放演练脚本 `run-deletion-ledger-replay.js` 与 runbook | `test/deletion-orchestration.test.js` | 演练为脚本级重放，未在真实备份介质上执行 |
| P0 模型质量评测 | 模型级拒答评测集（8 用例刻意避开本地正则）、时延/成本报告（token 计价需显式单价）、Bad Case JSONL 台账 + `eval:all` 串联 | `development/eval/*.md` 报告 | 拒答判定是启发式，正式结论需人工复核逐条摘录；mock 模式只验接线 |
| P1 语义记忆检索 | Qwen embedding 索引/查询同源（跨版本向量隔离）、维度参数化（迁移 049 摘除 256 维钉死）、重建脚本、语义改写评测用例 | `test/asset-embedding.test.js` + memory-recall 报告 | 语义用例仅 qwen 模式计门禁；mock 模式如实 SKIP |
| P1 浏览器 E2E | `scripts/run-browser-e2e.js`（系统 Edge 无头，playwright-core 免下载）固化 9 步全链路 | `development/eval/browser-e2e-2026-09-08.md`：真实 Qwen 聊天、9/9 PASS、控制台异常 0、非预期 5xx 0 | 浏览器为内存开发 Store；聊天真实 Qwen，腾讯媒体链路仍由独立供应商验收脚本覆盖 |
| P1 可观测性 | `/internal/metrics` Prometheus 导出、`deploy/monitoring/prometheus-rules.yml`、`OPERATIONS_RUNBOOK.md`；feature-flags 端点改报运行时真实值 | `test/internal-reviewer.test.js` | PG 请求作用域 store 下端点为账户样本，全实例口径待独立导出 |
| P1 AIGC 标识 | PNG tEXt/JPEG COM 隐式标识注入（交付时）、下载响应头 `x-qiyu-aigc-label`、导出 JSON 顶层 `aigc_disclosure`、TTS mark_version 真实化 | `test/production-hardening.test.js` | WebP 无轻量注释位（如实 passthrough）；像素级显式水印依赖供应商（混元 logoadd 已配置） |

## 本机容器复验（2026-09-08）

- Docker 中 `postgres`、`api`、`worker` 均为健康/运行状态；迁移账本为 **52**。迁移 051/052 补齐审核人 `app` schema 使用权及撤销过程所有者的最小表权限，使独立 Worker 能执行既有存储过程而不向登录审核人开放写权限。
- 完整回归：`node --test test/*.test.js` **263/263 通过**；其中新增自报可能未成年转 `AGE_REVIEW`、Qwen JSON 模式与未知字段隔离。
- 腾讯 ASR 真实探针通过：固定合成文字 → 腾讯 TTS（MP3）→ 腾讯 ASR（16k 中文）返回非空转写；探针不创建用户账户或持久化用户媒体。
- Docker 到 DashScope 已恢复：无凭据 HTTPS 探针返回预期 `401`，重建后 `verify-closed-trial-qwen.js` 仍返回 `acceptance=passed`。真实 Qwen 人格（8/8）、记忆（3/3 语义改写）、安全（8/8；其中未成年用例由本地门禁）、时延（24 次、0 失败）均已有真实调用证据。北京区域评测单价已显式配置为输入 0.8 / 输出 2.7 元每百万 token；需以控制台账单为最终费用依据。
- 混元完整闭环通过：`development/eval/tencent-hunyuan-completion-2026-09-08.json` 记录了受控参考图 IMS=PASS → `SubmitTextToImageJob` 完成 → 577956 字节结果入私有 COS → IMS 二审 PASS，且请求 AIGC Logo。探针对象随后清理；它验证供应商媒体链路，不等同于真实用户前端展示验收。
- 内容权利真实物理清理通过：受控随机参考图经审核撤销后，由独立最小权限 Worker 生成并完成清理任务；数据库复核为 `REVOKED` / `DELETED` / `COMPLETED`，对象存储仅对该受控 key 返回 not-found。该记录是受控删除回执，不是对真实用户资产的批量删除。
- 真实 Qwen 浏览器 E2E 通过：`browser-e2e-2026-09-08.md` 记录必要告知、年龄声明、角色创建、真实 Qwen SSE、TTS 受控降级、时间线、数据中心、安全/通知和主题共 9 步均 PASS。浏览器运行于内存开发 Store，不能外推为生产环境或腾讯媒体的浏览器链路。

## 已知问题与未竟项

1. **真实腾讯媒体浏览器链路**：真实 Qwen 浏览器验收已通过；TTS/ASR/图片的真实腾讯调用仍各自以受控供应商脚本验收，尚未合并为同一真实供应商浏览器会话。
2. **生产 PG 全实例指标导出**：`/internal/metrics` 在 Postgres 请求作用域 store 下只反映单账户样本；需独立 Worker 从汇总表导出（OPERATIONS_RUNBOOK 已注明）。
3. C 盘在 2026-09-07 一度 100% 满（已清 npm 缓存腾出 ~1.7G）；建议做一次真正的磁盘清理。

## P2（同日补充）

| 条目 | 交付物 | 验证方式 | 证据边界 |
|---|---|---|---|
| 运营安全流程 | `OPERATIONS_SECURITY_PLAYBOOK.md`（角色权限分离/值班/升级/复盘五段式/审计事实源声明）+ `postmortems/` 目录 | 文档评审 | 单人小团队最小流程，非企业级 SOC；审计靠日志+账本+复盘笔记（如实声明） |
| 真实短信登录 | 腾讯云 SMS 适配器（TC3 复用）+ 随机码发送 + `verify-tencent-sms-provider.js` 真实验收 | `test/auth-sms.test.js`（契约/拒绝映射） | 真实发送验收需开发者本人手机号执行一次并留存 passed 输出 |
| 反滥用 | 挑战频控（1 分钟 5 条/24 小时 10 条）+ 验证码错码 5 次作废 | 同上（防爆破/日限/窗口重置用例） | 无 IP 级限流（本地部署单机现实），生产前置 Nginx/网关层 |
| 站内通知 | `GET /api/v1/notifications` + 已读端点；写点：注销启动、线下订阅人工授予；迁移 050 持久化 | API 回归 + 迁移账本 | 本地封测能力；不等于外部推送通知 |

## 复现命令

```bash
cd apps/api
npm test                      # 263 用例（2026-09-08 当前基线）
npm run eval:all              # 记忆/人格/拒答/时延成本（mock 模式）
npm run test:e2e-browser      # 浏览器全链路（需系统 Edge）
QIYU_LLM_PROVIDER=qwen QWEN_API_KEY=... npm run eval:all   # 真实模型模式（消耗配额）
```
