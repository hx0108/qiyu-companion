# 栖语项目目录

本目录只保留当前产品事实源、外部验证材料、设计交付件和可复现工具。历史原型、旧截图、浏览器缓存与调试目录已清理。

## 产品与技术事实源

- `栖语PRD_v1.0.md`：当前产品需求、范围、指标与验收口径。
- `栖语技术设计文档_v1.md`：架构、接口、状态机、安全与数据设计。
- `栖语可行性分析_v1.md`：产品与技术可行性分析。
- `栖语订阅定价分析.ipynb`：订阅定价测算结果。
- `build_pricing_notebook.py`：定价 Notebook 的可复现生成脚本。

## 外部验证

- `外部验证包/`：法律意见、供应商询价、真实用户验证模板与状态台账。

## 设计与交付

- `designs/qiyu-v1-prototype/栖语_V1_高保真原型_v1.2.html`：当前可点击原型源文件。
- `designs/qiyu-v1-handoff/prototype/栖语_V1_高保真原型_v1.2_交付版.html`：面向评审的可点击交付版。
- `designs/qiyu-v1-handoff/static/栖语_V1.2_Figma导入_42Frames_393x852.html`：手工导入 Figma 的42状态静态HTML。
- `designs/qiyu-v1-handoff/static/栖语_V1.2_全页面静态展开版.html`：UI总览与分组评审版。
- `designs/qiyu-v1-handoff/specs/`：组件规范、移动端边界、状态—接口—埋点映射和联合验收清单。
- `designs/qiyu-v1-handoff/tokens/`：UI与开发共享的设计变量。
- `designs/qiyu-visual-directions/`：已评审的三套视觉方向及原始设计材料。

## 可复现工具

- `designs/qiyu-v1-handoff/scripts/`：V1.2交互版、静态版构建和结构验证脚本。
- `skills/figma-ui-dev-handoff/`：本项目沉淀的Figma静态HTML与UI/开发交付 Skill。

## M1 本地开发切片

- `development/M1_IMPLEMENTATION_BASELINE.md`：本地、合成数据实现的唯一范围；不构成外部封测或公开上线批准。
- `contracts/openapi.yaml`：供本地前端接入的 M1 API 合同。
- `apps/api/`：Node 22 原生 HTTP API 与 `node:test`。默认使用内存合成数据，也可显式接入本地 Docker PostgreSQL；默认回复为确定性 `provider=mock`，并可在本地开发中显式接入 Qwen3.8-Flash。年龄核验、支付与媒体供应商尚未接入，且不存在已批准的生产服务。
- `infra/postgres/`：本地 PostgreSQL 16 + pgvector、迁移、RLS 与 M1 开发持久化验证工具；它是生产持久化的工程基础，不是已批准的生产部署。

启动和测试：

```powershell
cd C:\Users\ASUS\Desktop\AI社交\apps\api
node src\server.js
node --test test\*.test.js
```

在浏览器打开 `http://127.0.0.1:3000/`：API 仅在 localhost 同源托管 M1 Web 壳和白名单静态资源，避免跨端口 CORS。完整端点、开发 Bearer token、幂等与删除状态见 `apps/api/README.md` 和 `contracts/openapi.yaml`。

## 维护规则

- 新版本只保留当前源文件与当前交付件；旧版本进入版本控制或外部归档，不继续堆在工作目录。
- `output/`、浏览器用户目录、缓存、临时截图和调试产物不作为项目资产。
- 删除或改名交付文件时，同步更新 `designs/qiyu-v1-handoff/README.md`、构建脚本和 `_d_meta.json`。
