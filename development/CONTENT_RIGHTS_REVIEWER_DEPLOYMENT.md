# 内容权利审核员数据库部署与验收

适用范围：`024_development_content_rights_reviewer_boundary.sql`、`025_development_content_rights_revocation.sql` 与 `026_development_content_rights_cleanup_worker.sql` 已由具备 DDL 权限的数据库管理员按顺序应用后，为 OC 与参考图配置独立审核员身份、首次决策、撤销与物理清理路径。本清单不应在本地内存开发模式执行，也不授权应用运行账号批准或撤销审核。固定授权音色的服务端溯源属于迁移 023 的独立边界，不由本审核函数决策。

## 角色边界

| 身份 | 最小权限 | 明确禁止 |
|---|---|---|
| `qiyu_app` | 创建/读取本人 `REVIEW_REQUIRED` 审核；提交申诉 | 更新审核结果、调用任何审核决定或撤销函数、读取其他账户记录 |
| 审核员登录角色 | 成员身份 `qiyu_reviewer`；仅执行受控决策或撤销函数 | 直接 `UPDATE content_rights_reviews`、使用共享数据库账号 |
| 数据库管理员 | 应用迁移；管理审核员身份映射；处理角色撤销 | 代替审核员日常批准内容 |
| 清理 Worker 登录角色 | 成员身份 `qiyu_content_cleanup`；只读取撤销任务、删除对应私有对象并写任务回执 | 批准/撤销审核、修改审核或媒体在线状态、将通用 Outbox 标为已发布 |

## 管理员一次性配置

迁移还会创建无登录且具备 `BYPASSRLS` 的 `qiyu_rights_service` 函数所有者。它只拥有审核函数所需的窄表权限，审核员角色不得成为其成员。应用迁移必须由有权创建该服务角色的数据库管理员执行。

以下 SQL 中的 UUID 是示例格式，必须替换为真实且唯一的审核员内部身份 ID；不要使用用户账户 ID、手机号或任何证件信息。

```sql
CREATE ROLE qiyu_reviewer_li LOGIN NOINHERIT PASSWORD '由密钥管理系统生成并轮换的密码';
GRANT qiyu_reviewer TO qiyu_reviewer_li;

INSERT INTO content_rights_reviewer_identities (database_role, reviewer_id, state)
VALUES ('qiyu_reviewer_li', '00000000-0000-7000-8000-000000000001', 'ACTIVE');
```

审核员使用其专属登录连接数据库；不得以 `qiyu_app`、超级用户或共享运营账号执行决策。撤销权限时先停用映射，再移除成员资格：

```sql
UPDATE content_rights_reviewer_identities
SET state = 'SUSPENDED'
WHERE database_role = 'qiyu_reviewer_li';
REVOKE qiyu_reviewer FROM qiyu_reviewer_li;
```

## 单次审核决策

审核员只调用受控函数。首次决策函数会锁定待审记录、检查审核员身份、写不可变决策、同步 OC 或参考图状态、写审计记录及 `content_rights.review_changed.v1` Outbox 事件。

```sql
SELECT review_id, subject_type, subject_ref, declaration_version, risk_codes, state, decision_reason
FROM content_rights_reviews
WHERE state = 'REVIEW_REQUIRED'
ORDER BY created_at ASC;

SELECT * FROM app.decide_content_rights_review(
  '待审核记录 UUID',
  'APPROVED',
  '已核对授权材料；允许按已声明用途使用。'
);
```

只有 `APPROVED` 或 `REJECTED` 可作为首次决定。再次提交、缺少理由、非审核员会话或非待审状态必须失败；失败不应改变素材状态或产生 Outbox 事件。

## 撤销已批准审核

发现授权失效、投诉成立或用途超出授权时，审核员只能撤销已批准记录，且必须提供原因：

```sql
SELECT * FROM app.revoke_content_rights_review(
  '已批准审核记录 UUID',
  '授权方撤回授权；立即停止使用并发起私有对象清理。'
);
```

撤销 OC 会将导入记录变为 `REVOKED`；撤销参考图会立即把源参考图和仍在线的派生情境图标记为 `DELETED`，使在线读取和后续使用失败关闭。函数同时写审计和带 `physical_cleanup_required: true` 的 Outbox 事件。它不删除 COS/供应商侧物理对象，也不等待回执；这由独立、可重试的消费者负责。

## 验收证据

1. `qiyu_app` 尝试直接更新审核记录或调用函数均被拒绝。
2. 未映射、已暂停或不属于 `qiyu_reviewer` 的登录角色均被拒绝。
3. 审核员批准参考图后：审核记录为 `APPROVED`、对应参考图为 `AVAILABLE`、存在一条审核决策、一条审计及一条未发布 Outbox 事件。
4. 审核员拒绝 OC 后：审核记录和 OC 导入均为 `REJECTED`，角色创建仍被应用层阻断。
5. 审核员撤销已批准参考图后：审核记录为 `REVOKED`，源图及所有仍在线的派生情境图均为 `DELETED`，存在一条 `physical_cleanup_required: true` 的未发布 Outbox 事件和一条撤销审计记录。
6. 非审核员、未映射/暂停审核员、重复撤销或撤销非 `APPROVED` 记录均被拒绝，且不改变素材状态、不产生 Outbox。
7. 生产发布前，Outbox 消费者须处理审核撤销：停止后续生成、撤销在线访问、删除私有对象并记录回执。迁移 025 只产生事件及数据库在线失效，不等同于完成该消费者。

## 私有对象清理 Worker

迁移 026 创建无登录、不可继承的 `qiyu_content_cleanup` 服务角色和带租约的 `content_rights_cleanup_jobs`。数据库管理员应为单独的 Worker 登录角色授予该服务角色成员资格；不得复用审核员或 `qiyu_app` 登录账号。Worker 使用独立连接串 `QIYU_CONTENT_RIGHTS_CLEANUP_DATABASE_URL`，在配置 Tencent 图片链路后执行：

```powershell
node apps/api/scripts/run-content-rights-cleanup-worker.js
```

每次执行最多领取一个任务。成功时它记录已删除资产 ID、时间与数量；失败时保留任务，按指数退避重试。它不会修改 `outbox_events.published_at`，因此不会抢占同一撤销事件未来的缓存失效、审计或其他消费者。必须以真实 COS 删除结果、任务回执和供应商侧证据共同验收；本地测试不构成云端删除证明。

不得在验收查询中导出 OC 原文、参考图对象键、签名 URL、证件资料或任何用户私密内容。
