# 栖语 V1 开发进度差距分析

更新时间：2026-09-05（第五批：审查 GPT 第四批后补齐资产 Embedding 生命周期，测试 215/215，真库 42 个迁移全部实测）。本文对照 `栖语PRD_v1.3.md`（V1功能范围 3.1、验收 9.1–9.4）、`栖语技术设计文档_v1.md`（第 8 节 API 合同、第 6 节状态机）与 `designs/qiyu-v1-handoff`（42 屏原型），盘点 `apps/api`、`apps/web`、`infra/postgres`、`contracts/openapi.yaml` 的实际实现状态。验证方式：`node --test test/*.test.js` 实测；源码逐文件核对。

## 第五批开发记录（2026-09-05，审查 GPT 第四批后补齐，测试 215/215）

22. **审查 GPT 第四批（迁移 031-040）**：人格发布链（草稿→评测→影子→金丝雀→稳定→回退，含 internal 端点）、7 天试用订阅、会话摘要管线（60 轮触发、Outbox、指数退避、DLQ 一次重放、指标）、确定性词法召回排序（`relationship-recall.js`，诚实标注不假装向量）。内存测试全绿；**但 031-040 从未在真库应用**——本批已在真库补齐（零失败）。
23. **资产 Embedding 生命周期（GPT 自述未完成的最后任务，技术设计 6.3.2/7.7/12.4）**：
    - `asset-embedding-worker.js`（对齐会话摘要 Worker 模式）：确认/修订 → `index_state=PENDING` + Outbox 事件（`asset.embedding_requested.v1`）→ 异步建索引 → `READY`；指数退避重试（5 次耗尽）→ 死信 → 运营一次重放（reason 留痕、源撤销拒绝）；commit 时重检资产状态（删除/修订竞态落败）。
    - **删除边界**：删除资产/会话级联时向量立即失效、未完成任务取消，删除任务回执含 `VECTOR_INDEX` 目标（技术设计 8.9）。
    - **混合召回**：READY 资产按向量余弦重排，PENDING/无向量资产保留词法序——**索引未就绪不丢失召回**（技术设计明确要求）。
    - **诚实边界**：开发向量为确定性字符 2-gram 哈希嵌入（256 维、L2 归一化、可复现），保证形状/流程/可审计，**不代表语义质量**；生产必须换供应商 embedding 并按 model_version 全量重建索引（未把 Qwen 冒充向量服务）。
    - 真库端到端实测：向量写入 pgvector（`vector_dims`=256）、index_state 跨事务持久化、存量资产回填路径验证。修复真库实测暴露的 pgvector text 解析 bug（双重包裹数组）。迁移 041（任务+死信表，吸取 029/030 教训：建表同时 GRANT + 正确 GUC）+ 042（`relationship_assets.index_state` 列）。
    - internal 端点：`GET /internal/asset-embedding-dead-letters` + `POST /{jobId}/replay`（与既有审核员身份体系共用）。

## ✅ 真实 PostgreSQL 实测通过（2026-09-05，Docker pgvector/pg16）

在真实数据库上验证了**全部 30 个迁移**（新增 029/030 修复见下）与端到端主链，并修复了三个只在真实库暴露的 bug：

