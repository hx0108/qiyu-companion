# 栖语 M1 本地合成 API

这是 `development/M1_IMPLEMENTATION_BASELINE.md` 的服务端最小闭环：必要告知、开发年龄准入、单角色、默认确定性 Mock 对话（可显式接入 Qwen3.8-Flash）、候选记忆确认、账户隔离、在线撤销与幂等。

它**不是生产服务**：默认使用内存中的合成数据，也可显式使用本地 Docker PostgreSQL；`provider: "mock"` 不是模型调用，Qwen 路径仅限本地开发外呼；开发年龄判断不是第三方核验；`ONLINE_DISABLED` 删除任务不表示生产物理清理完成。

## 生产服务接入前门禁

`src/production/` 定义真实供应商接入前的配置与 Adapter 合同，不保存供应商 SDK 凭据或明文密钥。所有外部高风险能力默认关闭：`LLM_CHAT`、`CONVERSATION_SUMMARY_WRITE`、增强年龄核验、支付、ASR、TTS、图片生成、文本审核、图片审核。生产进程 (`NODE_ENV=production`) 必须提供 `QIYU_PROVIDER_CONFIG_JSON`，且每一项已启用能力均需绑定供应商，并具备：不可变具体版本、处理地域、密钥引用（而非密钥值）、已批准且版本化的数据政策/DPA、供应商删除回执合同；年龄与支付还必须配置签名、时效和防重放的回调验签信息。缺任一项将拒绝启动。

这只是工程门禁，不表示供应商已采购、合同/法务门禁已通过，亦不会使当前本地 Mock 或 Qwen 开发接线变成生产服务。
即使供应商配置完整，当前 `src/server.js` 也会以 `PRODUCTION_RUNTIME_NOT_WIRED` 拒绝 `NODE_ENV=production` 启动，直到真实持久化、身份认证、队列/删除 Worker 与真实 Adapter 被明确接线并验收。

### 订阅与媒体额度账本（本地开发内核，含模拟支付，未接真实支付）

`src/domain/entitlement-ledger.js` 实现三阶段媒体额度账本：已验证支付事件才可写入 `GRANT`；媒体任务以 `job_id:RESERVE` 原子预留，并在成功交付时 `COMMIT` 实际用量，或在失败、审核拒绝与取消时 `RELEASE` 全额返还。每条记录均追加，重复动作返回原条目，实际用量不得超过预留量。

`infra/postgres/migrations/008_development_entitlement_ledger.sql` 为本地 PostgreSQL 路径提供账户级 RLS、追加式约束、幂等唯一索引和禁止更新/删除触发器；表中不保存支付渠道原始回调、卡号、银行账户或密钥。`src/domain/media-entitlement-service.js` 已将已验证订阅周期的媒体额度与图片任务接线：供应商调用前 `RESERVE`，私有落桶和 IMS 后审均通过才 `COMMIT`，提交失败、审核拒绝或任务失败则 `RELEASE`。`checkout-sessions` 和 HMAC 回调只服务于 `DEVELOPMENT_SIMULATED` 本地测试通道；它不构成支付宝/微信支付接入、真实收费或生产权益发放。

`src/domain/subscription-lifecycle.js` 与迁移 010 增加了付款前订单、订阅状态与渠道事件隔离模型：客户端无法提交价格，默认不自动续费；只有 `verified: true` 的规范化事件才能从 `PENDING` 进入付费状态。购买/续费/恢复可产生供账本使用的稳定来源事件，未知、未验签、乱序状态、跨账户交易或事件载荷冲突一律不发权益。渠道交易引用和事件指纹只保存 SHA-256 哈希；当前尚未实现支付宝或微信的签名验证、下单、退款、对账与沙箱联调。

