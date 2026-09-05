# Figma 导入版 HTML

## 目标

将动态网页原型中的全部已确认页面和关键状态展开成确定性静态 DOM，使用户可在 Figma MCP 不可用或额度不足时，通过 HTML 导入插件手工导入。它与可点击 Demo 并存，不取代 Demo。

## 先建立状态清单

从事实源提取：

- 路由与标签页。
- 初始、完成、加载、空、失败、降级和权限状态。
- Dialog、Bottom Sheet、Popover、Toast、键盘升起和系统提醒。
- 日间、夜间、订阅、额度、安全、审核和删除状态。
- PRD 明确要求但原型尚未实现的状态；这类状态标为 `planned`，不得伪装成已实现。

动态 SPA 的导入插件通常只读取当前 DOM。必须通过原型状态、渲染函数或已有合同逐一枚举并静态渲染，不能假设插件会执行点击流程并发现所有页面。

## HTML 结构合同

每个屏幕使用一个独立顶层元素：

```html
<section
  id="Screen--age-pass"
  class="figma-frame"
  data-screen-id="age-pass"
  data-screen-name-zh="年龄｜PASS"
  data-figma-name="年龄｜PASS"
  aria-label="年龄｜PASS"
  data-group-id="age-assurance"
  data-group-name-zh="年龄增强核验"
  data-viewport="393x852"
>
  <!-- 完整静态状态 -->
</section>
```

可复用、需要在 Figma Layers 中单独识别的组件根节点：

```html
<div
  id="Component--memory-candidate-pending"
  class="figma-component"
  data-component-id="memory-candidate-pending"
  data-component-name-zh="记忆卡｜候选｜待确认"
  data-figma-name="记忆卡｜候选｜待确认"
  aria-label="记忆卡｜候选｜待确认"
>
  ...
</div>
```

要求：

- `data-screen-name-zh`、`data-figma-name`、`aria-label` 三者使用完全相同的中文名。
- 中文名服务设计协作；ASCII ID 服务代码、接口、埋点和差异比较。
- 不把所有普通 `div` 伪装成组件。只标记确实需要复用、评审或开发实现的组件根节点。
- 一个顶层 Frame 不嵌套另一个顶层 Frame。
- 状态顺序与 `screen-manifest.json` 一致。
- 屏幕间保留足够画布间距，避免插件合并或遮挡。

## 静态与资源约束

- 禁止 `<script>`、事件处理器、运行时模板和异步加载。
- 禁止远程 CSS、JS、字体、图片、视频封面或 SVG 引用。
- 可使用同包相对路径资源或 `data:` URL；交付前验证资源完整。
- 输入框、选中、展开、错误、遮罩等状态直接写入 HTML 属性和 DOM。
- 尽量使用普通 CSS；关键布局不能只依赖插件可能不支持的实验特性。
- 不以截图替代可编辑文本和基本图层，除非该内容本来就是图片资产。

## 中文命名规则

### 屏幕 Frame

- 格式：`模块｜状态`。
- 若需区分层级，可用 `模块｜子流程｜状态`，不超过三个语义段。
- 不在中文名中加入技术路由、序号或 `Screen/` 前缀；顺序和 ID 另存。

### 组件节点

- 格式：`组件｜变体｜状态`。
- 状态可省略，但组件类型不可省略。
- 使用团队理解的业务名，例如“订阅卡”“系统提醒”“消息气泡”，避免无意义的“Group 12”“Frame 83”。

### 插件兼容边界

HTML 导入插件对 `aria-label`、DOM ID 或自定义属性的采用规则并不统一。以上多重命名信号用于提高稳定性，但不能代替真实导入验证。导入后至少抽查：

- 全部顶层 Frame 是否为中文名。
- 标记为 `figma-component` 的节点是否保留中文名。
- 是否出现重复 `Frame`、`Group`、`Rectangle` 等不可读名称。
- 若不符合，依据清单提供“机器 ID → 中文名”的批量重命名表。

## 三个 Figma Page 的分组

默认输出一个全量 HTML，并在 `Figma页面分组建议.md` 中把所有屏幕映射到不超过三个 Page。例如：

1. `01 核心流程`
2. `02 状态与异常`
3. `03 组件与规范`

分组按用户任务和产品结构确定，不机械套用示例。不要因 Page 限制丢失状态。若插件无法处理全量文件，再提供最多三个分组 HTML 作为备用。

## 交付文件

- `<产品>_<版本>_Figma导入_全页面状态.html`
- `screen-manifest.json`
- `Figma导入说明.md`
- `Figma页面分组建议.md`
- `validation-report.md`

导入说明必须写明：推荐插件、导入顺序、资源相对路径要求、目标 Frame 数量、视口、三个 Page 的放置方案、导入后中文命名抽查和已知插件限制。
