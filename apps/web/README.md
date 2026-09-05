# 栖语 M1 本地 Web 壳

无框架、无安装依赖的移动端开发前端。它只请求同源 `/api/v1`，用于 M1 主链：必要告知、年龄声明、单角色创建、文字对话、候选记忆确认/拒绝、关系资产列表与删除任务回执，以及受控短音频 ASR 转写确认。

## 本地运行

由同源 API 服务启动：

```powershell
cd C:\Users\ASUS\Desktop\AI社交\apps\api
node src\server.js
```

在浏览器打开 `http://127.0.0.1:3000/`。该 Node 服务只在 localhost 托管必要静态资源和 `/api/v1`；不要另起静态服务器或跨端口访问，避免 CORS 及脱离服务端事实的假路径。

该页面仅在 `localhost`、`127.0.0.1` 或 `::1` 使用合同指定、代码内明确标识的合成开发 Bearer token `dev-alice-token`，并发送 `X-Qiyu-Client-Environment: local-development-synthetic`。它不是生产鉴权，禁止部署到非本地环境。

## 当前 API 假设

所有端点以 `/api/v1` 为前缀、使用 JSON、需要 Bearer token；写请求携带 `Idempotency-Key`。

- `GET /api/v1/dev/session` 仅用于开发账户状态诊断；`GET /required-notices`、`POST /required-notices/{id}/displayed`
- `GET /age/status`、`POST /age/declarations`（字段为 `date_of_birth` 与 `confirmed_18_plus`）
- `POST /characters`（当前合同只接受 `name`）；`POST /conversations`；`POST /conversations/{id}/messages`（载荷为 `{content:{text}}`）
- `GET /memory-candidates`；`POST /memory-candidates/{id}/confirm`、`confirm-edited`、`reject`
- `GET /relationship-assets`；`DELETE /relationship-assets/{id}`；`GET /deletion-jobs/{id}`
- `POST /conversations/{id}/asr-jobs`（`mime_type` 与 `audio_base64`）；`GET /asr-jobs/{id}`；`POST /asr-jobs/{id}/confirm`；`DELETE /media-assets/{id}`

响应中的 `notices`、年龄状态、`character`、`conversation`、`user_message`、`assistant_message`、`candidates`、`assets`、`deletion_job` 才会驱动页面。当前合同没有角色、会话或消息的 GET 路由：重载浏览器不会伪造这些历史，消息只呈现本次 POST 返回的服务端对象。对于 `428`、`401`、`403`、`409` 和网络失败，页面保持失败/阻断状态。

## 事实边界

- 浏览器从不本地判定 `AGE_PASS`、候选记忆确认、资产删除或删除完成。
- 删除后会重新读取资产列表，且只展示 API 返回的删除任务；除 API 返回 `COMPLETED` 外绝不写“完成”。
- 没有 `localStorage`、`sessionStorage` 或客户端 Mock 成功路径；主题仅为当前渲染会话的表现层状态。
- ASR 只接受腾讯一句话识别可用的短音频 MIME；浏览器端在服务端接受任务后立即释放其内存中的原始文件。转写确认只回填输入框，用户仍须手动发送；确认后原始音频删除状态来自 API。
- 视觉变量通过相对引用复用 `designs/qiyu-v1-handoff/tokens/tokens.css`，移动主基线为 393px，控件最小触控尺寸为 44px。
