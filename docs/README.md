# 栖语文档导航

更新：2026-10-22。本页区分当前维护文档、规范与历史证据，避免旧原型、旧测试数量继续充当当前事实。

## 当前事实源

| 文档 | 职责 |
| --- | --- |
| [当前产品状态](../development/CURRENT_PRODUCT_STATUS.md) | 当前实现、线上公开检查、验证范围、缺口 |
| [PRD](../栖语PRD_v1.3.md) | 产品目标、需求、指标与公开 V1 门禁；开头单列当前封测增量 |
| [技术设计](../栖语技术设计文档_v1.md) | 逻辑合同及当前实际接线；精确路由以 OpenAPI 为准 |
| [OpenAPI](../contracts/openapi.yaml) | 机器可读接口合同 |
| [设计规范](../DESIGN.md) | 杏桃定版与后续用户调整的统一视觉依据 |
| [API](../apps/api/README.md)、[Web](../apps/web/README.md)、[运营台](../apps/ops/README.md) | 各应用运行说明与边界 |
| [PostgreSQL](../infra/postgres/README.md)、[部署](../deploy/README.md)、[运维](../development/OPERATIONS_RUNBOOK.md) | 数据、迁移、故障处理与发布恢复 |
| [可行性分析](../栖语可行性分析_v1.md)、[六项能力](../栖语陪伴_六项能力实施方案_v1.0.md) | 原始决策依据及最新实现状态对照，不冒充业务结果 |
| [评测基线](../development/eval/EVAL_BASELINE.md)、[本轮验证](../development/eval/github-sync-2026-10-22.md) | 可复现检查与证据边界 |
| [截图](screenshots/README.md) | 最新前端真实渲染、合成数据来源和哈希清单 |

## 设计与历史材料

- [杏桃批准原型](../designs/qiyu-apricot-gradient/README.md)：视觉起点，演示数据不是真实服务状态；后续已批准修改以 `DESIGN.md` 和实际 v32 组件为准。
- [当前 UI 状态门禁](qa-state-coverage.md)：旧演示原型门禁已迁移到真实前端；[历史状态合同](archive/v1.2-state-contracts.md) 保留原始验收映射。
- 旧原型与 5 份过时状态台账已按用户确认清理；现在只维护 [固定状态入口](../development/CURRENT_PRODUCT_STATUS.md)。清理前有本地备份，已提交版本仍可从 Git 历史找回。
- `development/eval/` 历史报告：原测试环境、日期、样本与限制不改变；没有重新运行的检查不改写为本轮通过。
- `外部验证包/`：法律、供应商与用户研究材料；模板、委托或公开资料不等于签发意见、供应商批准或真实用户结果。定价测算及报价等私密材料不随公开仓库上传。

## 更新约定

改需求同步 PRD；改接口同步 OpenAPI 和测试；改 UI 同步设计规范、截图和视觉 QA；改上线状态同步当前状态与验证记录。历史文件不反复堆叠“当前”结论；凭据、用户正文、主机私密路径和备份不进入公开报告。
