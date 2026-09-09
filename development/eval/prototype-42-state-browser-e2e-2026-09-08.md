# 栖语 V1.2 原型 42 状态浏览器门禁

- 运行时间：2026-09-08T19:33:45.230Z
- 环境：系统 Edge 无头，逐个打开独立状态 URL，并开启标注模式。
- 边界：验证交付原型状态可达性和渲染结构；不替代 Web/API、真实供应商、支付、年龄核验或生产删除验收。

| ID | 页面 | 结论 | 说明 |
|---|---|---|---|
| notice-default | 告知｜未确认 | PASS | — |
| notice-ready | 告知｜可继续 | PASS | — |
| age-idle | 年龄｜待核验 | PASS | — |
| age-reviewing | 年龄｜核验中 | PASS | — |
| age-pass | 年龄｜PASS | PASS | — |
| age-review | 年龄｜REVIEW | PASS | — |
| age-denied | 年龄｜DENIED | PASS | — |
| age-appeal | 年龄｜申诉弹窗 | PASS | — |
| contact-empty | 联系人｜未保存 | PASS | — |
| contact-saved | 联系人｜已保存 | PASS | — |
| create-default | 创建角色｜默认 | PASS | — |
| chat-day | 对话｜日间 | PASS | — |
| chat-night | 对话｜暮色私语 | PASS | — |
| chat-image | 对话｜情境图已交付 | PASS | — |
| voice-confirm | 语音输入｜确认转写 | PASS | — |
| memory-pending | 记忆｜候选确认 | PASS | — |
| memory-confirmed | 记忆｜已确认 | PASS | — |
| memory-dismissed | 记忆｜已忽略可撤销 | PASS | — |
| timeline-all | 时间线｜全部 | PASS | — |
| timeline-memory-empty | 时间线｜记忆空态 | PASS | — |
| relation-world | 关系｜世界状态 | PASS | — |
| trial-active | 试用｜进行中 | PASS | — |
| trial-ending | 试用｜即将到期 | PASS | — |
| trial-expired | 试用｜到期降级 | PASS | — |
| subscribe-default | 订阅｜¥39 月度方案 | PASS | — |
| subscribe-renew | 订阅｜明确开启续费 | PASS | — |
| safety-center | 安全与帮助｜稳定入口 | PASS | — |
| safety-2h | 安全｜连续 2 小时提醒 | PASS | — |
| safety-r2 | 安全｜R2 固定响应 | PASS | — |
| safety-report | 安全｜举报内容 | PASS | — |
| safety-complaint | 安全｜服务投诉 | PASS | — |
| data-default | 数据中心｜默认 | PASS | — |
| data-delete-confirm | 数据中心｜删除确认 | PASS | — |
| delete-processing | 删除回执｜处理中 | PASS | — |
| delete-done | 删除回执｜已完成 | PASS | — |
| version-history | 人格版本｜变更记录 | PASS | — |
| version-feedback | 人格版本｜异常反馈 | PASS | — |
| media-normal | 媒体｜正常 | PASS | — |
| media-image-failed | 媒体｜图片失败返额 | PASS | — |
| media-quota | 媒体｜图片额度耗尽 | PASS | — |
| media-tts-failed | 媒体｜TTS 失败降级 | PASS | — |
| media-asr-failed | 媒体｜ASR 失败降级 | PASS | — |

状态：42/42 PASS
浏览器控制台错误：0

42 状态浏览器门禁通过。