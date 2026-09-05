# 会话摘要 DLQ 重放部署与验收

适用范围：迁移 040 之后的 PostgreSQL 摘要运营处置。该文档不证明迁移、角色、告警或生产演练已经完成。

## 最小权限

1. 应用迁移 034 至 040；在隔离环境先验证每个迁移均有成功记录。
2. 为人工运营登录身份授予 qiyu_summary_operator 成员资格；不得使用 qiyu_app、qiyu_conversation_summary_worker 或通用数据库管理员身份替代。
3. 在 conversation_summary_operator_identities 为该数据库登录身份登记独立 operator_id，并保持 ACTIVE。暂停身份应立即失去函数执行资格。
4. 重放只能调用 app.replay_conversation_summary_dead_letter。应用角色没有该函数权限，运营者也不应直接 UPDATE 摘要任务或死信表。

## 函数门禁

- 仅 attempt_count 至少 8 且 exhausted_at 非空的死信可以重放；
- 每个任务最多一次人工重放；
- 重放前重检账户 OPEN、会话未删除、撤销纪元与源消息边界；
- 理由只在函数内校验并转成 SHA-256；死信、Outbox 和审计事件均不写对话或摘要正文；
- 成功重放后任务回到 PENDING，并写入无正文的 conversation.summary_dlq_replayed.v1 Outbox 事件。

## 上线前验收

1. 使用非 app 角色制造一个已耗尽摘要任务，确认普通应用角色和未映射运营身份均被拒绝。
2. 用已映射运营身份执行一次重放，核验任务状态、理由哈希、Outbox 与审计事件；响应和日志不得包含 p_reason、消息或摘要文本。
3. 再次重放同一任务必须失败；删除源消息、关闭账户或改变撤销纪元后重放也必须失败。
4. 将死信产生和重放事件接入独立告警、值守责任人和演练记录后，才可把该能力作为生产处置流程。
