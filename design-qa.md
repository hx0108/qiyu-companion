# Design QA — AI 回复框与微型语音播放按钮

- Source visual truth: `C:\Users\ASUS\.codex\generated_images\01a093ec-b35b-7062-875d-4f73db4469ff\exec-31d1fc5e-249d-49ca-8681-11ea1f37a0f7.png`
- Implementation: `http://127.0.0.1:3000/`
- Implementation screenshot: Codex in-app Browser current-turn capture（未持久化到磁盘）。
- Viewport: 栖语现有 393 × 852 CSS px 移动端界面；浏览器画布完整显示设备内容。
- State: 日间主题、单行 AI Mock 回复、语音尚未生成。

## Findings

- 无剩余 P0/P1/P2 问题。
- 字体与排版：保留项目原有中文衬线正文、暖白正文和灰紫动作描写层级；本次没有修改字体或行高。
- 间距与布局：播放控件改为绝对定位，不参与文档流；40 × 24 px 可见胶囊嵌在右下角，44 × 44 px 透明点击热区保留可用性。
- 色彩与材质：回复框继续使用 `#1d1e20` 哑光近黑；按钮仅使用低对比炭灰层次，与回复框连续。
- 图标与资产：继续复用项目现有 `player-play-filled.svg`，显示尺寸缩至 10 × 10 px；未使用文字、时长或波形。
- 文案与内容：回复文案、动作描写规则和语音无障碍名称保持不变。

## Focused comparison evidence

- 选定稿采用右侧边缘半嵌结构，按钮与最后一行并列，不新增底部一行。
- 最终浏览器画面中，回复气泡保持单行高度；文字完整显示，播放按钮位于同一行最右侧。
- 58 × 42 px 的局部暗色承托贴合 40 × 24 px 胶囊，没有形成大面积独立底栏。
- 点击播放入口会进入现有语音额度流程；返回对话后组件位置与尺寸保持稳定。

## Comparison history

- P1 — 旧版 96 × 60 px 控件作为块级子元素占据回复框底部一整行。已改为右下角绝对定位，脱离文本排版。
- P1 — 首轮绝对定位让按钮覆盖了回复文字。已把 AI 消息最大宽度调整为 100%，并为含播放控件的回复框增加 60 px 右侧安全区；复核后文字与按钮不再重叠。
- P2 — 旧版可见胶囊 64 × 36 px、承托区 108 × 72 px，视觉过重。已缩为 40 × 24 px 可见胶囊和 58 × 42 px 局部承托，同时保留 44 × 44 px 点击热区。

## Verification

- `node --test test\\voice-reply-ui.test.js`: 4/4 passed.
- 本地浏览器：AI 回复文字完整、播放按钮无可见标签/时长、按钮不独占底部行。
- 交互：播放入口可触发现有语音额度流程，返回对话后布局稳定。

final result: passed
