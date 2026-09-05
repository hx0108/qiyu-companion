# 会话摘要 Worker 开发部署与验收

适用范围：迁移 `034`、`035`、`036`、`037`、`038`、`039` 与 `apps/api/scripts/run-conversation-summary-worker.js`。这是本地/开发 PostgreSQL 的隔离 Worker 边界，不是生产发布批准。

## 角色与最小权限

| 身份 | 可以做什么 | 不可以做什么 |
|---|---|---|
| `qiyu_app` | 在本人事务内创建摘要任务；因删除或 TTL 取消任务；读取自己的摘要 | 领取任务、调用模型、写入完成摘要 |
| `qiyu_conversation_summary_worker` | 带租约领取任务；读取所需源消息；提交或重试摘要；向追加式指标表写入无正文调用事实 | 用户鉴权、支付、年龄核验、媒体删除、修改关系资产、修改既有指标 |
| 数据库管理员 | 顺序应用迁移；为独立 Worker 登录身份授予该服务角色 | 用应用登录账号运行 Worker |

摘要 Worker 必须使用不同于应用的数据库连接串；该登录角色只获得 `qiyu_conversation_summary_worker` 成员资格。不得把 `QWEN_API_KEY`、连接串或用户原文写入部署记录、命令历史或工单。

## 一次性配置

1. 由 DDL 管理员顺序应用 `034_development_conversation_summaries.sql` 至 `039_development_conversation_summary_metrics.sql`。
2. 配置一个独立、受限的 Worker 登录身份，并授予其 `qiyu_conversation_summary_worker`；不可复用 `qiyu_app`、审核员或清理 Worker 身份。
3. 在 Worker 专用运行环境配置 `QIYU_CONVERSATION_SUMMARY_DATABASE_URL`，并按本地 Qwen 开发接线配置 `QIYU_LLM_PROVIDER=qwen` 和密钥引用。生产配置仍须满足供应商、数据处理和删除回执门禁。

## 运行一次

```powershell
cd C:\Users\ASUS\Desktop\AI社交\apps\api
node .\scripts\run-conversation-summary-worker.js
```

每次最多领取一个任务。成功仅输出任务/摘要标识；失败保留任务并按指数退避重试。摘要提交或失败重试会在同一数据库事务向 `operation_metrics` 追加无正文调用事实（供应商、模型版本、输入/输出 token、延迟、结果），不会写入消息或摘要文本，也不会推算成本金额。第 8 次失败会标记任务 `exhausted_at` 并写入 `conversation_summary_dead_letters`；领取查询排除耗尽任务。DLQ 只保存任务/账户/会话标识、尝试次数、受控错误码与时间，不保存消息或摘要正文。当前没有自动重放、告警或人工处置界面，不能通过手工改表绕过撤销、留存或账户状态校验。若账户关闭、撤销纪元变化、会话删除或源消息边界消失，Worker 取消任务，不会写入晚到摘要。

## 验收边界

1. 用合成账户产生满 30 个完成回合，确认任务从 `PENDING` 到 `COMPLETED`，且新摘要来源边界与 checksum 可校验。
2. 在 Worker 提交前删除源会话或改变撤销纪元，确认任务为 `CANCELLED`，不存在新 `ACTIVE` 摘要。
3. 模拟模型错误，确认任务回到 `PENDING`、存在安全长度的错误码且租约释放；不得在日志记录正文。
4. 连续模拟 8 次模型错误，确认任务不再被领取、仅生成一条无正文 DLQ 记录，且无额外模型调用。
5. 用真实 PostgreSQL、独立登录身份、真实 Qwen 响应与迁移回执完成以上验证后，才可称为开发环境 E2E；这仍不是生产批准。