图片任务的外部错误对用户 API 保持泛化；`provider_error_code` 仅在服务端任务状态与迁移 009 中保存经过格式校验的供应商错误码，绝不保存错误正文、URL、请求签名或凭据。当前真实探针已确认 COS 与 IMS 前审可用，但混元提交返回 `AuthFailure.UnauthorizedOperation`；须为所用 CAM 身份授予 `SubmitHunyuanImageJob` 与 `QueryHunyuanImageJob` 后再复测。

配置仅可提供密钥**引用**，例如 `secret://qiyu/providers/text-primary`，不能把 API Key 写入 JSON、代码或日志。启用文本模型时的最小形状为：

```json
{
  "featureFlags": { "LLM_CHAT": true },
  "providerBindings": { "LLM": "text-primary" },
  "providers": [{
    "id": "text-primary",
    "capabilities": {
      "LLM": {
        "version": "model-2026-09-01",
        "region": "cn-north-1",
        "credentialRef": "secret://qiyu/providers/text-primary",
        "dataPolicy": { "approvalState": "APPROVED", "policyVersion": "policy-2026-09", "dpaVersion": "dpa-4", "effectiveAt": "2026-09-01T00:00:00Z", "trainingUse": false, "crossBorder": false, "deleteSlaHours": 24 },
        "deletion": { "supported": true, "receiptRequired": true, "deleteSlaHours": 24 }
      }
    }
  }]
}
```

## 启动与测试

要求 Node.js 22 或更高版本；不需要安装或下载任何 npm 依赖。

```powershell
cd C:\Users\ASUS\Desktop\AI社交\apps\api
node src\server.js
node --test test\*.test.js
```

服务默认只监听 `http://127.0.0.1:3000`。打开该地址即可得到 `apps/web` 的同源开发壳；可用 `$env:PORT=3100; node src\server.js` 更改端口。

### Qwen3.8-Flash 本地开发接线

已实现 Qwen OpenAI-兼容 Chat Completions Adapter。它只在 `QIYU_LLM_PROVIDER=qwen` 时启用，且只从进程环境读取 `QWEN_API_KEY`（或 `DASHSCOPE_API_KEY`）；密钥不会写入项目、响应或日志。项目外的凭据文件可通过下列启动器加载到**当前进程**：

```powershell
cd C:\Users\ASUS\Desktop\AI社交\apps\api
.\scripts\start-qwen-dev.ps1 -Port 3102
```

该路径固定使用 `qwen3.8-flash`，以非流式、`enable_thinking: false` 的方式发送受限上下文包（角色人格、有效会话摘要、摘要边界之后最多 20 条会话历史、最多 20 条已确认资产和当前用户文本），并丢弃任何未在正文中的推理字段。每累计 30 个完整回合，聊天事务只写入摘要任务；开发摘要 Worker 在独立定时循环中以受限提示生成一份可撤销摘要。删除、TTL、撤销纪元或 checksum 不匹配会使它立即退出上下文，任务则取消或重试。助手消息记录 `provider: "qwen"` 和供应商返回的模型版本。它是本地开发外呼，不是生产启用：不得把对话、身份或支付数据用于未批准用途；生产接入仍需要不可变模型版本/地域、供应商数据政策与删除回执、真实鉴权和独立删除 Worker。

### 确定性安全中断（开发）

在调用任何模型前，服务会用固定规则识别明确自伤自杀、重大财产风险、高困扰与依赖表达。R2 风险进入 `R2_CRISIS` 并停止普通角色互动；R1 进入 `R1_SUPPORT`；依赖提醒不进入模型。中断响应使用 `provider: "safety-policy"`、`ai_generated: false`，不会创建候选记忆。该规则集仅覆盖固定开发安全集，不是临床分类器、危机干预服务或 H3-FB/PUB 验收通过证明；生产仍需经审核的策略、人工升级、紧急联系人 SOP、审计与演练。

### 腾讯云文本审核（本地开发预接线，默认关闭）

