# 运维 Runbook（P1-6 可观测性配套）

## 指标采集

**当前封测补偿控制：人工巡检，不是 Prometheus 已接入。** Compose 尚未部署 Prometheus/Alertmanager；每次试用前及每日检查 API/Worker 健康、`/internal/provider-health`、待处理删除/图片任务、Worker 错误日志与宿主磁盘。只有独立导出和告警服务实际运行后，才可改写为“监控已接入”。

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

### 生活事件提取开关与任务积压（六项能力 A1）
- 关闭开关：清掉 `QIYU_DEV_FLAGS` 里的 `LIFE_EVENTS`/`MEMORY_REFERENCES` 并重启——提取立即停止（三通道不再入队）、事件/引用路由按不存在处理；已确认事件与引用快照作为用户数据保留（数据权利不随开关变化）。
- 任务积压：`SELECT account_id, count(*) FROM life_event_extraction_jobs WHERE state='PENDING' GROUP BY 1;`（PG 模式）。run-workers 未配置提取模型（QIYU_LLM_PROVIDER/QWEN_API_KEY）时跳过提取队列，任务会等待模型可用或被保留期清扫取消（`CANCELLED`，原因 `source message retention expired`）。
- `FAILED` 任务（3 次退避耗尽）留在 `life_event_extraction_jobs` 表供任务台查询；不自动重放，人工确认原因后可按 message_id 手工补录候选。提取失败不阻塞聊天主链路。

### 跟进调度开关与排障（六项能力 A2）
- 关闭开关：清掉 `QIYU_DEV_FLAGS` 里的 `FOLLOWUP_DISPATCH` 并重启——followup 路由按不存在处理、Worker 不启动；在途任务留在 `followup_jobs`（PENDING 不再被领取，不产生半发布状态）；已发布的主动消息不撤回（用户数据），事件与许可记录保留。
- 任务积压：`SELECT account_id, state, count(*) FROM followup_jobs WHERE state IN ('PENDING','LEASED') GROUP BY 1,2;`（PG 模式）。`PENDING` 堆积先查 Worker 是否在跑（run-workers 日志，`FOLLOWUP_DISPATCH` 开启时才启动）；`LEASED` 长期滞留=租约 300 秒过期后被其他 Worker 自动重领（进程崩溃恢复路径），无需人工介入。
- `FAILED` 任务（3 次指数退避耗尽，`last_error` 留痕）留在 `followup_jobs` 供任务台查询；不自动重放。`EXPIRED`（窗口已过/`DAILY_LIMIT_REACHED`/静默窗结束仍超时）是正常频控终态，不是故障。
- 每日一条槽位核查：`SELECT * FROM proactive_daily_slots WHERE local_date = CURRENT_DATE;`——手动触发接口与 Worker 共享该槽位；若怀疑漏发，先看槽位是否已被占（`claimed_by` 指向当日已发布的 job）。
- 静默时段投诉排查：账户静默偏好在 `accounts.proactive_preferences_json`（HTTP 校验起止小时必须 0-23 且不同；被静默抑制的任务 DEFER 到静默结束的精确时刻，`next_attempt_at` 可查，顺延不消耗重试次数）。

### 计划与卡片开关排障（六项能力 A3）
- 开关矩阵：`COMPANION_PLANS`（计划全部路由）/`ARTIFACT_CARDS`（卡片视图与产卡）/`ACTION_EXECUTION`（显式审批入口与计划操作透明留痕）三个平级独立开关，默认全关。关闭语义：计划路由按不存在处理（404）；ARTIFACT_CARDS 关=不产卡但计划功能不受损（草案只在计划页可见）；ACTION_EXECUTION 关=计划照常工作只是不写 action_requests 审计行。跨依赖：接受计划时带 followup 子对象要求 FOLLOWUP_DISPATCH 开（400 不静默降级）。
- 生命周期口径：草案（DRAFT）最长 30 天，惰性过期——列表只标注 `expired:true`、接受时 409 PLAN_DRAFT_EXPIRED，读路径不写库；显式审批（action_requests）默认 15 分钟过期，同样惰性裁决，无后台清扫；残留行由注销清理与保留期收口。
- 无新后台 Worker：计划全部写入由用户操作驱动的请求事务完成；linked 提醒的到期投递仍归 qiyu_followup_worker（065 授权，A3 零改动）。运维上没有计划队列可积压——排查计划问题时看请求日志与 companion_plans 行状态即可。
- 排障查询：`SELECT plan_id, state, state_reason, version FROM companion_plans WHERE account_id = $1 ORDER BY updated_at DESC;`（state_reason 解释 event_cancelled/event_deleted/superseded）；审批状态 `SELECT action_id, action_type, state, failure_code, expires_at FROM action_requests WHERE account_id = $1;`——FAILED 的 failure_code 如实记域层错误码，EXPIRED 是正常超期终态不是故障。
- 暂停语义：暂停计划只撤销 linked 的那条 followup 许可（`revokeFollowupGrantById`），同事件上用户独立开启的提醒不受影响；恢复不补发，只提示重新开启。若用户报「暂停计划后提醒还在发」，先查该提醒是否为独立许可（followup_grants 中非 linked_followup_grant_id 的 ACTIVE 行）。

### 灰度检查清单（六项能力 A4，内部合成账户灰度窗口内每 24h 留档）
1. **抑制原因**：`SELECT action, reason, count FROM followup_suppression_counters ORDER BY count DESC;`（迁移 068；或 `/internal/metrics` 的 `qiyu_followup_suppressed_total{action,reason}`）。交叉核对 `followup_jobs.last_error` 分布。异常信号：`SAFETY_MODE`/`USER_PAUSED` 占比畸高（安全模式被常态化触发需查账户安全状态），`QUIET_HOURS` 远大于 `PUBLISH`（静默窗配置与用户群作息不符）。
2. **成本**：`/internal/metrics` 的 `qiyu_provider_estimated_cost_fen`（费率卡 `QIYU_COST_RATE_CARD_JSON`）+ `SELECT capability, provider, sum(input_tokens), sum(output_tokens) FROM operation_metrics WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours' GROUP BY 1,2;`。
3. **失败队列**：`SELECT state, count(*) FROM life_event_extraction_jobs GROUP BY 1;`（FAILED 留表待人工，不自动重放）+ `SELECT job_id, last_error FROM followup_jobs WHERE state = 'FAILED';`。EXPIRED 是正常频控终态不是故障。
4. **死信与积压**：`qiyu_dead_letters_open`（conversation_summary/asset_embedding 两队列）、`qiyu_deletion_jobs_pending`（超 24h 告警）、`qiyu_image_jobs_inflight`。
5. **灰度范围**：确认 `QIYU_DEV_FLAG_ACCOUNTS` 白名单当前值（空=全局开启；非空=仅白名单账户）；API 进程与 Worker 进程各自解析一次环境，改名单需两边同步重启。
