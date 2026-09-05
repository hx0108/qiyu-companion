# 栖语 V1.2 原型状态运行覆盖清单（2026-09-05）

> 事实源：`designs/qiyu-v1-handoff/static/screen-manifest.json`、当前 `apps/web/app.js`、API 契约和本次回归。`已实现`指当前开发环境有可重复进入的页面/条件状态；不等于生产验收、供应商验收或视觉像素一致。

| 原型状态 | 当前运行覆盖 | 判定与边界 |
|---|---|---|
| notice-default / notice-ready | 已实现 | 必要告知由 API 返回并记录展示回执，未勾选不能继续。 |
| age-idle / age-pass / age-review / age-denied | 已实现 | Web 以服务端年龄状态和原因码渲染；本地判断不是第三方年龄核验。 |
| age-reviewing / age-appeal | 部分实现 | 可进入 `AGE_REVIEW` 并提交申诉；尚无真实供应商核验会话、材料上传或专属弹窗。 |
| contact-empty / contact-saved | 已实现 | 位于安全中心，独立用途告知、最小字段、掩码返回与删除均有 API。 |
| create-default | 已实现 | 原创/授权确认、人格字段、OC 隔离审核入口可用。 |
| chat-day / chat-night | 已实现 | 同一 API 会话支持主题切换；主题仅为当前渲染会话状态。 |
| chat-image / voice-confirm | 已实现 | 受控图片、ASR 待确认转写均有路径；真实供应商调用需显式配置。 |
| memory-pending | 已实现 | 候选记忆不会自动写入关系资产。 |
| memory-confirmed / memory-dismissed | 部分实现 | 确认、拒绝和时间线刷新已实现；没有独立的“已忽略可撤销”页面。 |
| timeline-all / timeline-memory-empty | 已实现 | API 过滤、空态、修订和在线撤销已接入。 |
| relation-world | 已实现 | 世界状态查看、版本校验编辑、重置均已接入。 |
| trial-active / trial-ending / trial-expired | 已实现（开发态） | API 可一次性发放 7 天试用、额度、无自动扣费、临近 24 小时 `ENDING` 与到期 `EXPIRED`；订阅页有三种状态提示。真实通知调度仍未接入。 |
| subscribe-default / subscribe-renew | 已实现（开发态） | 服务端定价、默认不续费、模拟签名回调和取消续费可测；真实支付关闭。 |
| safety-center / safety-report / safety-complaint | 已实现 | 固定安全入口、举报/投诉和状态查询可用。 |
| safety-2h / safety-r2 | 已实现（开发态） | 服务端时长提醒和固定 R2 响应可测；不代表真实人工响应或外联送达。 |
| data-default | 已实现 | 已有独立数据中心，读取当前留存设置并提供导出入口。 |
| data-delete-confirm / delete-processing | 部分实现 | 二次确认与 API 删除任务回执存在；当前为本地 `ONLINE_DISABLED`，不是生产物理清理。 |
| delete-done | 外部阻塞 | 开发环境不能把生产数据库、备份、向量索引和供应商删除描述为完成。 |
| version-history / version-feedback | 已实现（开发态） | 草稿、评测、影子、≤10% 灰度、稳定和回退状态可测；发布动作尚无 PostgreSQL 专用 reviewer 会话。 |
| media-normal | 已实现（开发态） | 订阅页展示 TTS/ASR/图片权益，私有媒体路径受账户 API 代理读取。 |
| media-image-failed / media-quota / media-tts-failed | 部分实现 | 图片 `FAILED/BLOCKED` 与额度不足、TTS 失败均有无正文专属状态卡。TTS 在本机禁用供应商时已人工验证：文字保留、失败码可见；图片卡目前有 API 与开发壳契约覆盖，仍待独立浏览器场景。 |
| media-asr-failed | 已实现 | 转写失败状态展示原因码，并提供删除原始音频的受控操作。 |

## 当前验收证据

1. `node --test test/*.test.js`：209/209 通过；摘要 DLQ 领域、内部接口与 PostgreSQL 迁移契约均已纳入全量回归。
2. 本机页面：角色档案创建 v2 草稿后，页面显示 `DRAFT`，API 回读 `active_persona_version=1`。
3. 本机页面：数据中心读取服务端 90 天留存，并成功更新为 30 天后重新渲染。
4. 本机浏览器：告知→合成年龄声明→原创角色确认→Mock 对话 SSE→安全中心→数据中心实测；发现并修复 `/api/v1/api/v1/conversation-streams/...` 404，修复后第二条回放消息完整显示且控制台错误为 0。该项仍是人工开发验收，不是自动化 E2E 或真实模型验证。
5. 本机浏览器：在未启用 TTS 供应商的本地服务上点击“生成角色语音”，文字消息仍保留，并显示“角色语音未生成”、安全失败码 `TTS_NOT_ENABLED` 与权益入口。该路径会得到预期的 HTTP 503 能力未启用响应；不等同于腾讯 TTS 的真实故障演练。

6. 固定记忆召回集：3 条确认事实 Top-1 错误为 0；已删除资产、其他账户和其他角色的资产均未进入候选。该项只覆盖确定性召回候选，真实模型最终引用与 Bad Case 另行评测。

## 不可用“开发完成”替代的门禁

- 第三方年龄增强核验的真实断言、申诉材料处理和回调验签；
- 支付宝/微信商户下单、异步通知验签、退款/对账/恢复购买；
- 生产 PostgreSQL、独立 Worker、KMS、备份与供应商删除回执；
- 向量检索；会话摘要的成本金额结算、DLQ 生产告警/独立运营台和真实 PostgreSQL E2E（当前开发 runner 已具备进程内异步任务、PostgreSQL 任务持久化、独立 Worker 角色/租约、无正文 Outbox 事件、摘要、checksum/撤销校验、删除同步、8 次失败后的无正文 DLQ、开发态审核员单次受控重放，以及追加式成功/失败调用指标）；
- 真实模型的多样本人格评测、影子流量、双人审核和发布审批。