`QIYU_TEXT_MODERATION_PROVIDER=tencent` 才会创建腾讯云 TMS Adapter；需要由已批准的业务密钥管理系统注入 `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TENCENT_REGION` 和 `TENCENT_TEXT_MODERATION_BIZ_TYPE`。它不是生产开关，也不应在 RFQ、DPA、审核策略版本和删除条款未通过前设置。启用时，确定性安全中断仍优先；TMS `Review`、`Block`、超时或错误不会将文本送给 Qwen，并且不生成候选记忆。供应商选型、RFQ 条件和支付/媒体未接通范围见 [`../../development/SUPPLIER_ONBOARDING_AND_RFQ.md`](../../development/SUPPLIER_ONBOARDING_AND_RFQ.md)。

本地联调不会自动启用审核。先在腾讯云控制台创建并记录审核策略的 `BizType`，再在项目外凭据文件加入 `TENCENT_TEXT_MODERATION_BIZ_TYPE=<BizType>`；随后显式运行：

```powershell
.\scripts\start-qwen-dev.ps1 -Port 3108 -EnableTencentTextModeration
```

启动器仅将所需变量带入该进程，不写入仓库；首次调用只能使用合成、非敏感文本。

### 腾讯云 ASR 媒体链路（本地开发预接线，默认关闭）

`POST /api/v1/conversations/{conversationId}/asr-jobs` 仅接收当前账户会话的一段短音频：受限 MIME（`audio/mpeg`、`audio/wav`、`audio/x-wav`、`audio/mp4`、`audio/aac`、`audio/ogg`）和 Base64 后不超过腾讯一句话识别限制的开发字节上限。服务先写入不受静态资源服务器暴露的本地私有媒体库，再调用腾讯 `SentenceRecognition`；转写返回 `PENDING_CONFIRMATION`，不会自动发送给模型或写入记忆。`POST /api/v1/asr-jobs/{jobId}/confirm` 支持用户修订转写，并立即在线撤销、尝试删除原始音频。API 不返回对象键、文件路径或公开下载 URL。

真实 ASR 必须显式运行 `-EnableTencentAsr`。启动器将使用 `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TENCENT_REGION`；可选 `TENCENT_ASR_ENGINE_MODEL_TYPE` 默认为 `16k_zh`。腾讯账户还须开通语音识别并向该密钥所属身份授予 `asr:SentenceRecognition` 权限。示例：

```powershell
.\scripts\start-qwen-dev.ps1 -Port 3109 -EnableTencentTextModeration -EnableTencentAsr
```

该路径是本地同步 Runner，仅面向短语音联调。它没有生产签名上传、恶意文件/时长探测、异步队列、配额扣减、音频审核、对象存储生命周期、供应商删除回执或 24 小时 TTL Worker，不能当作生产 ASR 交付。

### 腾讯云 TTS 媒体链路（本地开发预接线，默认关闭）

`POST /api/v1/messages/{messageId}/tts-jobs` 只接受当前账户自己、已由 AI 生成的助手消息。服务端先在不受静态资源服务器暴露的本地私有媒体库写入任务清单，再对该助手文本执行 TMS 输出审核；仅 `PASS` 才调用腾讯 `TextToVoice`，并将 MP3 写入私有对象键。API 只返回任务与资产元数据，绝不返回文件系统路径、对象键或公开音频 URL。客户端播放时只能通过当前账户鉴权的 `GET /api/v1/media-assets/{assetId}/content` 读取自己的已生成 MP3，响应为 `private, no-store`，不适用于用户上传的 ASR 原音频；`DELETE /api/v1/media-assets/{assetId}` 会立即从在线查询撤销并尝试删除本地私有对象。

真实 TTS 仍需显式设置 `QIYU_TTS_PROVIDER=tencent`，并在项目外凭据文件提供 `TENCENT_TTS_VOICE_TYPE`（从腾讯云已开通的音色列表选择）、`TENCENT_TTS_VOICE_VERSION`（供应商音色目录或合同版本）、`TENCENT_TTS_AUTHORIZATION_RECORD_ID`（腾讯标准音色服务授权/订购记录 ID）及 `TENCENT_TTS_RIGHTS_REVIEW_ID`（已批准的内部权利审核记录 ID）。后三项缺失时适配器拒绝启动，不能以客户端音色参数或“已开通”替代留痕。可选的 `TENCENT_TTS_MODEL_TYPE` 与 `TENCENT_TTS_SAMPLE_RATE` 分别默认 `1` 和 `16000`。本地启动示例：

