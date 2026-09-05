# 栖语封测环境镜像（development 模式：本地合成运行时搬到云端，供内部封测访问）。
# 构建 context 必须是仓库根：API 同源托管 apps/web 静态壳与 designs 设计 tokens。
# 诚实边界：NODE_ENV 保持 development——生产模式被 startup 门禁主动拒绝
# （PRODUCTION_RUNTIME_NOT_WIRED）；真实用户注册/支付/年龄供应商接入前不得放开。
FROM node:22-alpine

WORKDIR /app

# 先装依赖以利用层缓存（cos SDK + pg）。
COPY apps/api/package.json apps/api/package-lock.json* ./apps/api/
RUN cd apps/api && npm ci --omit=dev || npm install --omit=dev

# 应用代码与静态资产。
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY designs/qiyu-v1-handoff/tokens ./designs/qiyu-v1-handoff/tokens

ENV NODE_ENV=development
# 非 root 运行。
RUN addgroup -S qiyu && adduser -S qiyu -G qiyu && chown -R qiyu:qiyu /app
USER qiyu

EXPOSE 3000
WORKDIR /app/apps/api
CMD ["node", "src/server.js"]