1. **迁移实测**：增量路径（旧库 4→30）与全新初始化路径（init 自动执行 30 个）均零失败；`verify_schema.sql` 完整通过（含 RLS 跨账户隔离 DO 块）。容器 `qiyu-postgres`（端口 5433），连接串见 `infra/postgres/.env`。
2. **修复 ①（迁移 029）**：012+ 新增的 12 张表只建了 RLS 策略、漏授 `qiyu_app` 表级 DML 权限 → 请求作用域 42501。补 `GRANT`。
3. **修复 ②（迁移 030）**：012/013/014/028 的 6 个 RLS 策略误用不存在的 GUC `app.current_account`（基线惯例是 `app.current_account_id()` 函数）→ 这些表恒不可写。统一重建。
4. **修复 ③（代码）**：`server.js` 在 postgres 模式把无内存 Map 的 `PostgresStore` 传给权益服务 → 启动即崩；外层服务现仅内存模式构造。
5. **修复 ④（代码）**：`databaseDate()` 用 UTC 切片解析 pg 的 DATE（pg 按会话时区构造本地午夜 Date），东八区机器日期倒退一天 → `daily_chat_usage` 主键错位 23505；改为取本地日期分量。
6. **修复 ⑤（代码）**：pg 的 `timestamptz` 读回为 Date 对象，`ownCandidates`/`resolveCandidate`/OC 导入 TTL 用 `Date对象 vs ISO字符串` 直接比较（类型不匹配恒 false）→ 候选列表恒空；统一经 `new Date().getTime()` 比较。
7. **端到端主链实测**（`QIYU_PERSISTENCE=postgres`）：告知→年龄→角色（含人格）→会话→消息（世界状态快照）→候选→确认→资产→时间线→每日用量（上海时区正确）；**API 进程重启后角色/会话/消息/候选全部恢复**（跨进程持久化验证通过）。168/168 回归全绿。

遗留说明：早期经 GBK curl 写入的少量中文消息/人格在库中为乱码（测试数据问题，非代码问题）；`migrate.ps1` 对中文路径处理有 bug（已用等效 bash 流程替代执行）。生产部署仍需独立 Worker、备份与监控，本实测不构成生产批准。

## ✅ 封测运营端点已就绪（2026-09-05，个人开发者路线）

针对个人开发者无支付商户/年龄供应商的现实，补齐 PRD 允许的封测期（FB 级）运营闭环，测试 168/168：
- **线下收款人工发放**：`POST /internal/subscriptions/manual-grant`（channel=MANUAL_OFFLINE_PAYMENT，按完整订阅周期入账，reason 留收款凭据摘要）+ `POST /internal/subscriptions/{id}/revoke`（全额退款语义：REVOKED、新预留立即失败、周期退出用户权益视图、append-only 账本保留审计）。封测收款流程：用户人工转账 → 运营发放 → 退款撤销。
- **年龄人工复核**：`GET /internal/age-reviews`（AGE_REVIEW 队列：原因码/请求时间/历史结论）+ `POST /internal/age-reviews/{accountId}/decisions`（PASS 恢复互动 / DENIED_MINOR 阻断但数据权利保留 / MAINTAIN_REVIEW 留痕维持；决策 append-only，迁移 028 表）。
- 上述与既有 content-rights 审核共用审核员身份体系（`QIYU_REVIEWER_TOKENS`）。
- 待办（用户侧重）：注册个体工商户 → 微信/支付宝商户（真实支付）；律师一次性书面意见（H3-FB）；公开上线前年龄第三方断言替换人工复核。

## ✅ 云端受控图片闭环已全线打通（2026-09-05）

两次运行均完整走通并留档：准入→角色→参考图上传（私有 COS 入桶 + IMS 前审 PASS）→审核员权利审核 APPROVED→开发模拟支付入账 15 张额度→**混元生图 3.0 提交→轮询→COMPLETED**→结果图下载入私有桶→IMS 后审→鉴权代理交付（HTTP 200 / image/png / 1.27MB）→浏览器 CSP 内真实渲染（naturalWidth 768）。过程修复：
- **接口迁移**：旧 `hunyuan:SubmitHunyuanImageJob`（产品 1729）已按官方公告 2026-06-22 下线，迁移到 `aiart:SubmitTextToImageJob`/`QueryTextToImageJob`（混元生图 3.0，产品 1668，版本 2022-12-29，参考图走 `Images.N`），tc3 SERVICES 白名单加 `aiart`；状态码与响应字段与旧接口一致。
- **CSP 修复**：静态壳 CSP 的 `img-src`/`media-src` 缺 `blob:`，导致经鉴权代理取得的私有图片/音频对象 URL 无法渲染（naturalWidth=0）；已补 `img-src 'self' data: blob:; media-src 'self' blob:`（供应商与对象存储地址仍被排除，浏览器不得直连）。
- 首张云端生成图存档于 `.qiyu-dev-media/云端闭环首图.png`（768×1024 PNG，带 AIGC 水印请求）。
仍未完成的生产证据：角色身份一致性检测、真实支付渠道、对象存储生命周期/删除回执、生产审计。

