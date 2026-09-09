# 运营安全手册（P2-9：值班 / 升级 / 复盘 / 权限分离 / 审计）

适用范围：封闭试用期（邀请制、无支付、本地/单机部署）。目标读者：开发者兼值班人、受邀协助的审核员。诚实边界：本手册是单人小团队的最小可行流程，不是企业级 SOC；真实对外服务前须按 PRD 7.0/7.1 补齐合规结论后再扩展。

## 一、角色与权限分离

| 角色 | 持有凭据 | 可做 | 不可做 |
|---|---|---|---|
| 值班/运维 | 服务器 SSH、`deploy/.env` | 部署、重启、看日志、跑 runbook 处置 | 不持有审核员 token；不读用户消息正文（日志与指标本就不含） |
| 审核员 | `QIYU_REVIEWER_TOKENS` 中的个人 token（`token:reviewer_id` 一人一枚） | `/internal/*` 队列视图、一次性死信重放、人工授予订阅、年龄复核 | 不持服务器权限；不能修改用户数据正文；每次重放限一次（服务端 409 强制） |
| 开发者 | 两者（小团队现实） | 全部 | **同一天内不得既做变更又审核自己变更的队列处置**——自己部署后产生的死信重放，须在日志留痕说明原因 |

实现事实：
- **审核员账号体系（2026-09-09 起）**：正式路径为账号登录 `POST /internal/auth/login`——用户名 + 密码（scrypt 哈希落库）+ TOTP 动态码（启用 MFA 的账号，RFC 6238）。失败 5 次锁定 15 分钟；会话令牌 `ops_*` 8 小时有效、可即时吊销（`/internal/auth/logout`）。首个账号用 `scripts/seed-ops-reviewer.js` 引导（避免"无账号无法建账号"），后续账号走运营台 `/internal/reviewer-accounts`（需安全管理员，MFA 密钥只显示一次）。
- 旧静态 token `QIYU_REVIEWER_TOKENS` 保留为开发兜底（本地 `reviewer-dev-token` 持全部角色）；生产部署应改用账号体系并覆盖静态 token。
- **RBAC**：逻辑角色 `REVIEWER / RELEASE / SECURITY_ADMIN`，权限矩阵见 `src/domain/reviewer-identity.js` 的 `PERMISSION_ROLES`（路由层逐条检查，403 明确拒绝）。
- **双人审批**：`PERSONA_STABLE_RELEASE`（人格发布为 stable）与 `SUBSCRIPTION_MANUAL_REVOKE`（人工撤销订阅）执行前须另一名具备权限的账号批准（`/internal/dual-approvals`，24 小时过期，一次性消费）。**单人项目诚实声明：机制要求两个不同账号，但同一自然人可持有多个账号——这是逻辑双人控制，不构成真实组织内的职责分离，对外表述不得写成"双人复核"。**
- **运营审计**：登录成功/失败/锁定、会话吊销、审批申请/批准/驳回/执行、订阅撤销、人格发布、敏感材料调取全部追加写 `ops_audit_events`（PG 迁移 055）：应用角色仅 INSERT/SELECT，UPDATE/DELETE 被行级触发器拒绝（超主亦然）；审计查询走 `/internal/audit-events`（仅安全管理员）。**TRUNCATE 边界**：PostgreSQL 无 TRUNCATE 事件触发器，应用角色已显式无该权限，但表主/超主仍可 TRUNCATE——彻底不可变需外部 WORM/异地归档，列为生产加固项。
- **敏感材料按需解密**：年龄申报材料配置 `QIYU_OPS_MATERIAL_KEY`（64 位十六进制）时以 AES-256-GCM 封装存储，队列视图永不返回原文；调取走 `/internal/age-reviews/{id}/sensitive-material`——先写 `SENSITIVE_MATERIAL_VIEWED` 审计再解密返回。
- **PG 审核员数据库会话**：`qiyu_reviewer` 角色（迁移 024/055）+ 请求作用域 `SET LOCAL ROLE` + `set_config('app.reviewer_id')`，RLS 限定只能读本人账号行、本人参与的审批、（安全管理员）全量审计。容器内 12/12 真实验收：`scripts/verify-reviewer-pg-session.js`。
- `/internal/*` 与用户 Bearer 体系完全分离（app.js `requireReviewer`）；审核动作幂等键落库可查。
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
