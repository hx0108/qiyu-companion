# 栖语封测环境部署（阿里云）

三容器编排：API + 独立 Worker + PostgreSQL(pgvector)。已在本地 Docker 验证：
compose 语法、全新卷自动应用全部 42 个迁移、容器命名与同机其他项目共存。

## ⚠️ 诚实边界（先读）

本编排部署的是 **development 模式的远程封测环境**，不是生产服务：

- `NODE_ENV=production` 会被启动门禁**主动拒绝**（`PRODUCTION_RUNTIME_NOT_WIRED`）——
  本地合成运行时（固定开发账户 token）禁止冒充生产。
- 当前用户体系是两个开发账户（alice/bob token）。封测用户访问的是同一套 API，
  尚无真实注册/登录；正式用户接入前需完成短信鉴权 + ICP/算法备案。
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

## 二、部署步骤

```bash
# 1) 服务器上拉代码（首次可用 git 或 scp 打包）
git clone <仓库地址> qiyu && cd qiyu

# 2) 配置
cp deploy/.env.example deploy/.env && vim deploy/.env   # 必填 POSTGRES_PASSWORD；按需填密钥

# 3) 构建并启动（国内网络慢时先配镜像加速器，见下）
cd deploy && docker compose up -d --build

# 4) 验证
docker compose ps                                  # 三容器 healthy/running
curl http://127.0.0.1:3000/health                  # {"status":"ok",...}
docker exec qiyu-beta-postgres psql -U postgres -d qiyu -Atc "SELECT count(*) FROM schema_migrations;"  # 42
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
docker compose pull && docker compose up -d --build   # 更新版本
docker compose down                            # 停止（保留数据）
docker compose down -v                         # 停止并清空数据库（不可逆！）
# 数据库备份
docker exec qiyu-beta-postgres pg_dump -U postgres qiyu | gzip > qiyu-$(date +%F).sql.gz
```

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