## 第三批开发记录（2026-09-05，审查后补齐，测试 166/166 通过）

21d. **混元 CAM 复测与 3.0 迁移（2026-09-05）**：CAM 授权已生效——`SubmitHunyuanImageJob` 错误从 `UnauthorizedOperation` 变为 `ResourceUnavailable.NotExist`；通道探测（`QueryHunyuanImageJob` 假 JobId 返回业务级错误）证明 API 通道正常。**根因查明：旧 `hunyuan:SubmitHunyuanImageJob`（产品 1729）已按官方公告于 2026-06-22 下线**（cloud.tencent.com/document/product/1729/131925），用户开通的后付费在混元生图 3.0（产品 1668，域名 aiart.tencentcloudapi.com）——方向正确。adapter 已迁移到 `aiart:SubmitTextToImageJob`/`QueryTextToImageJob`（版本 2022-12-29，参考图走 `Images.N` 最多 3 张、状态码与响应字段和旧接口一致），tc3 SERVICES 白名单加 `aiart`，166/166 测试通过。**剩余卡点：该 SecretId 的 CAM 身份缺 `aiart:SubmitTextToImageJob`、`aiart:QueryTextToImageJob` 权限**（探测返回 aiart:TextToImage UnauthorizedOperation）；授权后即可完成完整云端闭环。

21. **审查结论**：GPT 第 9–20 项开发经全量测试（159/159）、源码抽查（sendMessage 准入重检/输出门禁/世界状态快照、OC 隔离导入、AI-08 门禁、AI-01 Schema 降级）与浏览器主链冒烟验证，与文档声明一致，质量合格。
21b. **退出意图（AC-10 补齐）**：safety-policy 新增 EXIT_INTENT 检测（与危机表达区分，顺序在 R2/R1 之后），固定响应确认退出且无劝留话术，同时设置账户级 `user_pause_state=PAUSED`（复用既有准入门槛：后续普通消息 403，数据权利与投诉入口保留）。修复由此暴露的死锁：`resume` 端点此前会被自己设置的 PAUSED 拦住——显式恢复现在解除账户级暂停并重新核验年龄/安全/告知（危机模式不因恢复清除）。前端在暂停态显示"恢复互动"入口。集成测试覆盖：退出→阻断→数据权利可用→恢复→继续对话。
21c. **人格行为回归评测集（PRD 4.5 / AI-02，M1 退出门禁）**：`apps/api/eval/persona-regression-cases.js` 固定 23 条用例（关键安全 8 / 退出 4 / 人格边界 3 / 普通回归 8），判定全部为确定性规则（无模型判分，可审计）；`eval/run-persona-regression.js` 跑分入口（默认 mock，`QIYU_LLM_PROVIDER=qwen` 可切真实模型），分类门槛 100%/100%/100%/90%，报告写入 `development/eval/`。当前 mock 基线全部通过；诚实边界：mock 验证系统层门禁而非模型人格服从率，真实模型评测需固定环境多样本。评测已纳入 `node --test` 作为回归门禁。
22. **运营内部接口（技术设计 8.10 首批）**：`/internal/content-rights-reviews` 审核队列与决策端点——独立审核员身份（与用户 Bearer 分离，`QIYU_REVIEWER_TOKENS` 可覆盖），OC 原文仅前 500 字摘要，决策单次不可逆且 append-only 持久化（迁移 024 表）。**解锁 OC 导入与参考图闭环**：APPROVED 后用户可按 import_id 创建角色、参考图资产进入 AVAILABLE 并放行生图权利校验；REJECTED 为终态，申诉留档且队列可见。持久化运行时决策端点返回 503 并指向生产审核台（qiyu_reviewer 会话 + SECURITY DEFINER 函数，与应用角色不可变约束一致）。另含只读 `/internal/deletion-jobs`、`/internal/provider-health`（按供应商/模型聚合调用量与延迟，无正文）、`/internal/feature-flags`。

## 第二批开发记录（2026-09-05 当日完成，测试 158/158 通过）

