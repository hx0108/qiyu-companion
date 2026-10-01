# 栖语当前产品状态（2026-09-17）

> 本文件是截至 2026-09-17 的当前状态入口。它以当前代码、迁移、当前实跑测试、在线健康检查和明确列出的历史受控验收为依据；不将开发/受控验证表述为外部封测、生产可用或真实用户结果。

## 本轮直接复核

| 项目 | 结果 | 证据 | 结论边界 |
|---|---|---|---|
| API 全量回归 | 360/360 通过，0 failed / 0 skipped | `cd apps/api; node --test test/*.test.js`，2026-09-17 实跑 | 覆盖单元、契约和本地集成；不替代真实用户、生产或供应商SLA验收 |
| 远程封测服务健康 | `GET /health` HTTP 200，返回 `mode=local-synthetic-development-only` | `https://qiyu.qualisense.top/health`，2026-09-17 只读检查 | 证明服务可达和当前模式；未在本轮登录、聊天、通话或调用供应商 |
| 陪伴评测数据集 | 96条合成用例：64核心场景、8长期剧本、24TTS盲听脚本 | `development/eval/datasets/qiyu-companion-v0.1/` | 结构化数据集，不等于模型已运行或人工评分完成 |

## 已实现的开发能力

| 能力域 | 当前代码能力 | 主要入口/证据 | 未被此状态页声称的内容 |
|---|---|---|---|
| 对话与人格 | Qwen/Mock回复、SSE、人格档案/版本/回退、用户偏好、高光沉淀候选 | `apps/api/src/app.js`、`domain/persona-release-service.js`、`providers/qwen-adapter.js` | 长期人格稳定率、真实用户满意度 |
| 关系连续性 | 候选→用户确认→修订/删除、摘要、向量索引、跨账户/角色过滤、时间线 | `domain/relationship-recall.js`、`domain/conversation-summary*.js`、迁移041–049 | 真实模型最终引用正确率、生产物理删除SLA |
| 安全与自主性 | 年龄状态、R1/R2、依赖/退出中断、输入/输出审核、投诉、紧急联系人、两小时提醒 | `domain/safety-policy.js`、`domain/access-policy.js` | 临床安全效果、人工危机值守或法律验收 |
| 语音与通话 | ASR确认、TTS情绪/角色性别、流式音频、免提通话、打断、额度与失败返还 | `domain/call-turn-engine.js`、`providers/tencent-tts-adapter.js`、迁移056/059–062 | 全设备兼容、情绪自然度、生产语音SLA |
| 图片与多模态 | 私有图片、审核、参考图权利审核、受控情境图、图像输入、AIGC标识 | `domain/context-image-policy.js`、`providers/tencent-hunyuan-image-adapter.js` | 用户可感知的角色脸部/服装/场景一致性指标 |
| 运营与计量 | 额度账本、试用、通知、运营台MFA/RBAC/双人审批、Worker、指标与告警部署件 | `domain/entitlement-ledger.js`、`domain/reviewer-identity.js`、`deploy/monitoring/` | 真实支付、真实Push、实账对账、实际告警触发与灾备恢复 |

## 当前阻断与优先级

### P0：先收口再扩展

1. 将 `qiyu-companion-v0.1` 通过运行包、实际模型响应和双人盲评闭环；关键Bad Case清零。
2. 建立人格OOC检测、关系情节记忆和多模态一致性门禁的需求/技术/评测合同。
3. 修正历史文档漂移；旧文件中的测试数量、PRD文件名和供应商探针结论不得继续作为当前状态引用。

### P1：外部封测前的外部依赖

外部验证台账中的法律适用性、年龄增强核验、危机SOP、供应商DPA/RFQ、30人U0研究和30–100人封测仍未取得Pass证据。详见 `外部验证包/04_外部验证状态台账.md`。在这些条件满足前，服务保持内部/受控开发定位。

## 维护规则

