# 栖语 API 与 Worker

更新：2026-10-22。[当前状态](../../development/CURRENT_PRODUCT_STATUS.md) · [OpenAPI](../../contracts/openapi.yaml) · [部署](../../deploy/README.md)

Node.js 22+ 原生 HTTP 服务，同源托管 Web 与白名单静态资源；独立 Worker 处理摘要、向量、事件/跟进、计划及清理任务。默认使用合成账户、内存和确定性 Mock；可显式接 PostgreSQL 和供应商。开发模式线上邀请封测不等于正式 production 运行时，`PRODUCTION_RUNTIME_NOT_WIRED` 保护仍保留。

## 启动与验证

```powershell
cd apps/api
npm ci
npm start
npm test
npm run test:e2e-browser
npm run test:e2e-ops
```

默认地址 `http://127.0.0.1:3000/`，可用环境变量 PORT 更改。首次必须安装 pg、ws 等依赖，不再是“零依赖 API”。浏览器脚本使用系统 Edge。普通单元/契约默认不外呼；真实供应商验证命令必须另有明确授权与预算，不混入默认测试。

可选 PostgreSQL：先按 [数据库说明](../../infra/postgres/README.md) 初始化/迁移，再从本机环境注入 `QIYU_PERSISTENCE=postgres` 与 `DATABASE_URL`。禁止把连接串、真实邀请码或媒体文件放入仓库。集成回归只连独立本机 `*_test` 库，不能指向在线用户数据库。

## 认证与状态

- 默认本地合成 Token：`dev-alice-token`、`dev-bob-token`，只用于明确标注的合成环境，不能对外冒充身份系统。
- `QIYU_TRIAL_AUTH=invite`：邀请码登录和刷新会话，持久化环境只保存凭据哈希；不是公开注册或第三方实名身份认证。
- 邀请账户直接开放全部已实现能力，无需领取 7 天体验、无体验到期日；图片/语音权益返回 `CLOSED_TRIAL_FULL_ACCESS`。安全、年龄、审核、每日文字公平使用和技术限流保留。邀请码自身可过期/撤销，与权益是否到期是两回事。
- 非邀请模式保留原订阅与体验逻辑；付款接口属于 DEVELOPMENT_SIMULATED，不是真实支付。
- API 和 Worker 同用 `parseDevFlags`：邀请模式启用六项能力；普通开发模式默认关闭，可用 `QIYU_DEV_FLAGS` 和 `QIYU_DEV_FLAG_ACCOUNTS` 显式开关/白名单。
- 所有业务写请求需 `Idempotency-Key`。同键同载荷重放原结果，不同载荷返回 409；资源归属和 RLS 由服务端保证。

## 主要接口分组

路径均以 `/api/v1` 为前缀；精确 Schema 及错误以 OpenAPI 为准，不以本表替代合同。

| 领域 | 主要入口 |
| --- | --- |
| 能力发现/邀请 | GET /trial-access；POST /auth/trial-sessions、/auth/trial-sessions/refresh |
| 告知/年龄 | GET /required-notices、/age/status；POST /required-notices/{id}/displayed、/age/declarations、/age/appeals |
| 角色/历史 | GET/POST /characters；GET /characters/{id}、/conversations、/conversations/{id}/messages |
| 档案/人格 | PATCH /characters/{id}；POST /characters/{id}/persona-versions；POST /characters/{id}/persona-versions/{version}/restore；GET/PUT /characters/{id}/preferences |
| 文字/流式 | POST /conversations/{id}/messages；GET /conversation-streams/{id} |
| 记忆与事件 | /memory-candidates、/relationship-assets、/life-events 及来源/修订/删除子路由 |
| 媒体 | /asr-jobs、/tts-jobs、/tts-stream、/media-assets、/image-jobs 等受控路径 |
| 实时通话 | POST /conversations/{id}/realtime-calls；对应事件流、媒体 WebSocket 与挂断路由 |
| 用户控制 | /notifications、/proactive-preferences、/proactive-events、/companion-plans、/deletion-jobs 等 |

告知和年龄未满足时保留真实阻断。生日声明是当前开发准入，不是第三方增强核验；不保存证件图或人脸模板。接口返回的版本、状态、资源和回执才是前端事实。内存删除的 `ONLINE_DISABLED` 不等于生产物理删除/备份清理已经完成。

## 人格恢复与持久化

当前数据库至迁移 069。用户恢复只能读取本人角色已发布的历史快照，需要当前乐观版本、明确确认和原因；产生新生效版本，保留历史与 `restored_from_version`。请求事务先锁定角色行，保留 RLS、持久化幂等和条件更新。写草稿不变更生效人格；已有快照不能被同步逻辑覆盖。平台升级仍走独立评测/影子/灰度/发布/回滚流程，不因 self-restore 接口而绕过。

测试：`persona-self-restore.test.js`、`pg-persona-self-restore.test.js`、`postgres-store.test.js`。数据库测试缺少 `QIYU_PG_TEST_DATABASE_URL` 会明确跳过。

## 供应商与语音

默认无真实调用。真实接线读取环境变量，不在公开文档保存值：

- Qwen：`QIYU_LLM_PROVIDER=qwen` 与 QWEN_API_KEY / DASHSCOPE_API_KEY；摘要、向量、人格与记忆相关配置见实现和部署模板。
- 腾讯审核、ASR、TTS、COS/IMS/混元：显式 provider 选择与腾讯凭据/地域/BizType，TTS 还需音色及授权/权利审核记录。示例见本目录 `.env.*.example`；示例值不能作为批准证据。
- 原生实时：`QIYU_REALTIME_CALL_ENABLED=1` 与火山适配器配置；需邀请认证、文本审核与供应商可用。旧通话开关 `QIYU_VOICE_CALL_ENABLED` 与原生实时发现字段分别透出，不凭一个 UI 按钮判断全部通路。

消息朗读支持 SSE 首段和任务复用；原生通话使用 PCM/WebSocket、授权重验和背压。历史媒体必须继承原消息世界状态快照，缺失时明确失败。有限摘要/近期上下文和确认资产不是无限记忆或“永不 OOC”的承诺。

审核、安全、额度、权限和错误由服务端执行；不同路线对 PASS/REVIEW/BLOCK 的处理以实际合同/代码为准，不以“供应商已开通”代替审核策略验收。供应商失败不得通过关闭审核绕过。

## 运行与公开边界

`/health` 只证明存活；`/internal/*` 需审核身份，不能公开。真实 Push、短信、收费、全实例监控、生产灾备与真实用户质量需独立证据。公开截图只用本地合成数据，重新生成见 `scripts/capture-product-screenshots.js`。

旧 M1 最小基线、历史供应商探针和当时的权限失败留在 Git 历史/日期报告，不再作为今天“未实现”或“已验收”的依据。