按"未完成（按严重程度）"顺序完成 1–8 项：

1. **对话主链深化**：新增 `GET /characters`、`GET /conversations`、`GET /conversations/{id}/messages`（游标分页）、`GET /messages/{id}`；`sendMessage` 组装上下文包（技术设计 7.2/7.3 开发子集：最近 20 条对话、角色人格、Top-20 已确认资产）注入 `replyGenerator(text, context)`；Qwen Adapter 把人格档案与确认记忆写入系统段。前端刷新后恢复角色/会话/历史。
2. **人格档案**：PRD 3.2.1 六层用户可编辑字段（世界观/年龄设定/关系/性格/表达方式/硬边界/示例行为）+ 校验；`GET/PATCH /characters/{id}` 乐观并发；每次变更生成不可变版本记录（`persona_versions`，迁移 012）；前端完整创建表单 + 3 套快速模板 + 角色档案页（原型组 04/11）。修复遗留 bug：前端幂等键因 `options.idempotency` 笔误全部发送字面量 "undefined"。
3. **时间线**：`GET /timeline`（筛选 all/memory/commitment/boundary/event，SUPERSEDED/DELETED 不出现）；`PATCH /relationship-assets/{id}` 修订（旧版 SUPERSEDED、新版生效、召回只含新版）；AC-06 冲突检测（bigram Jaccard ≥0.5 标记 conflicts_with，用户决定）；前端时间线页（原型组 07）。
4. **SSE 流式**：POST 消息响应携带一次性 30 秒 TTL 回放令牌；`GET /conversation-streams/{token}` 推送 message.accepted → chunk×N（按句切分）→ message.completed；令牌一次性/绑定账户/过期 410；前端流式逐句渲染。诚实边界：终稿回放，非供应商 token 级实时流（技术设计 7.5 属生产化）。
5. **安全中心**（原型组 03/09 + AC-19/SAFE-03/SAFE-05）：紧急联系人 `GET/PUT/DELETE /emergency-contact`（独立用途告知必选、手机号只回显掩码，迁移 013）；心跳 `POST /interaction-activity/heartbeat`（服务端算连续时长、5 分钟间隔重置、满 2 小时不可关闭提醒、前端 30 秒心跳+覆盖层）；举报/投诉/申诉 `POST/GET /complaints`（默认不带私聊正文）；账户注销 `POST /account-deletions`（二次确认、CLOSING、会话全下线、数据权利与投诉入口保留）。前端安全中心页 + R2 响应展示。
6. **订阅入口**（技术设计 8.7 开发子集）：`POST /checkout-sessions`（金额服务端持有、自动续费默认关）、`POST /callbacks/payments/development-simulated`（HMAC 验签、事件入状态机、APPLIED 时按周期入账）、`GET /subscriptions/current`、`POST /subscriptions/{id}/cancel-renewal`、`GET /entitlements`。TTS/ASR **秒级计量**（分钟×60 入账；TTS 按文本长度预留、ASR 按字节估算秒数，成功提交失败返还；估算口径已注释，生产需供应商 duration）。开发支付通道由服务端预签名回调载荷（密钥不出服务器）。前端订阅页：购买/权益余额/取消续费。
7. **主动消息**（技术设计 8.8 + PRD 3.7）：`GET/PUT /proactive-preferences`（开关/静默时段/时区）、`POST/DELETE /proactive-events`、`POST /proactive-events/{id}/trigger`（模拟触发，规则引擎决定 USER_OPTED_OUT/QUIET_HOURS/DAILY_LIMIT_REACHED，模板措辞无内疚/惩罚话术）、`GET /proactive-messages`；迁移 014。前端主动消息管理页。
8. **生产阻塞项（代码侧）**：鉴权骨架 `POST /auth/sms-challenges|register|refresh`（开发验证码 000000、Access 1h/Refresh 30 天轮换可撤销、限速；仅内存 store）；**TTS 音频交付写入 ID3v2.3 AIGC 标识**（TXXX qiyu_aigc + COMM，不可由下载链路移除，SAFE-10）；**保留期删除 Worker**（进程内定时：30/90 天原始消息 + 24 小时 ASR 原始音频下线；生产需独立队列 Worker）。
9. **本轮审查修复**：迁移 015 将每日普通对话 100 轮/32 万输入 Token 计量落入 PostgreSQL，并仅在发消息时锁定同一账户当日行；迁移 016 显式允许 `DEVELOPMENT_SIMULATED` 本地支付渠道，已签名的本地回调会进入其账户事务。真实渠道、真实数据库迁移和生产运行时仍未启用。
10. **世界状态与媒体快照**：新增角色短期世界状态 `GET/PATCH/reset`（白名单、乐观锁、7 天 TTL、`USER_RESET` 追加审计，迁移 017）；对话上下文只读注入该状态，模型候选不得自行写入。助手回复、TTS 和图片提交均冻结并返回 `world_state_id + world_state_version`；图片情境契约携带受控快照，迁移 018/019 以成对约束持久化。已验证回复生成后的状态变化不会改写后续 TTS 任务的原始状态版本。
11. **会话控制与反馈**：新增 `POST /conversations/{id}/pause|resume`，暂停立即阻断普通消息，恢复重新检查年龄/账户/安全/告知/服务状态；新增 `POST /messages/{id}/feedback`，仅接收助手消息的 OOC、记忆、图片穿帮与不适反馈，并绑定模型/世界状态快照，绝不自动改写关系资产。迁移 020 对反馈施加账户 RLS 与消息/会话删除级联。
12. **OC 隔离导入与权利路由**：新增 `POST /characters/imports`、审核查询与申诉接口及浏览器入口。导入原文仅保存于限期隔离记录，服务端以标签字段提取受控人格候选，默认 `REVIEW_REQUIRED`；候选风险码仅供路由，不能作为权利结论；角色创建只能引用 `APPROVED` 导入。浏览器实际提交合成 OC 后只出现待审、刷新、申诉，没有创建角色动作。迁移 021 将原文存为 `bytea` 开发隔离字段（不是加密），并将应用角色限制为查询/创建待审记录，无法自行批准或拒绝。新增回归还验证：既有会话在年龄状态切为 `AGE_REVIEW` 后，普通消息在审核器和模型调用之前被阻断；Qwen 接线把人格和关系资产标注为不可信数据并转义，不能伪装成系统提示。
13. **参考图独立权利门禁与恢复**：IMS PASS 不再被视为权利结论。上传参考图会创建 `REFERENCE_IMAGE` 的 `REVIEW_REQUIRED` 权利审核记录并保持私有隔离；图片任务必须关联同账户、同素材且 `APPROVED` 的审核记录，校验发生在权益预留和混元调用之前。迁移 022 将媒体资产与审核记录关联，PostgreSQL 写入顺序先保存审核记录再保存引用资产，覆盖真实外键场景；`GET /characters/{id}/reference-images` 只返回本人、当前角色、未删除素材的安全元数据和审核状态，使浏览器刷新后恢复待审/申诉/已通过状态，仍不返回原图、对象键或签名 URL。客户端将待审或 IMS 拦截明确呈现为不可生图状态。
14. **模型输出审核与额度回滚**：同一文本审核适配器按 `INPUT`、`OUTPUT`、`TTS_OUTPUT` 三个方向调用。输入不通过不进模型；模型终稿未通过则原始回复不展示、不持久化、不创建候选记忆、不进入 SSE 回放，并释放该轮普通对话额度；TTS 仍在合成前重新审核。当前 SSE 仍是终稿回放，不是供应商 token 级流式或逐段输出审核。
15. **TTS 音色授权溯源**：真实腾讯适配器不再只接受音色号；必须由服务端固定 `voice_id`、`voice_version`、`authorization_record_id` 和 `rights_review_id`，并只接受 `APPROVED` 审核状态。任务创建时冻结这些字段，迁移 023 以同一约束持久化；历史开发任务保留为未溯源而非被虚假回填为已批准。当前仍缺独立审核员队列和真实数据库迁移应用，故该配置记录不是人工审核完成的外部证据。
16. **AI-08 固定攻击集与输出门禁**：`PROMPT_INJECTION_ATTACK_SET_V1` 固化人格、确认记忆、历史消息和当前输入四种不可信来源。Qwen 系统段始终先声明其不具指令权限；模型若声称已绕过安全/年龄/权限、开放未成年人互动、导出跨账户数据或直接改变长期记忆/权益等系统状态，确定性输出门禁在 TMS 输出审核前阻断原文展示、持久化、候选创建和额度扣减。154/154 本地回归覆盖攻击集、上下文边界及端到端不落原文路径；这不是对真实模型抗注入率或人工红队结果的证明。
17. **AI-01 统一回复 Schema 与降级**：Qwen 工厂要求 `companion_reply.v1`（文本、风格、情绪、语音/图片候选及空的世界/现实动作候选）且拒绝缺失、额外或不合规字段。首次格式失败只追加一次格式纠错请求；第二次失败时返回固定、非模型生成的降级文本并不创建记忆候选，消息标记为非模型生成。155/155 本地回归覆盖一次纠错成功及降级主链；真实 Qwen 对 Schema 的服从率、降级率和延迟仍需云端基准验证。
18. **AI-03 稳定模型路由下界**：供应商注册表要求不可变、非 `latest` 的版本；Qwen 适配器对 `latest` 或任意非批准模型名均固定回 `qwen3.8-flash`，避免环境配置把未评测路由设为稳定版本。156/156 本地回归覆盖该下界；影子流量、灰度、盲测、评测报告关联和一键回退尚未实现。
19. **真实 Qwen Schema 冒烟**：以临时本地内存 API 对一条非敏感普通消息完成告知、年龄、角色、会话和真实 Qwen 调用；结果走 `qwen` 正常路径、`ai_generated=true` 且生成候选记忆，未走 Schema 降级。该单样本不构成模型质量、稳定性、安全或生产验收。
20. **开发期调用指标**：成功对话记录并按账户只读返回供应商、模型版本、输入/输出 Token、延迟、结果状态与时间；不记录消息正文，跨账户查询为空。158/158 回归验证该隔离。当前仅内存、仅文字成功路径，未持久化、未记录媒体/审核/重试成本，也没有真实金额和生产看板。

