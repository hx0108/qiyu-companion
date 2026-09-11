# 栖语封测环境部署（阿里云）

三运行容器编排：API + 独立 Worker + PostgreSQL(pgvector)，另含一次性 `migrate`
服务。它会在 API/Worker 启动前补齐未执行的 SQL 迁移；已执行的迁移仅按文件名跳过。
已在本地 Docker 验证 compose 语法、全新卷自动应用全部 56 个迁移、已有卷的迁移账本
可被安全读取，以及容器命名与同机其他项目共存。

## ⚠️ 诚实边界（先读）

本编排部署的是 **development 模式的远程封测环境**，不是生产服务：

- `NODE_ENV=production` 会被启动门禁**主动拒绝**（`PRODUCTION_RUNTIME_NOT_WIRED`）——
  本地合成运行时（固定开发账户 token）禁止冒充生产。
- 默认用户体系是两个开发账户（alice/bob token）。设置 `QIYU_TRIAL_AUTH=invite` 后，
  可启用邀请码 + 初始口令的持久化封闭试用会话；它不是公开注册、短信鉴权或正式身份认证。
- 数据库/备份/监控按封测标准；对外建议仅在安全组放行白名单 IP 或走 VPN。

## 一、旧服务器可用性自检（部署前在服务器上跑）

```bash
uname -m && cat /etc/os-release | head -2   # 需 x86_64；CentOS 7+/Ubuntu 18.04+
free -h | head -2                            # 可用内存 ≥ 2GB（PG+API+Worker 约占 1.2GB）
df -h / | tail -1                            # 磁盘剩余 ≥ 10GB
docker --version || echo "需安装 Docker"      # ≥ 20.10
docker compose version || echo "需安装 compose 插件"
ss -tlnp | grep -E ":3000|:5432"             # 端口占用（AI 质检系统若占用则改 API_PORT）
docker ps --format "{{.Names}} {{.Ports}}"   # 既有容器与资源
```

判定：内存 ≥ 4GB 直接用；2-4GB 需先确认 AI 质检系统空闲内存；质检系统若跑大模型
推理（常驻 >2GB），建议栖语换轻量新机（2C4G 约 ¥100/月内）。

## 一点五、2GiB 小机贴线部署保护（你的情况：剩余 ~1.24GiB vs 栈峰值 ~1.2GiB）

compose 已给三容器加内存上限（PG 768m / API 512m / Worker 384m）。**再补宿主 swap 兜底**（防瞬时峰值触发 OOM 杀进程）：

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # 重启持久
free -h                                                       # 确认 Swap: 2.0Gi
```

若同机还有 AI 质检系统等常驻服务，部署后观察 `docker stats` 一天；若频繁贴上限，
优先考虑停用闲置旧服务或升配到 2C4G（栖语公开阶段前无论如何建议升配）。

## 二、部署步骤

```bash
# 1) 服务器上拉代码（首次可用 git 或 scp 打包）
git clone <仓库地址> qiyu && cd qiyu

# 2) 配置
cp deploy/.env.example deploy/.env && vim deploy/.env   # 必填 POSTGRES_PASSWORD；按需填密钥

# 3) 构建并启动（国内网络慢时先配镜像加速器，见下）
cd deploy && docker compose up -d --build

# 4) 验证
docker compose ps                                  # postgres/api healthy、worker running、migrate Exited (0)
curl http://127.0.0.1:3000/health                  # {"status":"ok",...}
docker exec qiyu-beta-postgres psql -U postgres -d qiyu -Atc "SELECT count(*) FROM schema_migrations;"  # 54
docker compose logs -f api worker                  # 观察日志（Ctrl+C 退出）

