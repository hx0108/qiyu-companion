# 产品截图 · 2026-10-22

PNG 由当前 `apps/web` v32 实际渲染生成；不是旧 HTML 原型，也没有通过改 CSS、替换 DOM 或图片后期处理美化。

- 视口：402 × 874 CSS 像素，2 倍像素密度；仅截取应用画布。
- 环境：独立 Microsoft Edge、本机临时 API、一次性内存邀请账号。
- 数据：成年声明、角色、消息和记忆候选均为专用合成夹具；回复为确定性 Mock，不是效果样本或真实用户内容。
- 不访问真实用户账号、线上数据库、物理麦克风或收费供应商。语音页使用浏览器假麦克风与本机 Mock 原生供应商呈现实际通话组件，不代表真实通话质量验收。
- 回忆、通知等空状态如实保留，不伪造使用天数、历史记录或成功结果。
- `manifest.json` 记录捕获时间、文件 SHA-256、前端源文件哈希和环境；不保存邀请码、Token 或浏览器存储。

| 文件 | 画面 |
| --- | --- |
| 01-notices.png / 02-age.png / 03-character.png | 告知、年龄声明与创建角色 |
| 04-chat-day.png / 05-chat-night.png | 同一合成对话的日夜主题 |
| 06-timeline.png | 回忆空状态 |
| 07-character-profile.png / 11-persona-versions.png | 四步档案与独立人格版本 |
| 08-data-center.png | 数据与隐私 |
| 09-home.png / 10-profile.png | 此刻与我的 |
| 12-chat-menu.png / 13-notifications.png / 14-proactive.png | 三点菜单、站内通知、主动消息设置 |
| 15-voice-call.png | 语音通话（假麦克风、Mock 连接） |

复现（项目根目录）：

```powershell
node apps/api/scripts/capture-product-screenshots.js
# 检查 output/playwright/product-screenshots 后，重拍并更新公开资产：
node apps/api/scripts/capture-product-screenshots.js --publish
```

需要先在 `apps/api` 执行 `npm ci`，并安装 Microsoft Edge。脚本只允许同源本机请求；截图验证不是供应商质量、真实手机或法律准入验收。