**仍未完成**（依赖外部资源或属生产化范围）：混元 CAM 权限复测云端图片闭环；真实支付宝/微信支付商户与验签；年龄第三方增强核验供应商；真实 PostgreSQL 迁移应用与独立清理 Worker 部署；供应商 token 级流式+逐段审核；TTS/ASR 供应商精确时长；图片导出元数据标识与 CDN 链路；审核员/清理 Worker 身份配置、真实数据库执行迁移 024/025/026、真实 COS 删除与供应商回执验证、真正加密与留存清理；A/B 实验与人格行为回归评测集；运营内部接口 `/internal/*`；真实短信通道与生产鉴权。

---

## 首次盘点结论（2026-09-04 上午，测试 90/90）

> 此节是当日上午的历史快照，列出的缺口中已有多项在上方“第二批开发记录”完成。它不能作为当前验收结论；当前状态以上方记录、`M1_IMPLEMENTATION_STATUS.md` 与最近一次 `npm test` 为准。

## 一、已完成（有代码与测试证据）

| 模块 | 状态 | 证据 |
|---|---|---|
| 必要告知与年龄基础准入 | 本地完成 | 428 门禁、DOB 状态机（PASS/REVIEW/DENIED_MINOR）、申诉入口；`api.test.js` |
| 文字对话（安全受控） | 本地+Qwen+TMS 已接线 | 确定性 R0/R1/R2、审核 fail-closed、`provider` 落库；`safety-policy`/`qwen-adapter` 测试 |
| 候选记忆→确认→资产→删除→召回撤销 | 本地完成 | 版本冲突 409、30 天 TTL、删除即失效；`api.test.js` |
| 30/90 天保留策略 + 过期清理 | 本地完成 | `retention.js`、`privacy/raw-interaction-retention` |
| 会话删除（级联候选/资产/纪元） | 本地完成 | `deleteConversation`、删除任务回执 |
| 用户语音输入（ASR） | 腾讯真实链路已验证 | 上传→转写→确认→原始音频删除；`tencent-asr-adapter` 测试 |
| 角色语音（TTS） | 腾讯真实链路已验证 | TMS 前置→私有 MP3→鉴权播放→单项删除；`tencent-tts-adapter` 测试 |
| 受控情境图片 | 本地全链+云端前半链 | COS 私有桶、IMS 前后审、参考图授权、额度预留-结算-返还；卡在混元 CAM 权限 |
| 订阅状态机+追加式权益账本 | 本地实现+测试 | 购买/续费/退款/宽限/撤销/幂等、SHA-256 交易引用；`subscription-lifecycle`/`entitlement-ledger` 测试；**无 HTTP 入口** |
| 文本公平使用 | 完成 | 每日 100 轮/320k token 预留-提交-释放；`daily-chat-usage` 测试 |
| PostgreSQL 持久化 | 27 个迁移本地验证 | RLS、账本、订阅、媒体诊断、世界状态审计、消息/媒体快照、反馈记录、OC/参考图权利审核隔离、TTS 音色授权溯源、审核员受控决策、撤销后在线失效与可租约重试的物理清理任务，以及无正文调用指标契约；未应用到真实库 |
| Web 壳 | 本地浏览器主链可跑通 | 告知/年龄/角色/OC 隔离导入/对话/候选/资产/ASR/参考图权利待审/图片/订阅预览 |

