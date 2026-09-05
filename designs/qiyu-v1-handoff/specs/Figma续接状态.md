# Figma 续接状态

更新时间：2026-09-01

## 已完成

- 文件：`bRwwtQCITo1XLXGfJd6H8d`
- Page：`00 规范与组件`、`01 全状态页面`、`02 主流程演示`
- Variables：92
- Text Styles：11
- Effect Styles：3
- Component Sets：6
  - `Button`：`9:18`
  - `AIGC Label`：`9:24`
  - `Message Bubble`：`9:40`
  - `State Card`：`9:54`
  - `System Notice`：`9:62`
  - `Bottom Nav Item`：`9:70`
- Foundations Frame：`7:2`
- Components Frame：`9:2`

## 未完成与原因

- `01 全状态页面`：42 个静态 Frame 尚未导入；其中 31 个主应用状态带底部导航，11 个准入/创建状态按合同无导航。
- `02 主流程演示`：尚未复制关键 Frame、建立 Prototype reactions 与 flow starting point。
- 组件页截图复核：第一次截图 URL 已返回，但第二次内嵌截图请求触发 Starter MCP 调用上限，未完成模型侧视觉检查。
- HTML 捕获：官方捕获脚本已本地加载，页面序列化启动，但向 Figma endpoint 的两次提交在约 60 秒超时；之后遇到 MCP 调用上限。

## 恢复规则

1. 不创建第 4 个 Page；Starter 单文件只允许 3 个 Page。
2. 不新建 Day/Night Mode；保留两个单模式集合。
3. 优先继续使用现有文件，不新建重复文件。
4. 导入优先顺序：`栖语_V1.2_Figma导入_42Frames_393x852.html` → 12 个分组页降级方案 → 关键主流程手工重建。
5. 只有在 `01` 页面出现 42 个命名 Frame 且 `02` 页面完成主流程连线后，才可把 Figma 步骤标为完成。
6. 导入后把 `size/screen-width/height` 更新为 393/852；59/34 仅是 Figma 安全区参考值，开发读取真实系统 Insets。
