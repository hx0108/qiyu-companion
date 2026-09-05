# 栖语 PostgreSQL 基础设施

这是生产持久化的本地、合成数据基础：PostgreSQL 16 + pgvector、版本化/软删除实体、RLS 第二道租户隔离，以及幂等、删除、Outbox 和追加式审计表。`age_decisions` 只保存最小判定、理由码、方法、交易引用、策略版本与时间边界；禁止保存证件图、人脸模板、生物样本、出生日期或供应商原始载荷。它不连接模型、年龄核验、支付或媒体供应商，也不包含任何真实密钥。

## 本地启动

```powershell
cd C:\Users\ASUS\Desktop\AI社交\infra\postgres
Copy-Item .env.example .env
# 将 .env 中的 POSTGRES_PASSWORD 改为本地开发密码
docker compose up -d
docker compose ps
```

首次创建 Docker 卷时，`init/00-extensions-and-roles.sql` 会创建 `pgcrypto`、`pgvector`、`app.uuid_v7()` 和非 owner 应用角色 `qiyu_app`；`init/01-run-migrations.sh` 随后按文件名顺序运行 `migrations/001_core_schema.sql` 与 `migrations/002_row_level_security.sql`。已有卷不会重新执行初始化脚本，新增迁移请运行：

```powershell
.\scripts\migrate.ps1
```

该脚本以数据库内 `schema_migrations` 账本跳过已应用文件；迁移必须只追加新文件，不能修改已经在任一环境执行过的 SQL。

执行结构、约束、版本递增、候选记忆确认边界和跨账户/角色 RLS 验证：

```powershell
.\scripts\verify.ps1
```

验证在一个事务内写入两组固定 UUID 的合成记录，并总是 `ROLLBACK`，不会留下测试数据。

## API 连接约定

业务 API 应连接为 `qiyu_app`，并在**每一个事务**、在任何查询之前通过参数化 SQL 绑定鉴权后的 UUID：

```sql
SELECT set_config('app.account_id', $1, true);
SELECT set_config('app.character_id', $2, true); -- 角色范围操作必填
```

不能将客户端传入的账户或角色 ID 直接写进该会话变量。Repository 仍必须显式传递并核验账户/角色范围；RLS 是第二防线。后台迁移、删除 Worker 与 Outbox 发布器应使用单独的最小权限角色，不能复用应用用户。

`relationship_assets` 的线上召回应固定使用账户、角色、`state='ACTIVE'`、`deleted_at IS NULL` 和有效时间过滤；候选记忆不会进入召回。`memory_candidates` 只有 `last_transition_actor='USER'` 时才可确认，确认资产只有 `activation_actor='USER'` 才可处于 `ACTIVE`。

## 运维边界

- Docker named volume 是本机开发便利，不等同于生产备份、HA、密钥管理或区域部署。
- 生产密码、TLS、备份/KMS、连接池、细粒度 worker 角色、监控和灾备策略必须由部署环境提供，禁止放入本目录。
- `audit_events` 通过触发器拒绝更新和删除；审计保留或合法保全应由单独、经过审批的维护流程处理。