## 二、未完成清单

### A. 主链核心缺口（P0 Must，直接决定“AI 陪伴”成立与否）

1. **多轮上下文与人格注入未实现**（最高优先）：`app.js:230` 的 `replyGenerator(text)` 只传当前单条文本；`qwen-adapter.js:41` 的 messages 只有 system+单条 user。无会话历史、无人格档案、无已确认记忆召回（技术设计 7.2 上下文包）。角色实际上“没有记忆也没有人格”。
2. **人格内核完全缺失**（PRD 3.4、技术设计 6.5）：无人格档案字段、无版本化、无评测/灰度/回退。
3. **角色创建只收 name**（`app.js:181`）：PRD 3.2 的身份/稳定特质/硬边界/示例行为/动态状态六层字段、快速模板、OC 结构化导入（`POST /characters/imports`）全部没有。
4. **关系时间线缺失**：无 `GET /timeline`、无时间线 UI（原型组 07）；资产无 `PATCH` 修订/supersede；无冲突检测（AC-06）。
5. **SSE 流式对话缺失**（技术设计 8.4 核心合同）：现为同步阻塞返回，无 `conversation-streams`、无 chunk 事件、无断线恢复。
6. **消息历史读取缺失**：无 `GET /conversations`、`GET /conversations/{id}/messages`、`GET /messages/{id}`——刷新页面历史全丢（前端注释已声明此为有意限制，但 V1 必须有）。
7. **会话暂停/恢复**（pause/resume）与**消息反馈**（穿帮/OOC/记忆反馈，AC-08 依赖）没有。
8. **世界状态缺失**（技术设计 6.7、8.3）：动态情绪/地点/事件无 API（GET/PATCH/reset world-state）、无 UI（原型 relation-world）。

