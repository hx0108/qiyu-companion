# 运营安全手册（P2-9：值班 / 升级 / 复盘 / 权限分离 / 审计）

适用范围：封闭试用期（邀请制、无支付、本地/单机部署）。目标读者：开发者兼值班人、受邀协助的审核员。诚实边界：本手册是单人小团队的最小可行流程，不是企业级 SOC；真实对外服务前须按 PRD 7.0/7.1 补齐合规结论后再扩展。

## 一、角色与权限分离

| 角色 | 持有凭据 | 可做 | 不可做 |
|---|---|---|---|
| 值班/运维 | 服务器 SSH、`deploy/.env` | 部署、重启、看日志、跑 runbook 处置 | 不持有审核员 token；不读用户消息正文（日志与指标本就不含） |
| 审核员 | `QIYU_REVIEWER_TOKENS` 中的个人 token（`token:reviewer_id` 一人一枚） | `/internal/*` 队列视图、一次性死信重放、人工授予订阅、年龄复核 | 不持服务器权限；不能修改用户数据正文；每次重放限一次（服务端 409 强制） |
| 开发者 | 两者（小团队现实） | 全部 | **同一天内不得既做变更又审核自己变更的队列处置**——自己部署后产生的死信重放，须在日志留痕说明原因 |

实现事实：
- 审核员身份由 `QIYU_REVIEWER_TOKENS` 注入，服务端只认 Bearer token → reviewer_id；默认 `reviewer-dev-token` 仅限本地开发，生产 compose 必须覆盖。
- `/internal/*` 与用户 Bearer 体系完全分离（app.js `requireReviewer`）；审核动作（重放、手工授予）幂等键落库可查。
- 用户数据隔离靠 PG RLS（`app.current_account_id()`）；Worker 走 `qiyu_asset_embedding_worker` BYPASSRLS 专用角色，只授予任务表与向量表的最小列权限（迁移 043）。

## 二、值班（on-call）

- 试用期内值班窗口 = 值班人醒着的时间；夜间不承诺 SLA，次日早处理。
- 每日一次健康检查（≤5 分钟）：
  ```bash
  docker compose ps                       # 三容器状态
  docker compose logs --since 24h worker | grep -E "DLQ|失败|注销" 
  curl -s -H "Authorization: Bearer <reviewer-token>" http://127.0.0.1:$API_PORT/internal/metrics | grep -E "dead_letters|deletion_jobs_pending|image_jobs_inflight"
  ```
- 指标接 Prometheus 后以 `deploy/monitoring/prometheus-rules.yml` 告警替代人工巡检（规则语义见 `OPERATIONS_RUNBOOK.md`）。

## 三、升级路径（severity 定义）

| 级别 | 定义 | 响应 | 升级动作 |
|---|---|---|---|
| SEV1 | 用户安全风险（自伤干预失效、未成年人进入、数据越权/泄露）、删除承诺违反（>24h 未清理） | 立即 | 处置同时留证：日志打包、时间线笔记；必要时直接停服（`docker compose stop api`）保安全弃可用 |
| SEV2 | 单一能力不可用（TTS/图片/摘要队列停摆）、死信持续增长 | 当天 | 按 runbook 处置；两次处置无效 → 降级关闭该能力（feature flag/环境变量） |
| SEV3 | 体验缺陷、可绕过的不影响安全的前端问题 | 48h 内 | 记 Bad Case（`node eval/add-bad-case.js ...`）进正常迭代 |

## 四、复盘（postmortem）

- 触发：任何 SEV1、或同因 SEV2 二次发生。
- 24h 内产出复盘笔记（追加到本目录 `postmortems/`，命名 `YYYY-MM-DD-简述.md`），五段式：时间线 / 影响（用户数、时长、数据后果）/ 根因 / 立即措施 / 防回归措施（须落到测试、评测用例、告警规则或 checklist 之一，写明文件名）。
- 无责原则：聚焦机制缺口；如果是单人操作失误，写明是哪个机制本应拦住它。

## 五、审计（audit trail）

现有可审计事实源（都带操作者/时间）：
- 审核动作：死信重放记录 `last_replayed_by/reason_sha256`（内容权利、摘要、向量三类队列）；手工订阅授予记 reviewer_id。
- 删除链路：删除账本（迁移 048）逐目标回执 + 注销任务状态机 + 备份重放脚本输出。
- 供应商调用：`operationMetrics`（能力/供应商/结果/时延，无正文）。
- 登记要求：SEV1/SEV2 处置后，值班人把“时间、动作、依据、结果”追加到 `postmortems/` 或当日运维笔记；目前没有独立的审计库，日志 + 账本 + 复盘笔记即试用期的审计事实源（如实声明，不虚构已有能力）。

## 六、试用退出前检查单

- [ ] `QIYU_REVIEWER_TOKENS` 已从默认开发 token 切换为个人 token
- [ ] 值班人知道 SEV1 的停服命令与留证步骤
- [ ] Prometheus 告警已接入（或明确记录“未接入，人工巡检”的补偿控制）
- [ ] 最近一次删除演练在 30 天内（`run-deletion-ledger-replay.js`）
