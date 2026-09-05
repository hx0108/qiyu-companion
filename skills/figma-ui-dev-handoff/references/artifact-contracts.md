# 交付物合同

## `screen-manifest.json`

清单是所有交付物的唯一事实源。新项目从 [../assets/templates/screen-manifest.template.json](../assets/templates/screen-manifest.template.json) 复制；已有项目优先兼容并增量补齐，不随意重命名稳定 ID。

核心字段：

- `schema_version`：清单版本。
- `project`、`version`：产品与交付版本。
- `viewport`：主视口、安全区和适配范围。
- `figma_pages`：最多三个 Page 的中文分组及 Screen 映射。
- `screens`：稳定 ID、中文 Frame 名、分组、来源状态、主题、组件、接口、埋点和验收条件。
- `components`：稳定 ID、中文名、代码名和变体。

## 状态与名称分离

同一对象维护两套名称：

| 用途 | 示例 | 规则 |
|---|---|---|
| 设计端中文名 | `年龄｜PASS` | 面向 Figma Layers、评审和交付 |
| 稳定机器 ID | `age-pass` | ASCII、短横线、版本间稳定 |
| 代码侧名称 | `AgePassScreen` | 遵循项目代码规范 |

禁止把中文名直接作为 API 枚举或埋点 ID；禁止把 `age-pass` 直接显示为 Figma 顶层 Frame 名。

## 来源和完成度

每个 Screen 标记：

- `implemented`：当前原型或代码中可验证存在。
- `designed`：已设计静态状态，但没有可验证实现。
- `planned`：PRD 要求但尚未设计。

生成静态展开版时可以呈现 `designed`，但报告中必须与 `implemented` 分开。

## 变更规则

- 新增状态：新增稳定 ID，并同步 HTML、状态合同和矩阵。
- 修改文案或视觉：不改变稳定 ID。
- 合并状态：保留迁移记录，说明旧 ID 去向。
- 删除状态：先确认 PRD、接口和埋点是否仍引用；未确认时标记 deprecated，不静默删除。
- 页面数量变化：重新运行两个验证脚本，并更新 Figma Page 分组。

## 模板

- [screen-manifest.template.json](../assets/templates/screen-manifest.template.json)
- [组件规范模板.md](../assets/templates/组件规范模板.md)
- [状态合同模板.md](../assets/templates/状态合同模板.md)
- [页面-状态-接口-埋点对照表模板.md](../assets/templates/页面-状态-接口-埋点对照表模板.md)
- [移动端实现边界模板.md](../assets/templates/移动端实现边界模板.md)
- [联合验收清单模板.md](../assets/templates/联合验收清单模板.md)
