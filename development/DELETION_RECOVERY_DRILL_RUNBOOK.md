# 数据删除与恢复演练 Runbook（封测 FB 级）

对应 PRD 7.0「备份」行：*保留 ≤30 天；恢复演练 ≥1 次并人工重放删除*。
以及 AC-15 删除回执：删除编排、逐目标账本、备份截止期对用户可见。

## 1. 删除链路现状（本 Runbook 适用对象）

| 作用域 | 在线停用 | 行级清理 | 对象清理 | 回执 |
|---|---|---|---|---|
| 会话（CONVERSATION） | 请求内 | 请求内完成（消息物理删、摘要失效、候选/资产软删） | 不适用（对象不隶属会话） | `deletion_receipt` 请求响应 + `GET /api/v1/deletion-jobs/:id` |
| 媒体（MEDIA） | 请求内 | 请求内软删 | 请求内删私有对象（COS/本地库） | 同上，对象级 `MEDIA_OBJECT` 目标 |
| 关系资产（RELATIONSHIP_ASSET） | 请求内 | 请求内软删 + 向量下线（PG 模式转交 Embedding Worker） | 不适用 | 同上 |
| 账户注销（ACCOUNT） | 请求内（CLOSING，互动立即阻断） | **后台 Worker ≤24h**（消息/摘要/OC 原文物理删，候选/资产/媒体软删，账户置 CLOSED） | Worker 逐对象删除私有桶 | 账本先登记、回执随清理进度更新 |

- 账户清理由 `apps/api/scripts/run-workers.js`（PG 模式）或 API 进程内
  `startAccountDeletionCleanupWorker`（内存模式）执行，幂等可重试。
- 内容权利撤销的 COS 清理走既有 `content_rights_cleanup_jobs` 队列
  （见 `CONTENT_RIGHTS_REVIEWER_DEPLOYMENT.md`）。
- 供应商侧（腾讯 ASR/TTS/混元）留存删除：封测级为人工动作——按合同删除
  条款向供应商提单并回填凭据到 `deletion_targets.provider_receipt`；
  供应商适配器暂无 delete API（公开级前须接入，见 V1_GAP_ANALYSIS）。

## 2. 备份策略（封测级）

- `pg_dump` 每日一次（`deploy/README.md` 运维节），保留 ≤30 天后删除。
- 备份含 `deletion_jobs` / `deletion_targets`（账本随库备份）。
- 账户注销任务的 `backup_deadline` 字段 = 注销清理完成时间 + 30 天；
  备份文件超过该日期必须删除（人工执行并在下方台账登记）。

## 3. 恢复演练步骤（每季度 ≥1 次，或备份策略变更时）

1. **恢复备份到演练库**（不动生产）：
   `pg_restore`/`psql` 到 `qiyu_restored`。
2. **Dry-run 重放删除账本**（默认模式，不改任何行）：
   ```bash
   node apps/api/scripts/run-deletion-ledger-replay.js \
     --source-url=postgres://.../qiyu \
     --target-url=postgres://.../qiyu_restored
   ```
   核对报告：`total` / `applied_count=0` / `skipped[].reason=DRY_RUN`。
3. **Apply 重放**：
   同命令加 `--apply`。核对 `applied_count == total`、`skipped` 为空；
   退出码非 0 表示有失败或未完成账本被跳过——逐条排查，不得忽略。
4. **抽查恢复库**：已注销账户的消息/摘要/OC 原文不可见、媒体行 DELETED、
   账户状态 CLOSED；未注销账户数据原样。
5. **登记台账**：在下表追加一行（日期、操作人、结果、异常）。

## 4. 演练台账

| 日期 | 操作人 | 结果 | 备注 |
|---|---|---|---|
| （首次演练待执行：封测上线后 30 天内） | | | |

## 5. 红线（引用 PRD 7.3）

- 用户删除后确认记忆仍可被在线召回 → 立即限制服务。
- 聊天到期或删除后又被备份恢复重新注入对话 → 本 Runbook 第 3 节即为
  该红线的工程化对策；演练失败未闭环前不得公开上线。
