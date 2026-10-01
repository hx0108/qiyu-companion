# 计划与卡片固定回归报告

- 运行时间：2026-10-01T13:30:02.875Z
- 数据：版本化合成固定集（提议回退/schema 拒绝/卡片边界）；不含真实私聊。
- 口径：确定性判定零容差——HTML/链接/未知动作一律拒绝而非转义放行。

| 用例 | 场景 | 实际 | 结论 |
|---|---|---|---|
| PCR-01 | 模型抛错 → 固定三步兜底（MODEL_ERROR） | {"provider":"template-fallback","fallback_reason":"MODEL_ERROR","steps":3} | PASS |
| PCR-02 | 模型输出不合法（步骤含 HTML）→ 模板兜底（VALIDATION 前缀） | {"provider":"template-fallback","fallback_reason":"VALIDATION:steps[0]","steps":3} | PASS |
| PCR-03 | 模型未配置 → 模板（不标 fallback） | {"provider":"template","fallback_reason":null,"steps":3} | PASS |
| PCR-04 | 提议标题含 HTML → 拒绝 | {"ok":false,"fields":"title"} | PASS |
| PCR-05 | 步骤标题含链接 → 拒绝 | {"ok":false,"fields":"steps[0]"} | PASS |
| PCR-06 | 超过 5 步 → 拒绝 | {"ok":false,"fields":"steps"} | PASS |
| PCR-07 | 步骤时长越界（3 分钟）→ 拒绝 | {"ok":false,"fields":"steps[0]"} | PASS |
| PCR-08 | 事件标题含标记起始符 → 整卡拒绝（不是转义放行） | {"ok":false,"reason":"事件标题 不允许 HTML、脚本或链接"} | PASS |
| PCR-09 | 白名单外动作 → 拒绝 | {"ok":false,"reason":"未知动作 EXECUTE_SHELL"} | PASS |
| PCR-10 | Markdown 导出不含链接/标记形态 | {"markdown_head":"# 面试准备","safe":true} | PASS |

共 10 条：10 PASS / 0 FAIL。
固定门禁通过。