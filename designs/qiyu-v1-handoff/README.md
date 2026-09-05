# 栖语 V1.2 UI 与开发交付包

本目录保留两类资产：

1. 可点击 Demo：用于产品演示、状态切换和主流程体验。
2. 静态/规范交付：用于 Figma 重建、UI 评审、开发状态与接口对照。

当前交互源文件为 `designs/qiyu-v1-prototype/栖语_V1_高保真原型_v1.2.html`。

## 交付内容

| 资产 | 用途 | 状态 |
|---|---|---|
| [V1.2 可点击交付版](prototype/栖语_V1_高保真原型_v1.2_交付版.html) | 原型演示；支持独立状态 URL 与标注模式 | 已生成并验证代表路径 |
| [独立状态链接目录](prototype/独立状态链接目录.html) | 42 个状态逐页打开；适合 UI/开发评审 | 已生成 |
| [全页面静态展开版](static/栖语_V1.2_全页面静态展开版.html) | 42 个无脚本静态 Frame，供 UI 总览与分组评审 | 已生成 |
| [Figma 导入版：42 Frames · 393×852](static/栖语_V1.2_Figma导入_42Frames_393x852.html) | 只含 42 个屏幕节点，无脚本；插件整页导入 | 已生成并验证 |
| [移动端实现边界板](static/栖语_V1.2_移动端实现边界.html) | 安全区、适配、键盘、大字体、媒体与滚动策略 | 已生成并完成浏览器检查 |
| `static/groups/` | 12 个业务分组的独立静态页面 | 已生成 |
| [组件规范](specs/组件规范.md) | Tokens、组件属性、业务状态合同 | 已生成 |
| [页面—状态—接口—埋点对照表](specs/页面-状态-接口-埋点对照表.md) | 42 状态与技术文档 API 对齐 | 已生成 |
| [联合验收清单](specs/联合验收清单.md) | 产品/UI/开发/测试/合规会签 | 已生成，待真人会签 |
| [移动端实现边界合同](specs/移动端实现边界.md) | 393×852 主基线及真实设备实现规则 | 已生成 |
| [Design Tokens JSON](tokens/tokens.json) / [CSS](tokens/tokens.css) | Figma 与开发共享视觉事实源 | 已生成 |

## 独立 URL

本地启动：

```powershell
python -m http.server 4311 --bind 127.0.0.1
```

工作目录应为 `C:\Users\ASUS\Desktop\AI社交\designs`。

示例：

```text
http://127.0.0.1:4311/qiyu-v1-handoff/prototype/栖语_V1_高保真原型_v1.2_交付版.html?screen=chat-night
http://127.0.0.1:4311/qiyu-v1-handoff/prototype/栖语_V1_高保真原型_v1.2_交付版.html?screen=age-denied&annotate=1
```

- `screen`：取值见 `static/screen-manifest.json`。
- `annotate=1`：显示状态 ID、分组、名称，并描出可操作元素。
- 浏览器控制台也可调用 `qiyuHandoff.open('delete-done', true)`。

## Figma 文件

- 文件：[栖语 V1.2｜UI & Dev Handoff](https://www.figma.com/design/bRwwtQCITo1XLXGfJd6H8d)
- 当前已写入：92 Variables、11 Text Styles、3 Effect Styles、封面、完整 Foundations 文档、6 组本地 Variant 组件。
- Starter 限制：单文件最多 3 个 Page，且变量集合只有 1 个 Mode。因此文件结构固定为：
  - `00 规范与组件`
  - `01 全状态页面`
  - `02 主流程演示`
- 当前阻断：Figma Starter MCP 调用额度已用尽；42 个静态 Frame 的导入和 Prototype 连线尚未写入该文件。

### 配额恢复后的续接步骤

1. 优先将 `static/栖语_V1.2_Figma导入_42Frames_393x852.html` 整页导入 `01 全状态页面`。该文件只有 42 个 393×852 屏幕节点，没有说明页和脚本；若一次捕获过大，再按 `static/groups/` 的 12 个 URL 分批导入。
2. 每个手机 Frame 使用中文业务名，例如 `年龄｜PASS`、`对话｜暮色私语`；稳定英文 `screen-id` 保留在清单和开发映射中。底部导航组件使用 `底部导航｜栏目｜激活`，不得只保留截图；导入 DOM 用作布局参考，正式 UI 使用本地 Variables/Components 重建。
3. 在 `02 主流程演示` 复制以下 Frame 并连接：
   `notice-ready → age-idle → age-pass → contact-empty → create-default → chat-day → voice-confirm → memory-pending → memory-confirmed → timeline-all → relation-world → trial-ending → subscribe-default → safety-center → data-default → data-delete-confirm → delete-processing → delete-done`。
4. 补充失败支线：`age-review / age-denied / age-appeal`、`media-image-failed / media-quota / media-tts-failed / media-asr-failed`、`safety-2h / safety-r2`。
5. 将 Prototype 起点设为 `notice-ready`；安全弹窗和记忆确认使用 Overlay，其余主页面使用 Navigate。
6. 将 Figma Variables `size/screen-width`、`size/screen-height` 从旧 Demo 的 390/844 更新为 393/852；新增安全区参考值 59/34。开发运行时仍读取系统 Insets。

## 构建与验证

重新生成静态资产：

```powershell
node --preserve-symlinks --preserve-symlinks-main designs\qiyu-v1-handoff\scripts\build-static-board.mjs
node --preserve-symlinks --preserve-symlinks-main designs\qiyu-v1-handoff\scripts\build-interactive-v1.2.mjs
```

当前验证边界：

- 静态板结构：42 个状态、12 个分组、无运行脚本、图片引用完整。
- Figma 导入版：42 个独立节点，全部标记为 393×852、顶部 59/底部 34 安全区参考值，0 个脚本。
- 导航审查：31 个主应用状态各有且仅有 1 个底部导航和 1 个激活栏目；11 个告知/核验/联系人/创建状态按准入合同保持无导航。导航组件与 Frame 均携带中文 Figma 命名信号。
- V1.2 浏览器代表路径：年龄 DENIED、夜间对话、删除完成回执已验证；标注模式可见。
- 浏览器验证使用已安装 Chrome 的 headless/CDP 方式；本机 `npx` 包装器损坏，因此没有声称 Playwright 测试通过。
- Figma 视觉截图二次检查因 Starter MCP 调用上限未完成；组件创建工具返回成功，但仍需 UI 在 Figma 客户端做最终视觉检查。

## 交付边界

- 原型中的支付、年龄供应商、ASR/TTS、图片生成、危机联络和删除均为演示状态，不是真实外部服务。
- 联合验收需要真实产品、UI、开发、测试和安全/合规负责人签字；本包只提供可执行的会签材料，不代表已获真人验收。