- 新的实跑证据必须附命令、日期、通过/失败/跳过数量和报告路径。
- 供应商或线上结论必须区分“本轮实测”“历史受控验收”“未验证”。
- 功能上线、模型/Prompt/人格/检索变更后，更新本页并重跑对应评测；禁止只更新展示文案。

## 2026-09-30 决议登记（六项能力开工前收口）

- **基线复核**：`cd apps/api; node --test test/*.test.js`，2026-09-30 实跑 368/368 通过、0 失败、0 跳过（含本页 P0-② 对应的 Phase-2 新测试）。
- **通话范围决定（产品负责人）**：通话按正式验收通道处理——文字非流式、SSE 流式、通话回合三条通道必须接入同一套事件提取、来源记录与输出规则，不静默跳过；通话关闭期间对应路径记录“不适用及关闭验证”。
- **六项能力实施方案**：依据根目录《栖语陪伴_六项能力实施方案_v1.0.md》（2026-09-30）开工，首轮交付 A0 收口 + A1 事件与来源；本地真实 PG 隔离测试库实测纳入本轮验证范围。
- **待人工复核项（登记指派，未销账）**：`development/eval/runs/qwen3.8-flash-conversation-persona-v1-r1/` 的 216 条真实模型运行包（215 条结构化完成、1 条 Schema 兜底）需双人独立盲评与事实依据复核，由产品/评审安排人员；在本完成前不据此宣布外部开放。

## 2026-09-30 A1「生活事件与来源」交付登记（六项能力首轮：A0+A1）

- **范围**：A1 完整闭环（事件提取→用户确认→注入与来源追溯→修订/删除→保留期与注销联动）+ A0 前置收口（见上一节）。A2 跟进调度、A3 计划/卡片/审批、B1 外部日历不在本轮。
- **已实现并验证（本轮实跑）**：
  - 域层与存储：`life-event-schema`/`life-event-service`（投影唯一写者）/`memory-reference-service`/`life-event-extraction-worker`；迁移 063/064（RLS 三段式、UNIQUE(message_id)、终态 CHECK、弱引用无外键）；三集合进 PostgresRequestStore load/flush（提取任务只载在途）。
  - 三通道接线（通话=正式验收通道）：文字非流式、SSE（顺带修复该路径漏设 retention_expires_at）、通话回合（deps 注入）；开关关闭时三通道零任务行。
  - 确认链与路由：confirm/confirm-edited（完整 life_event 字段集）、GET/PATCH/DELETE life-events（409 回传当前值、202 删除回执）、GET memory-references；错误码零新增。
  - 注入与来源：开关开启时 contextPack 增补 asset_id/active_life_events(≤5)/memory_refs，关闭时与既有形状逐字一致（prompt 守门测试）；CONVERSATION_PROMPT_VERSION v1→v2（EVAL_BASELINE 已登记，既有 v1 冻结运行包不受影响）；qwen 提取器（隐私红线入提示词）+ mock 提取器（E2E）。
  - 删除/保留期：retention sweep 联动（引用删/事件 source 置空/任务取消，事件本体保留）、注销账本追加三域、时间线 filter=event。
  - Web：memory-panel 模块（候选确认日期区/来源面板/事件修订 409 保留草稿/删除回执）+ 「本轮参考」入口；三重登记并 bump 20260930-a1。
