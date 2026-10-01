# 删除账本本地恢复演练（A4·P4.6）

- 运行时间：2026-10-01T14:17:57.099Z
- 边界：本地 Docker tmpfs 合成数据，非生产备份介质；生产首次演练仍按 Runbook §4 空位登记（封测上线后 30 天内）。

## ① 备份前（主库九域行数）

```json
{"life_events":1,"life_event_extraction_jobs":1,"message_memory_refs":1,"followup_grants":1,"followup_jobs":1,"proactive_daily_slots":0,"companion_plans":1,"companion_plan_steps":1,"artifact_cards":2,"action_requests":1}
```

## ②③ 注销清理后（主库九域应为零）

```json
{"life_events":0,"life_event_extraction_jobs":0,"message_memory_refs":0,"followup_grants":0,"followup_jobs":0,"proactive_daily_slots":0,"companion_plans":0,"companion_plan_steps":0,"artifact_cards":0,"action_requests":0}
```

清理回执：九域全零

## ④ 备份恢复后（恢复库九域——数据被备份带回）

```json
{"life_events":1,"life_event_extraction_jobs":1,"message_memory_refs":1,"followup_grants":1,"followup_jobs":1,"proactive_daily_slots":0,"companion_plans":1,"companion_plan_steps":1,"artifact_cards":2,"action_requests":1}
```

复活状态：存在应删数据（重放目标）

## ⑤ 账本重放 dry-run

```json
{"mode":"DRY_RUN","applied":false,"total":1,"applied_count":0,"skipped":[{"deletion_job_id":"ee9c454e-7b1d-481a-b0fa-b92883d4d447","scope":"ACCOUNT","applied":false,"reason":"DRY_RUN"}],"results":[{"deletion_job_id":"ee9c454e-7b1d-481a-b0fa-b92883d4d447","scope":"ACCOUNT","applied":false,"reason":"DRY_RUN"}]}
```

## ⑥ 账本重放 --apply

```json
{"mode":"APPLY","applied":true,"total":1,"applied_count":1,"skipped":[],"results":[{"deletion_job_id":"ee9c454e-7b1d-481a-b0fa-b92883d4d447","scope":"ACCOUNT","applied":true,"replayed":"ACCOUNT","final_state":"COMPLETED"}]}
```

## ⑦ 重放后（恢复库九域应为零——删除不可被备份恢复复活）

```json
{"life_events":0,"life_event_extraction_jobs":0,"message_memory_refs":0,"followup_grants":0,"followup_jobs":0,"proactive_daily_slots":0,"companion_plans":0,"companion_plan_steps":0,"artifact_cards":0,"action_requests":0}
```

**结论：演练通过。**