可复制字段清单见 [`.env.tencent-tts.example`](.env.tencent-tts.example)；其中不含腾讯密钥，示例值不能直接用于启动。

```powershell
.\scripts\start-qwen-dev.ps1 -Port 3109 -EnableTencentTextModeration -EnableTencentTts
```

默认此路径是“与文字主链分离的本地同步 Runner”：文字回复已完成后才单独请求语音，失败会返回可查询的 `FAILED` 任务而不回滚或阻塞文字。默认媒体库仅用于本机开发；显式传入 `-EnableTencentCosMediaStore` 后，TTS MP3 与 ASR 原始短音频才会写入 COS 私有 `qiyu/media/` 前缀，浏览器仍只能经过当前账户鉴权的 API 代理读取，永不获得 COS URL。配置样例见 [`.env.tencent-media-store.example`](.env.tencent-media-store.example)：需私有广州桶、`QIYU_PRIVATE_MEDIA_STORE=tencent-cos`（启动脚本自动注入）和最小 COS 读写删权限。

```powershell
.\scripts\start-qwen-dev.ps1 -Port 3109 -EnableTencentTextModeration -EnableTencentTts -EnableTencentAsr -EnableTencentCosMediaStore
```

COS 路径仍是本地同步联调：不含生产队列、真实 PostgreSQL、生命周期策略、供应商删除回执、音频内容审核或完整 AIGC 文件标识，不能当作生产媒体交付。

### 腾讯混元 / COS / IMS 受控图片链路（本地开发，默认关闭）

图片链路需要一次性显式启用 `-EnableTencentImagePipeline`。启动器只从项目外凭据文件带入 `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TENCENT_REGION`、广州地域私有 COS 桶及 IMS 图片 `BizType`；完整字段见 [`.env.image-pipeline.example`](.env.image-pipeline.example)。`TENCENT_REGION`、`TENCENT_HUNYUAN_REGION`、`TENCENT_COS_REGION` 必须均为 `ap-guangzhou`，否则服务拒绝启动。

浏览器入口为“受控情境图”：用户先声明参考立绘授权，再由服务端写入固定 `qiyu/images/` 私有前缀、生成短时审核 URL 并执行 IMS 前审。仅 `PASS` 的 `USER_CONFIRMED` 参考图可提交 `POST /api/v1/characters/{characterId}/image-jobs`；请求只使用地点、服装、时间和已确认关系资产构成情境契约。混元结果只在服务端下载、私有入桶、IMS 后审通过后，才能由当前账户的 `GET /api/v1/media-assets/{assetId}/content` 代理读取。响应永不返回 COS 对象键、签名 URL 或腾讯临时结果 URL；删除图片会在线撤销并调用 COS 删除私有对象。

```powershell
.\scripts\start-qwen-dev.ps1 -Port 3110 -EnableTencentImagePipeline
```

这仍不是生产生图验收：当前已完成本地状态机、私有存储约束和 UI 验收；一次合成参考图云端探针的 COS 上传与 IMS 前审成功，但混元异步任务为 `FAILED`，未保存结果图。下次探针必须记录安全失败码，且仅使用合规、非敏感测试立绘。生产前仍需要身份一致性、额度预留/补偿、异步队列、可重试 Worker、生命周期与供应商删除回执。

### PostgreSQL 开发持久化（可选）

默认仍使用内存 Store。迁移并启动本地合成 PostgreSQL 后，可显式切换开发 API：

```powershell
$env:QIYU_PERSISTENCE='postgres'
$env:DATABASE_URL='postgresql://postgres:your-local-development-password@127.0.0.1:5432/qiyu'
node src\server.js
```