- **测试（2026-09-30 实跑）**：`node --test` 433 通过 + 4 跳过（PG 专属）+ 0 失败；`test:pg-companion-continuity` 4/4（迁移可执行、RLS 生效、UNIQUE/乐观锁恰一胜、事务原子、20 并发×2000 次混合读写 P95=45-49ms，Docker 临时库 tmpfs）；`test:e2e-companion-continuity` 三轮稳定门禁通过；`test:e2e-browser` 16 步全过。
- **真实验收（2026-09-30 已完成，销账）**：真实 Qwen 提取器验收通过（`development/eval/runs/qwen-life-event-extractor-r1/`，`npm run verify:life-event-extractor`）——10 条固定探针全部成功：候选数 100% 符合期望、域校验 9/9 通过、隐私红线硬断言通过、语义复核合格（时间保守走 raw_time_text 不编造、虚构归属正确、闲聊零误报）。**验收抓到并修复了真问题**：第一轮提示词红线被击穿（title 出现「阿里巴巴」「协和医院」），已加两道防线——qwen 提示词正反例加固 + life-event-schema 确定性机构后缀脱敏（sanitizeLifeEventTitle，仅作用于模型提取路径，用户自编辑不脱敏）。残余风险：无后缀机构简称靠「候选须用户确认才成为事实」兜底。注：.env 的 QWEN_API_KEY 指向已欠费工作空间，验收回落 DASHSCOPE_API_KEY（建议用户清理 .env 中重复失效的 QWEN_API_KEY 两行）。PG 实测覆盖 RLS/约束/并发/原子性，未含多进程 Worker 竞争生产压测。
- **操作口径**：开关（QIYU_DEV_FLAGS/QIYU_DEV_FLAG_ACCOUNTS，默认全关）与任务积压处置见 OPERATIONS_RUNBOOK「生活事件提取开关与任务积压」。

## 2026-10-01 A2「跟进调度」交付登记（六项能力二轮：全量一次闭环）

- **范围**：A2 完整闭环（用户对已确认事件单独授权提醒→到期由规则引擎决定投递→站内消息流一条主动消息→每日一条/静默/竞态硬门禁）。A3 计划/卡片/审批、B1 外部日历不在本轮。核心原则：**确认事件 ≠ 允许提醒**（开启提醒是事件确认之外的单独一次点击）；投递决定权在确定性域函数 `evaluateFollowupPublish`（内存/PG 双侧唯一决策写者），模型只填模板槽。
- **已实现并验证（本轮实跑）**：
  - 迁移 065：`followup_grants`（部分唯一 (event,version,kind) WHERE ACTIVE=一次许可一个在途授权）、`followup_jobs`（七态+租约字段+到期/重领部分索引+UNIQUE(event,version,kind,due_at) 幂等）、`proactive_daily_slots`（PK(account,local_date)=每日一条 DB 原子槽位）；worker 角色 `qiyu_followup_worker`（NOLOGIN BYPASSRLS，036 同款幂等+降级守卫）；三表 RLS 三段式+FORCE。
  - 域层：`followup-schema`（validateFollowupGrantRequest：due_at 缺省派生 BEFORE_EVENT=事件准点/AFTER_EVENT=事件后 2 小时；due_at≤now 硬拒不补发过时；BEFORE_EVENT 要求事件 PLANNED）、`followup-service`（grantFollowup 幂等重放+同 kind 重开=supersede 撤旧授权/取消旧任务；修订/删除联动撤销返回计数；evaluateFollowupPublish 全分支：删除/版本不符/未开户/暂停/安全非 R0/年龄复核/告知未展示/ Opt-out→CANCEL，超窗/每日超限→EXPIRE，静默→DEFER 精确顺延到静默结束且不耗 attempts）、`followup-composer`（模板槽基准+可选模型槽内改写+三路回退，事件标题子串防脱校验）、qwen 适配器 createQwenFollowupComposer（模板仍为放行后基准路径）。
  - 内存 Worker + PG repository：60s 批 50、租约 300s、3 次指数退避≤expires；PG 侧 claimDueBatch `FOR UPDATE SKIP LOCKED` 双 Worker 不相交、publish 账户行 FOR UPDATE+守卫 UPDATE 0 行即 throw（请求侧恰一胜）、槽位 ON CONFLICT 恰一胜（输家 EXPIRED 零投递）。
  - API（FOLLOWUP_DISPATCH 开关门禁）：PUT/GET/DELETE `/life-events/{id}/followup`（201 带 `channel:'IN_APP', push_configured:false` 仅站内声明；409 回传 current_event；202 撤销回执）；PATCH/DELETE 事件响应带 `followup_invalidated` 计数；timeline LIFE_EVENT 条目附 followup 概要；手动 triggerProactiveEvent 与 Worker 共享同一每日槽位（双向频控）。
  - Web：「主动」导航入口+铃铛图标；消息流 provider='proactive-followup' 带「主动」角标；时间线事件卡「提醒我/关闭提醒」开关（带 expected_version，409 提示刷新）；改期取消任务后「为新时间重新开启提醒」确认卡；主动页注明跟进消息写进聊天流、此处仅审计与频控统计源；三重登记 bump 20261001-a2。
