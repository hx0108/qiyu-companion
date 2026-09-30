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