### B. 安全与合规缺口（P0 Must）

9. **紧急联系人**（AC-19）：无 `PUT/DELETE /emergency-contact`、无 UI（原型组 03 两屏）。
10. **连续使用 2 小时提醒**（SAFE-03）：无 heartbeat 端点、无提醒 UI（原型 safety-2h）。
11. **安全中心**：无独立页面（原型组 09 共 5 屏）；R2 固定响应后端有但无专属 UI；举报/投诉无 `POST /complaints`。
12. **账户注销**：无 `POST /account-deletions`。
13. **AIGC 文件元数据标识**（SAFE-04/SAFE-10）：TTS 资产 `aigc_mark_version='not-implemented-development'`；导出文件无元数据隐式标识。

### C. 商业闭环缺口（P0 Must）

14. **支付入口全缺**：无 checkout-sessions、支付回调、purchases/restore、subscriptions/current、cancel-renewal、GET /entitlements——状态机已测但未暴露任何 HTTP 入口。
15. **TTS/ASR 分钟计量未实现**（PRD 3.5：30 分钟 TTS/15 分钟 ASR 每周期）；现只有图片张数与文本轮数。
16. **试用流程**（原型 trial 三屏）无任何实现。

### D. P1 Should 缺口

17. **主动消息**：`proactive-policy.js` 有域逻辑与测试，但无 API（proactive-preferences/proactive-events）、无规则引擎接线、无静默时段。
18. **现实连接**：`reality-actions` 全部没有。

