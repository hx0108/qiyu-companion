---
name: figma-ui-dev-handoff
description: 从可点击网页原型、PRD和技术文档生成适合手工导入Figma的全页面与关键状态静态HTML，并产出面向UI和开发的组件规范、状态合同、接口埋点追踪及移动端实现边界。用户提到Figma导入版HTML、动态原型静态展开、MCP受限的手工导入或UI开发交付时使用；不用于仅查看或直接编辑既有Figma文件。
---

# Figma UI 与开发交付

把动态可点击 Demo 转换成两类彼此对齐的正式交付物：可由用户手工导入 Figma 的静态 HTML，以及可供 UI 和开发实施的规格包。手工导入是正式路径，不依赖 Figma MCP 可用性。

## 选择模式

- `figma-import`：只生成全页面与关键状态的 Figma 导入版 HTML。执行前完整阅读 [references/figma-import-html.md](references/figma-import-html.md)。
- `ui-dev-handoff`：只生成静态页面、组件规范、状态合同和开发追踪材料。执行前完整阅读 [references/ui-dev-handoff.md](references/ui-dev-handoff.md)；涉及移动端时再完整阅读 [references/mobile-boundaries.md](references/mobile-boundaries.md)。
- `full`：默认模式，同时执行以上两部分；完整阅读上述三个引用文件。

建立或修改清单、目录和文件关系时，完整阅读 [references/artifact-contracts.md](references/artifact-contracts.md)。

## 共享工作流

1. 读取距离工作目录最近的项目指令，以及用户指定的 PRD、技术文档、原型代码、已有规范和真实资源。
2. 识别动态原型中的路由、状态变量、弹窗、Bottom Sheet、Toast、权限、安全、加载、空、失败和降级分支；不要只截取当前 DOM。
3. 建立 `screen-manifest.json` 作为唯一事实源，再生成 HTML 和规格。旧清单存在时增量维护，保留稳定 ID。
4. 保留原可点击 Demo；除非用户明确要求，不用静态导入版覆盖或削弱它。
5. 按所选模式生成交付物并运行随 Skill 提供的验证脚本。
6. 报告实际生成数量、验证结果和未验证边界。没有完成插件导入、Figma 连线或联合走查时，不声称这些步骤已完成。

## 不可变合同

### Figma 手工导入

- 一个页面或关键状态对应一个独立顶层节点；节点尺寸、状态和内容在导入时已经展开。
- 导入 HTML 不含脚本，不依赖运行时状态，不依赖 CDN、在线字体或远程图片；使用本地或内嵌资源。
- 默认生成一个含全部节点的 HTML，并提供不超过 3 个 Figma Page 的分组映射。只有文件或插件限制确实需要时才增加分组备用 HTML。
- 目标视口来自用户或现有设计，不把某个历史项目的 `42` 屏、`393×852` 或品牌样式写成通用默认值。
- 静态结构验证不等于 Figma 导入成功；导入后的图层名、字体替换、裁剪与 Auto Layout 仍需人工检查。

### 中文命名

- Figma 可读名称必须是中文业务名；顶层 Frame 使用 `模块｜状态`，例如 `年龄｜PASS`、`对话｜暮色私语`。
- 需要在 Layers 中被识别的组件根节点使用 `组件｜变体｜状态`，例如 `按钮｜主按钮｜可用`、`记忆卡｜候选｜待确认`。
- HTML 顶层节点同时写入相同的 `data-screen-name-zh`、`data-figma-name` 和 `aria-label`；组件根节点同时写入相同的 `data-component-name-zh`、`data-figma-name` 和 `aria-label`。
- 稳定机器标识保持 ASCII：`id="Screen--age-pass"`、`data-screen-id="age-pass"`。不要用中文名替代接口、埋点或代码 ID。
- 导入插件如何映射图层名可能不同，因此必须在真实导入后抽查 Layers 面板；若插件不读取上述命名信号，交付导入后的批量重命名映射，不伪称 HTML 能保证插件行为。

### UI 与开发交付

- 页面、状态、组件、接口、埋点和验收条件必须可互相追踪。
- 状态转移、权限、额度、安全门禁、重试和删除等确定性逻辑不能只存在于视觉稿或模型文案中。
- 明确设计值、建议值、待产品确认值和待技术确认值；不得把示例数据写成已实现事实。
- 静态页面说明视觉结果，状态合同说明行为，接口矩阵说明系统依赖；三者不可互相替代。

## 验证

对导入 HTML 运行：

```powershell
python scripts/validate_figma_import.py --html <导入HTML> --manifest <screen-manifest.json> --require-components
```

对清单运行：

```powershell
python scripts/validate_handoff_manifest.py <screen-manifest.json>
```

脚本只做结构性验证。还需通过本地 HTTP 在真实浏览器检查首屏、长屏、小屏、字体、图片、溢出和关键状态；若随后导入 Figma，再检查 Frame 数量及中文图层名。

## 完成条件

- 清单覆盖全部已确认页面和关键状态，未覆盖项被显式列出。
- 静态 HTML 节点数、稳定 ID、中文名与清单一致。
- `figma-import` 输出可脱离脚本独立渲染。
- `ui-dev-handoff` 输出包含所选范围内的组件、状态、接口/埋点、移动端边界和验收材料。
- 验证命令、通过/失败数量和仍需人工完成的 Figma/UI/开发步骤已报告。