# 5) 对外：阿里云安全组放行 API_PORT（建议仅白名单 IP），浏览器访问 http://<服务器IP>:3000/
```

**国内镜像加速**（构建拉 node:22-alpine 慢/超时时）：编辑 `/etc/docker/daemon.json`
```json
{ "registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1ms.run"] }
```
然后 `systemctl restart docker` 再构建。

## 三、日常运维

```bash
cd deploy
docker compose logs -f api                     # API 日志
docker compose logs -f worker                  # Worker（摘要/向量队列消费）
docker compose restart api worker              # 重启应用
# 更新版本：先强制重建一次性服务，确保新迁移一定运行；再更新应用。
docker compose pull && docker compose up -d --build --force-recreate migrate
docker compose up -d --build
docker compose down                            # 停止（保留数据）
docker compose down -v                         # 停止并清空数据库（不可逆！）
# 数据库备份
docker exec qiyu-beta-postgres pg_dump -U postgres qiyu | gzip > qiyu-$(date +%F).sql.gz
```

## 三点五、封闭试用操作（仅在书面适用性结论允许时）

这不是公开上线：仅向你线下确认的成年试用者单独发送凭据，不开放搜索、投放、公开注册、
真实支付或未成年人访问。请先在 `deploy/.env` 设置：

```dotenv
QIYU_TRIAL_AUTH=invite
QIYU_LLM_PROVIDER=qwen
QWEN_API_KEY=你的密钥
```

重建后，用 API 容器生成一个单人邀请码。命令会先打印数据库连接进度；成功后以
`INVITE_CODE=...`、`INITIAL_SECRET=...` 的 ASCII 形式**只显示一次**凭据（不要粘贴进工单、
聊天记录或 Git）：

```bash
docker compose up -d --build
docker compose exec -T api node scripts/create-trial-invite.js --label "alpha-001" --days 14
```

将“邀请码”和“初始口令”通过单独、可信渠道发送给该试用者。浏览器会在首屏显示邀请码登录、
AI 告知和年龄声明；会话令牌仅保留在浏览器会话中。试用者可在数据中心提交结构化反馈，
也可针对具体助手回复提交 OOC/记忆/安全反馈。

若遗失初始口令，无法找回：数据库只保存其哈希。先只读列出邀请元数据（不输出邀请码、
初始口令或任何令牌），找到要处理的 `invite_id`：

```bash
docker compose exec api node scripts/list-trial-invites.js --limit 20
```

撤销时必须复制该 `invite_id` 并给出显式确认。该操作会撤销该邀请的所有活动试用会话，
阻止后续登录；**不会**删除已绑定账户、对话、关系资产或反馈数据：

```bash
docker compose exec api node scripts/revoke-trial-invite.js --invite-id "<invite_id>" --confirm REVOKE
```

撤销旧邀请后，再创建新邀请。请在 API 容器内执行这些命令，且不要将命令输出中的任何
凭据保存到工单、聊天记录或 Git。

在邀请任何外部用户前，仍须按 PRD 7.0/7.1 取得“邀请制是否已构成向公众提供/上线服务、
哪些安全评估/备案/许可被触发”的书面结论；未确认前仅限开发者本人和受控本机验证。

在发出首个真实邀请码前，可运行不输出密钥、口令或模型正文的真实模型验收：

```bash
docker compose exec api npm run verify:closed-trial-qwen
```

只有该命令返回 `{"acceptance":"passed","provider":"qwen",...}`，才能把“真实 Qwen
调用已验证”写入试用记录；失败时先保留封闭试用关闭状态并排查供应商配置或审核链路。

## 三点五、监控与语义向量（P1-6/P1-4 新增）

- 指标：`GET /internal/metrics`（Prometheus 文本；审核员 Bearer 同其它 `/internal/*`）。
- **监控栈部署件已交付（2026-09-09）**：`deploy/monitoring/` 下有 Prometheus + Alertmanager + Grafana + postgres-exporter 的 compose 覆盖层、告警规则、Grafana 看板（P50/P90/P99、失败率、估算成本、单位成功成本、死信/注销积压/图片在途、PG 实例与审计行数）。运行方式：
  ```bash
  # 1) 放 bearer token（与 QIYU_REVIEWER_TOKENS 一致的静态令牌，供 Prometheus 抓取）
  echo -n "你的审核员token" > deploy/monitoring/secrets/api-bearer-token
  # 2) deploy/.env 配 GRAFANA_ADMIN_PASSWORD 与告警渠道（ALERT_PUSH_WEBHOOK_URL / ALERT_SMTP_*）
  # 3) 叠加启动
  docker compose -f deploy/docker-compose.yml -f deploy/monitoring/docker-compose.monitoring.yml up -d
  ```
  **诚实边界：本机未执行镜像拉取（磁盘受限），栈尚未实际运行**——`docker compose ... config` 结构校验通过；"已接入告警"须以实际 up 且触发过一次测试告警为准。postgres-exporter 提供 PG 全实例标准指标 + 自定义查询（库大小/TOP 表行数/迁移账本/审计追加行数）。
  注意：PG 模式下 `/internal/metrics` 是请求作用域样本，生产全实例口径仍需独立导出。
- 语义记忆向量：配置 `QIYU_LLM_PROVIDER=qwen + QWEN_API_KEY` 后资产索引与召回
  查询自动切换到 Qwen embedding（默认 `text-embedding-v4` 1024 维；
  `QWEN_EMBEDDING_MODEL`/`QWEN_EMBEDDING_DIMENSIONS` 可覆盖），未配置则回退确定性开发嵌入。
- 切换 embedding 模型版本后必须全量重建索引：

```bash
docker compose exec worker node scripts/rebuild-asset-embedding-index.js --dry-run  # 先看待重建数量
docker compose exec worker node scripts/rebuild-asset-embedding-index.js           # 入队后由向量队列完成
```

## 三点六、真实短信登录（P2-10 新增）

默认未配置时验证码走开发固定码（响应如实标注 `dev_code`）。真实通道需要腾讯云已审核签名与模板；个人开发者若控制台要求企业主体或未具备适用资格，应保持关闭，不得把开发固定码对外使用。配置以下环境变量后才可切换真实通道（随机 6 位码、响应不回显）：

```
QIYU_SMS_PROVIDER=tencent
QIYU_SMS_SDK_APP_ID / QIYU_SMS_SIGN_NAME / QIYU_SMS_TEMPLATE_ID   # 已审核的正文模板，占位 {1}=验证码
TENCENT_SECRET_ID / TENCENT_SECRET_KEY / TENCENT_REGION
```

反滥用随实现内置：每手机号 1 分钟 5 条 / 24 小时 10 条挑战，每条挑战错码 5 次作废。真实验收（发给你自己的手机）：

```bash
QIYU_SMS_VERIFY_PHONE=138... node scripts/verify-tencent-sms-provider.js   # 输出 acceptance=passed 才可记录“已验证”
```

当前仓库与本机 `deploy/.env` 未配置上述腾讯 SMS 字段及验收手机号，因此只有适配器、限流和契约测试证据，尚无真实短信送达证据。

## 三点七、成本看板与供应商账单对账

审核员可从独立运营台或 `GET /internal/cost-report` 查看按供应商/能力聚合的调用量、估算成本、失败率与 P50/P90/P99。费率通过 `QIYU_COST_RATE_CARD_JSON` 注入；告警阈值使用 `QIYU_ALERT_P99_LATENCY_MS`、`QIYU_ALERT_FAILURE_RATE` 与 `QIYU_ALERT_UNIT_COST_FEN`。

供应商账单必须另行导出为 JSON，并与同周期调用指标执行：

```bash
node scripts/reconcile-provider-bill.js --metrics=metrics.json --bill=bill.json --rate-card=rate-card.json [--bucket=day|month]
```

费率表支持三口径：固定价、按生效时间调价（`effective`，估算按调用当日仍在效的最近一档）、阶梯价（`tiers`，按单次输出 token 命档）；账单可带调整项 `adjustments: [{ kind, fen, note }]`（kind ∈ COUPON/FREE_CREDIT/REFUND/TAX/TIER_DELTA/OTHER）解释优惠券、代金券、退款与税差——`billed = estimated + Σadjustments ± 容差` 时才判 MATCHED。无 `created_at` 的历史埋点对时间档"不猜价"（计入 unpriced_calls）。
返回 `MATCHED` 才能作为该周期对账证据；退出码 2 表示金额差异待人工复核。**当前未导入真实供应商账单（本机仅以合成样例验证过程，含调整项 MATCHED/超差 REVIEW_REQUIRED 两路径），页面金额仅为费率估算，不能声称真实金额已核对。**

## 三点八、PWA、CI 与灰度边界

- Web 已提供 Manifest、静态壳 Service Worker、AES-GCM 会话令牌缓存与通用 Push 隐私载荷；尚无原生 App 构建、签名、应用商店发布或真实 Push 投递。
- `.github/workflows/ci.yml` 固化单元/契约、主浏览器、42 原型状态、运营台和 Compose 配置门禁；`real-provider-e2e.yml` 仅允许人工触发并从受控环境注入供应商密钥。
- `docker-compose.canary.yml` 提供独立 canary 实例语法和健康检查，但尚未接入真实流量分配、自动晋级或回滚控制面。
- 灾备当前只有删除账本重放和运维手册级演练，尚未在真实备份介质完成恢复验证。

## 四、非 Docker 备选（systemd 直跑）

适合与既有服务合用一台机器、不想再装容器的情况：

```bash
# 前提：node ≥22、PostgreSQL 16 + pgvector（可复用容器只跑数据库）
sudo cp deploy/qiyu-api.service deploy/qiyu-worker.service /etc/systemd/system/
# 按实际路径修改两个单元里的 WorkingDirectory/EnvironmentFile 后：
sudo systemctl daemon-reload && sudo systemctl enable --now qiyu-api qiyu-worker
journalctl -u qiyu-api -f                      # 日志
```

## 五、与既有 AI 质检系统共存

- 容器名已加 `qiyu-beta-` 前缀、compose 项目名 `qiyu`，与任何既有容器不冲突
- 端口：`deploy/.env` 的 `API_PORT` 按需错开（如 3001）；PostgreSQL 不对外暴露
- 资源：栖语栈峰值约 1.2GB 内存；质检系统推理高峰期二者会争抢，建议错峰或限流
  （`docker update --memory 1500m --memory-swap 1500m qiyu-beta-api` 可加内存上限）

## 六、升级路径（真实用户接入前的硬门槛）

短信鉴权接入 → 用户注册/登录 → ICP 备案 + 生成式 AI/算法备案 → 年龄第三方断言 →
支付商户 → 届时移除启动门禁中的本地合成限制并启用 production 模式。
