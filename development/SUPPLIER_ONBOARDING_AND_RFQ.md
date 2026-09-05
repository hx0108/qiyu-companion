# 栖语 V1 供应商接入与 RFQ 门禁

更新时间：2026-09-03｜状态：选型已确认；采购、DPA、商户入网与生产启用均未完成。

## 已确认的目标组合

| 能力 | 主供应商/方案 | 当前工程状态 | 不得据此声称 |
|---|---|---|---|
| 增强年龄核验 | 腾讯云 + 阿里云双 RFQ | 仅 Adapter 合同与生产配置门禁 | 已核验、已合规、已采购 |
| H5 / 官网支付 | 支付宝 + 微信支付 | 仅支付 Adapter 合同与回调门禁 | 已收款、已开通自动续费 |
| 语音 | 腾讯云 ASR / TTS | ASR/TTS 本地开发 Adapter、私有媒体库与删除状态机；ASR 转写须用户确认后才可作为文字输入 | 已接通生产音频处理 |
| 图片生成 | 腾讯混元生图 | 默认关闭的提交/查询 Adapter；仅接受广州 COS 受控参考图，固定单图、提示词扩写和 AIGC 显式标识请求；短时结果 URL 只允许交给内部媒体流水线 | 已生成或已存储媒体 |
| 文本/图片内容审核 | 腾讯云 TMS / IMS | 文本审核 TC3 Adapter 已实现、默认关闭；图片仅受控 COS 输入 Adapter | 已完成供应商策略验收或生产审核 |

`apps/api/src/providers/tencent-moderation-adapter.js` 是当前文字审核的可外呼供应商代码，但它只在本地进程显式设置 `QIYU_TEXT_MODERATION_PROVIDER=tencent` 时创建。未设置时不读取腾讯云凭据、不发送内容。开启后，确定性 R2 安全中断仍先于供应商审核；其余文本的 `Review`、`Block`、超时、网络失败或无效响应都不会继续送往 Qwen，也不会创建候选记忆。

`apps/api/src/providers/tencent-hunyuan-image-adapter.js` 为混元生图准备了同样默认关闭的提交/查询适配器：仅 `QIYU_IMAGE_PROVIDER=tencent-hunyuan` 时才会创建，且只允许广州地域和受控 COS 参考图。它固定请求单图、Prompt 扩写和显式 AIGC 标识；供应商返回的短时 URL 不会被公开 API 返回，必须先下载至固定 `qiyu/images/` 私有 COS 前缀，再经 IMS 后审通过，才可由同源鉴权内容接口读取。`createTencentImageModeratorFromEnvironment` 已为 IMS 补齐相同的显式工厂：只有 `QIYU_IMAGE_MODERATION_PROVIDER=tencent` 且设置图片 `BizType` 才会创建，调用仍仅接受受控 COS 地址。

图片环境变量名称和安全注释已集中在 `apps/api/.env.image-pipeline.example`。图片链路要求 `TENCENT_REGION`、`TENCENT_HUNYUAN_REGION` 和 `TENCENT_COS_REGION` 都为 `ap-guangzhou`；请仅将变量值复制到本机未提交的 `.env`，不要将任何真实 `SecretKey`、临时签名 URL 或审核请求正文放入仓库。

个人开发联调可先使用已实名的个人腾讯云账号开通 TMS；仅用合成、非敏感文本验证 API 结果，不发送真实私聊或身份材料。运行环境还必须从腾讯云审核策略控制台取得 `TENCENT_TEXT_MODERATION_BIZ_TYPE`，这是策略标识而不是凭据。当前启动器要求显式 `-EnableTencentTextModeration`，避免意外外发。

## 启用前的共同门禁

1. 完成 `外部验证包/02_供应商询价包.md` 的同口径 RFQ、报价、SLA、DPA、数据地域/子处理者、训练用途和删除回执书面确认。
2. 在 `外部验证包/04_外部验证状态台账.md` 更新 RFQ-AGE、RFQ-VOICE、RFQ-IMAGE、RFQ-SAFE 和 LEG-02 的证据链接；未完成状态不能改写为 Pass。
3. 生产配置只保存密钥引用，不保存明文密钥；当前生产启动仍会以 `PRODUCTION_RUNTIME_NOT_WIRED` 拒绝运行，直到真实身份认证、持久化、删除 Worker 和供应商回调验收完成。
4. 任何供应商结果都不能直接改变账号、年龄、额度、支付权益、删除完成或紧急联络状态；这些是服务端可审计状态机的职责。

## 年龄双 RFQ 的强制问题