连接字符串只能来自本地环境或密钥管理系统，不能提交到仓库。Docker 开发连接先取得非登录 `qiyu_app` 的成员资格，再在每个已鉴权请求事务内 `SET LOCAL ROLE qiyu_app` 和参数化设置 RLS `app.account_id`；只支持固定合成 Bearer 账户、默认 Mock 或显式 Qwen 开发接线。`NODE_ENV=production` 仍会硬拒绝启动。迁移 `003` 是基础 API 字段兼容层，`007` 追加图片任务状态，`011` 关联媒体任务权益，`015` 为每账户每日普通对话计量建立 RLS 行与约束，`016` 只显式允许本地 `DEVELOPMENT_SIMULATED` 支付渠道，`017` 保存短期世界状态及追加事件，`018` 让媒体任务持久化成对的世界状态 ID/版本快照，`019` 保存生成助手回复的状态快照并供 TTS 继承，`020` 保存会话暂停与助手回复反馈，`021` 隔离 OC 原文并记录内容权利审核/申诉；应用角色对权利审核只有查询与初始请求权限，不能自行批准。 本机尚未初始化 PostgreSQL 时不会自动应用迁移。

该服务仅白名单托管 `/`、`/app.js`、`/styles.css`、`/tokens.css`（以及现有样式中精确引用的 tokens 路径），并不提供目录浏览或任意文件读取。`/api/v1` 仍先走 API 路由和 Bearer 鉴权，未配置跨域访问。

## 前端接入合同

机器可读合同是 [`../../contracts/openapi.yaml`](../../contracts/openapi.yaml)。前端只能依据此合同调用 `/api/v1`，不得本地推断年龄、告知、记忆确认、删除完成或账户范围。

开发鉴权固定且仅限本地合成账户：

| Bearer token | 合成账户 |
|---|---|
| `dev-alice-token` | `acct_dev_alice` |
| `dev-bob-token` | `acct_dev_bob` |

所有写操作都需要 `Idempotency-Key`。同一账户、方法、路径和键配相同 JSON 负载返回首次结果；同键不同负载返回 `409 IDEMPOTENCY_CONFLICT`。

推荐主路径：

1. `GET /api/v1/required-notices`，用 `POST /api/v1/required-notices/{noticeId}/displayed` 写入相同 `notice_version` 的回执。
2. `POST /api/v1/age/declarations` 提交成人开发声明；只有 `AGE_PASS` 可创建角色、会话、消息和处理候选记忆。生日变更、无效声明或 `POST /api/v1/age/appeals` 会进入 `AGE_REVIEW`，返回最小原因码并保持伴侣互动关闭；这不是供应商年龄断言，也不接收证件/人脸数据。
3. `POST /api/v1/characters` 创建唯一活跃角色；随后 `POST /api/v1/conversations`。
4. `POST /api/v1/conversations/{conversationId}/messages` 仅在模型终稿通过 `OUTPUT` 文本审核后才返回默认 Mock 或显式启用的 Qwen 回复与 `CANDIDATE`；未通过时返回固定审核说明，原始模型文本不会暴露或持久化，且本轮额度会释放。响应中的 `provider` 与 `model_version` 由服务端事实写入。
5. 用 `confirm` 或 `confirm-edited` 使候选转为关系资产；`reject` 不产生资产。仅 `ACTIVE` 资产会出现在 `GET /api/v1/memory-recall`。
6. `DELETE /api/v1/relationship-assets/{assetId}` 会立即使资产退出在线列表/召回，并返回 `state: ONLINE_DISABLED`、新的 `revocation_epoch` 和 `physical_cleanup_state: NOT_IMPLEMENTED_LOCAL`。

所有错误使用 `{ "error": { "code", "message", "request_id", "retryable", "details" } }`。其中普通互动被必要告知阻断时固定为 `428 REQUIRED_NOTICE_PENDING`；无/未知 token 是 `401 AUTH_REQUIRED`。
