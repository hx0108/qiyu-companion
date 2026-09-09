# 栖语独立运营台（开发验证）

该进程与用户 Web 分离，通过反向代理访问 API 的 `/internal/*` 审核接口。审核令牌仅保存在页面内存，不写 LocalStorage、SessionStorage、Cookie 或日志。年龄/权利决策、摘要与向量 DLQ 单次重放、人格发布状态机均调用既有服务端门禁；投诉、安全和删除异常保持只读。

```powershell
$env:QIYU_OPS_API_BASE_URL='http://127.0.0.1:4310'
node apps/ops/server.js
```

默认地址为 `http://127.0.0.1:4311`。开发令牌由 API 的 `QIYU_REVIEWER_TOKENS` 配置；内置令牌只用于本地测试。生产仍需独立域名、MFA、RBAC、审核员数据库会话和操作审计，当前开发台不得作为生产审核台部署。