### E. 前端覆盖度：11 路由 / 42 屏 ≈ 26%

| 原型组 | 屏数 | Web 现状 |
|---|---|---|
| 01 告知 | 2 | ✅ 完成 |
| 02 年龄核验 | 6 | 部分：无“核验中”态、申诉弹窗简化 |
| 03 紧急联系人 | 2 | ❌ 缺失 |
| 04 创建角色 | 1 | 部分：仅名字字段 |
| 05 对话与世界状态 | 4 | 部分：情境图不内联对话流、世界状态无 |
| 06 关系记忆 | 3 | 大部分完成；“已忽略可撤销”缺 |
| 07 资产/时间线 | 3 | ❌ 仅有资产列表，无时间线视图 |
| 08 试用与订阅 | 5 | ❌ 仅目录预览，无试用/购买/续费开关 |
| 09 安全与帮助 | 5 | ❌ 缺失 |
| 10 数据中心 | 4 | 部分：保留期+删除回执有；独立页与删除确认流程缺 |
| 11 人格版本 | 2 | ❌ 缺失 |
| 12 媒体状态 | 5 | 部分：失败态有提示；额度耗尽/降级视图不完整 |

### F. API 合同覆盖：约 30/75 端点 ≈ 40%

- 8.2 账户年龄：4/13（缺短信注册、client-attestations、verification-sessions、年龄回调、申诉查询、联系人×2、heartbeat）
- 8.3 角色人格：2/14（缺 OC 导入、权利审核×2、GET/PATCH 角色、人格版本×4、世界状态×3）
- 8.4 对话 SSE：2/10（缺会话列表、消息历史×2、SSE、反馈、暂停/恢复）
- 8.5 记忆时间线：6/8（缺 PATCH 资产、GET /timeline）
- 8.6 媒体：约 7/8（缺签名上传，现为 base64）
- 8.7 订阅权益：2/8
- 8.8 主动/现实连接：0/5
- 8.9 数据权利：4/9（缺注销、投诉×2、导出任务化）
- 8.10 运营内部接口：0/全组

### G. AI 质量与生产化缺口（PRD 第四章/9.2、状态文档“下一优先级”）

19. 人格行为回归评测集、文风门禁、A/B 实验、冷启动/降级——无。
20. 记忆召回算法（技术设计 7.7、pgvector embedding）与摘要管线（7.9）——无，现为结构化资产全量列表。
21. Prompt 注入防线测试（AI-08）——无。
22. 生产鉴权：仅两个写死 dev token；无短信注册、Access/Refresh Token。
23. 混元 CAM 权限（`SubmitHunyuanImageJob`/`QueryHunyuanImageJob`）→ 云端图片闭环复测。
24. 支付商户/渠道密钥、年龄第三方供应商、真实 PostgreSQL 迁移、删除 Worker、对象存储生命周期、备份清理。

## 三、建议开发顺序（下一步）

1. **对话主链深化**：会话历史接口 + 上下文包组装（历史+人格+已确认资产召回）注入模型调用——先让角色“有人格、记得住”。
2. 人格档案字段 + 完整角色创建表单 + 人格版本表（先数据结构，评测/灰度后置）。
3. 时间线 API + UI、资产修订、冲突检测。
4. SSE 流式对话。
5. 安全中心 UI + complaints API + 2 小时提醒 + 紧急联系人（合规 P0）。
6. 订阅 HTTP 入口接已测状态机 + TTS/ASR 分钟计量 + GET /entitlements。
7. 主动消息规则引擎接线（P1）。
8. 生产阻塞项按 `M1_IMPLEMENTATION_STATUS.md` “下一优先级”执行。