- **测试（2026-10-01 实跑）**：`node --test` 474 用例 / 465 通过 / 0 失败 / 9 跳过（跳过=两个 PG 专属套件需 DATABASE_URL，预期行为；新增 followup-schema/service/composer/worker/http 五个内存套件）；`test:pg-followup` 5/5（迁移 065 可执行+RLS/FORCE/BYPASSRLS、双连接并发 claim 不相交、并发 publish 抢槽恰一胜且输家 EXPIRED 零投递、runNext 全旅程含模板措辞/来源引用绑定事件版本/审计/槽位归属赢家/同日第二任务 EXPIRED、静默 DEFER 精确顺延、租约过期重领 attempts 累计——Docker 临时库 tmpfs）；`test:e2e-companion-continuity` 门禁通过（A1 三步+A2 三步 PASS：开启提醒落库、到期投递主动角标+来源面板、同日第二任务 EXPIRED 不补发；0 控制台错误、0 服务端 5xx，报告 `development/eval/browser-e2e-2026-09-30.md`）。
- **边界与残余风险**：模型改写槽未做真实 Qwen 验收（模板措辞为已实测基准路径，模型槽失败三路回退到模板）；E2E 的主动消息可见性依赖用户回到应用时拉取历史（无推送、前端不轮询——站内投递的产品语义，E2E 以 reload 模拟）；PG 实测覆盖单进程内双连接竞态，未含多进程生产压测。
- **操作口径**：开关（QIYU_DEV_FLAGS 增 `FOLLOWUP_DISPATCH`，默认关）与任务积压/FAILED 处置见 OPERATIONS_RUNBOOK「跟进调度开关与排障」。

## 2026-10-01 A3「计划、卡片与站内审批」交付登记（六项能力三轮：能力四/五/六）

