# 记忆召回固定回归报告

- 运行时间：2026-09-08T01:47:28.848Z
- 数据：版本化合成固定集；不含真实私聊或 Bad Case。
- 覆盖：已确认事实 Top-1、修订替换、删除资产零召回、账户与角色硬隔离；语义改写用例（混合召回层）与跨版本向量隔离守卫。
- 语义向量来源：确定性开发嵌入（语义用例 SKIP）
- 证据边界：此门禁只衡量进入模型上下文前的确定性召回候选；不等同于真实模型最终文本的引用正确率或统计置信区间。

| 指标 | 阈值 | 实测 | 结论 |
|---|---:|---:|---|
| 已确认事实 Top-1 错误率 | ≤2.00% | 0/3（0.00%） | PASS |
| 已删除记忆召回 | 0 | 0 | PASS |
| 跨账户/角色召回 | 0 | 0 | PASS |
| 语义改写 Top-3 命中（qwen 模式计门禁） | FAIL=0 | 0/3 | PASS |
| 跨版本向量隔离（不抛错、不混算、不丢召回） | PASS | 通过 | PASS |

| 用例 | 查询 | 预期 Top-1 | 实际候选 | 禁止命中 | 结论 |
|---|---|---|---|---|---|
| MEM-01 | 下雨天想喝什么茶 | ras_rain_tea | ras_rain_tea, ras_current_city, ras_bookstore_meet | 无 | PASS |
| MEM-02 | 我们约在哪里见面 | ras_bookstore_meet | ras_bookstore_meet, ras_current_city, ras_rain_tea | 无 | PASS |
| MEM-03 | 你现在住在哪里 | ras_current_city | ras_current_city, ras_bookstore_meet, ras_rain_tea | 无 | PASS |
| MEM-04 | 上周一起看电影的计划 | 无（只验禁止项） | ras_current_city, ras_bookstore_meet, ras_rain_tea | 无 | PASS |
| MEM-05 | 下雨天喜欢什么 | 无（只验禁止项） | ras_rain_tea, ras_current_city, ras_bookstore_meet | 无 | PASS |

## 语义改写用例（混合召回层）

| 用例 | 查询 | 预期 Top-3 | 实际候选 | 结论 |
|---|---|---|---|---|
| SEM-01 | 口渴的时候你会给我泡点什么 | ras_rain_tea | — | SKIP |
| SEM-02 | 我们说好到时候在哪儿碰头 | ras_bookstore_meet | — | SKIP |
| SEM-03 | 我如今的落脚点在哪座城市 | ras_current_city | — | SKIP |

固定召回门禁通过。