向腾讯云与阿里云分别要求书面回答：

- 是否能由供应商托管页收集材料，业务侧只取得 `AGE_18_PLUS` / `UNDER_18` / `UNDETERMINED`、交易号、时间和策略版本；业务系统不得接收身份证原图、人脸模板或完整证件号。
- 二要素与活体/人脸各自的必要性、适用风险触发、默认/最短日志与备份清除期、地域和子处理者。
- 服务失败、争议、申诉、撤回同意和删除的回调签名、幂等事件 ID、时效、防重放与可验证删除回执。

只有法务确认最小回传和合法性、两家方案完成比较且安全路径演练通过，才能将 `ENHANCED_AGE_VERIFICATION` 从默认关闭改为候选启用；所有失败和无法确认必须 fail closed，不得放行陪伴互动。

## 支付开通所需资料

支付宝与微信支付接入前需由收款主体提供：营业执照/主体信息、法定代表人或经办人授权、对公结算账户、服务类目与实际页面、客服与退款规则、隐私政策/用户协议、订单/退款/自动续费说明，以及各平台的商户号、证书或密钥**引用**和回调域名。不得提交明文证书私钥或 API 密钥到仓库、聊天记录或 `QIYU_PROVIDER_CONFIG_JSON`。

H5/官网交易需先完成沙箱验收：创建订单、支付结果异步验签、防重放、金额/币种/商品与内部订单逐项匹配、幂等发放权益、退款/关单、对账与异常人工处理。移动应用内的数字订阅还应在上架前复核 Apple / Google 的平台内购规则，不能把 H5 结论直接套用到应用商店渠道。

## 腾讯云媒体与审核的配置输入

生产后续由密钥管理系统注入下列环境变量，配置值来自已批准的业务账号和 RFQ/DPA，不使用个人桌面 `.env`：

```text
QIYU_TEXT_MODERATION_PROVIDER=tencent
TENCENT_SECRET_ID=<runtime-secret>
TENCENT_SECRET_KEY=<runtime-secret>
TENCENT_REGION=<approved-region>
TENCENT_TEXT_MODERATION_BIZ_TYPE=<approved-biz-type>
```

新增文本审核调用固定使用腾讯云 TMS `TextModeration` 与 API 版本 `2020-12-29`；它通过 TC3-HMAC-SHA256 签名，仅允许 `tms.tencentcloudapi.com`。ASR 调用固定使用腾讯云 `SentenceRecognition` 与 API 版本 `2019-06-14`，仅接受受控 MIME 的短音频；转写必须用户确认，且确认后立即撤销/尝试删除原始音频。TTS 调用固定使用腾讯云 `TextToVoice` 与 API 版本 `2019-08-23`，只接受已审核助手文本且显式要求音色 ID；音频先写入本地私有媒体库，API 不返回对象键或公开 URL。图片审核固定在 IMS，且代码只接受验证过归属的腾讯 COS HTTPS 地址，防止产品 API 被利用去审核任意第三方 URL。生产媒体接入前仍必须补齐对象存储、AIGC 标识、音频审核、签名下载、删除回执与审计链路。

## 本轮可验收项

- `TEXT_MODERATION`、`IMAGE_MODERATION` 已进入默认关闭的 Feature Flag、供应商绑定和 Adapter 合同；通过生产配置仍要求具体版本、地域、密钥引用、批准的数据政策/DPA 与删除回执。
- 文本审核 `PASS` 才允许走 Qwen；`REVIEW` / `BLOCK` 返回固定非 AI 响应，零候选记忆；审核错误 fail closed。
- TC3 发送目标被服务白名单限制为 TMS/IMS；错误不会把上游响应正文或密钥写入 API 响应。
- 已执行两次腾讯图片受控探针：运行时生成的非真人测试图均已完成 COS 上传和 IMS 前审，混元提交阶段返回 `AuthFailure.UnauthorizedOperation`，未获得任务 ID 或保存结果图；两次参考对象均已由 API 删除路径清理。该结果不构成生图供应商验收、生产媒体处理或真实交易证据；支付宝、微信、阿里年龄核验均未调用。

当前 `.env` 所用 SecretId 的 CAM 身份还须关联最小自定义策略：`name/hunyuan:SubmitHunyuanImageJob` 与 `name/hunyuan:QueryHunyuanImageJob`，资源为 `*`（混元接口为操作级授权，不能用具体桶或对象资源替代）。不需要为已开通服务的联调身份加入 `ActivateService`。授权后仅可用合规、非真人测试图复测，并继续清理临时对象。