- **范围**：A3 完整闭环（共同小计划 INTERVIEW_PREP_V1 + 交互成果卡片三固定组件 + 最小 action gate 参数绑定审批）。B1 外部日历不在本轮。核心原则：计划建议不自动成为用户承诺（草案→接受才建立）；卡片是事件/计划的视图不存第二份可编辑事实；角色提议不等于执行成功——用户确认的是具体对象、参数和影响。
- **已实现并验证（本轮实跑）**：
  - 迁移 066（companion_plans 部分唯一 (account,event) WHERE 非终态=一事件至多一个未终结计划、companion_plan_steps UNIQUE(plan,step_order)、artifact_cards 一源一卡薄表——内容永不落库 GET 现场渲染、operation_metrics 增 COMPANION_PLAN_PROPOSAL）/067（action_requests 九态+parameters_digest+全量幂等唯一+15 分钟惰性过期）；无新 Worker 角色（计划全部由用户操作驱动的请求事务完成；投递归既有 followup worker）。
  - 域层：plan-schema（模板白名单首批仅 INTERVIEW_PREP_V1，医疗/危机/法律/财务靠无对应模板结构性排除；模型提议输出拒 HTML/链接/越界）、plan-service（投影唯一写者：草案 supersede/五操作状态机/事件联动；accept 可选 followup 子对象复用 A2 全量裁决记 linked_grant_id；暂停经新 revokeFollowupGrantById 只撤那一条——同事件独立许可存活；恢复不补发；完成需步骤全终态或显式 confirm）、artifact-card（消毒拒绝而非转义；动作白名单映射真实路由按源状态收敛；Markdown 导出）、action-gate（注册表首批仅 ACCEPT_PLAN→WRITE_MEMORY；canonicalParametersDigest 服务器规范化哈希；approve 短事务重验 digest/过期/目标版本/账户准入；recordTransparentAction 同一次确认=审批+执行两状态且白名单只约束显式入口）、plan-composer 三路回退（LISTEN_ONLY 不调模型零待办）；qwen createQwenPlanProposer + mock 提议器。
  - API（三平级开关 COMPANION_PLANS/ARTIFACT_CARDS/ACTION_EXECUTION）：计划 10 路由+卡片 1（format=json|markdown）+审批 4；五条计划 action 成功后透明留痕（失败不占幂等键）；事件确认路径急切建卡片身份行；PATCH 事件转 CANCELLED 响应带 plans_paused、DELETE 带 plans_cleaned_up。
  - 数据权利补缺（用户拍板）：注销账本补 A2 欠账三域（followup 许可/任务/槽位）+A3 四域，关系档案导出增 life_events/followups/companion_plans/artifact_cards/action_requests 五段（审批无参数正文）。
  - Web：「计划」主导航；草案卡步骤行内编辑（change 即存）+接受时「到期提醒我」勾选（接受≠自动开提醒）；聊天卡片消息 provider=companion-card 惰性水合——定点替换节点绝不整树重渲染（组合输入/焦点/滚动不受打扰，E2E 硬门禁）；时间线事件卡「一起准备」「查看卡片」；卡片 bottom-sheet+Markdown 导出；三重登记 bump 20261001-a3。
- **测试（2026-10-01 实跑）**：内存全量 517 用例 / 508 通过 / 0 失败 / 15 跳过（三个 PG 套件需 DATABASE_URL，预期；新增 plan-schema/plan-service/artifact-card/action-gate/plan-composer/companion-plans-http/a3-deletion-links 七套件）；`test:pg-companion-plans` 6/6（迁移+RLS/FORCE、部分唯一、action 幂等唯一、乐观锁恰一胜、复合 FK、域层全旅程含暂停撤 linked 恢复不补发；编排脚本加连接预热后连续三轮稳定）；`test:e2e-companion-continuity` 门禁通过（A1 三步+A2 三步+A3 四步 PASS：草案可编辑接受+勾提醒落库、暂停撤 linked 恢复不补发、卡片水合+组合输入保持、事件取消联动+未知动作 400+ACCEPT_PLAN 审批执行；两轮稳定，报告 `development/eval/browser-e2e-2026-10-01.md`）；`test:e2e-prototype-states` 42/42。
- **探查副产品（如实登记）**：A1 PG 套件的「RLS 生效」用例实际测的是事务隔离（superuser 绕过 RLS，未提交行对另一连接本就不可见）；本轮 A3 PG 用正确手法（SET LOCAL ROLE qiyu_app + app.account_id）做了真实 RLS 过滤断言。A1 该用例的强化留待下轮（2 行改法已知）。
- **边界与残余风险**：qwen 提议器（模型槽）未做真实验收——mock 提议器与模板三步为已实测路径，真实模型输出由 validatePlanProposalOutput 拒不合法形态（未实测真实返回分布）；无后台清扫（DRAFT 30 天/action 15 分钟均惰性裁决，残留行由注销/保留期收口）；卡片导出为文件下载，不写入外部系统；A2 遗留的「读路径可见性依赖用户回到应用」语义在卡片上相同（reload 拉历史）。
- **操作口径**：三开关关闭语义、DRAFT 过期、action 15 分钟与无 Worker 运维含义见 OPERATIONS_RUNBOOK「计划与卡片开关排障」。
