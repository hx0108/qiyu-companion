# 运维 Runbook（P1-6 可观测性配套）

## 指标采集

- 端点：`GET /internal/metrics`（Prometheus 文本格式；与其它 `/internal/*` 相同的审核员 Bearer 边界，未授权返回 401）。
- 指标族：`qiyu_provider_calls_total{capability,provider,outcome}`、`qiyu_provider_latency_ms_sum{capability,provider}`、`qiyu_dead_letters_open{queue}`、`qiyu_deletion_jobs_pending`、`qiyu_image_jobs_inflight`。
- 指标不含消息正文与个人数据；label 只有枚举值。
- **诚实边界**：内存 Store 模式全量可见；Postgres 请求作用域 store 只装载单账户数据，该模式下端点读数是“最近账户作用域样本”——生产全实例口径需要由独立 Worker 从汇总表导出（后续任务），告警规则在生产 PG 模式上线前须先接好该导出。

## 抓取配置示例（Prometheus）

```yaml
scrape_configs:
  - job_name: qiyu-api
    scheme: http
    authorization: { credentials: <reviewer bearer token> }  # 与 /internal/* 同一身份体系
    static_configs: [{ targets: ['api:3000'] }]
rule_files: [monitoring/prometheus-rules.yml]
```

## 告警处置

### 供应商失败率告警
1. `curl -H "Authorization: Bearer <reviewer>" http://api:3000/internal/provider-health` 看分供应商的调用/结果聚合。
2. 区分供应商侧故障（429/5xx，retryable）与响应无效（schema/维度问题，不可重试）：前者看供应商控制台与配额，后者查最近发布。
3. 恢复标准：失败率回落 <10% 且持续 10 分钟。

### 死信处理
- 摘要队列：`GET /internal/conversation-summary-dead-letters` → 一次性人工重放（仅允许一次，见各端点 409 语义）。
- 向量队列：`GET /internal/asset-embedding-dead-letters` → 重放；若因 embedding 模型版本切换导致，先跑 `scripts/rebuild-asset-embedding-index.js`。

### 账户注销清理积压
- `GET /internal/deletion-jobs` 定位 CLOSING 账户；确认 run-workers 的注销清理循环在跑（worker 日志 `[worker] 账户注销清理`）。
- 超 24h 未完成按 P0 删除编排升级（见 DELETION_RECOVERY_DRILL_RUNBOOK.md）。

### 图片任务滞留
- 检查 Worker 图片推进（依赖腾讯图片管线环境变量齐全，缺失时队列跳过）；`docker compose logs qiyu-worker` 过滤 `图片任务`。
