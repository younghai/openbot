FROM node:22-slim AS builder
WORKDIR /app
COPY pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN corepack enable && pnpm install --frozen-lockfile
COPY apps/web/ apps/web/
RUN pnpm --filter @openbot/web build
COPY apps/server/ apps/server/
RUN pnpm --filter @openbot/server build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/apps/server/dist/ ./dist/
COPY --from=builder /app/apps/web/dist/ ./web-dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/package.json .

ENV NODE_ENV=production
ENV OPENBOT_PORT=8940
ENV OPENBOT_HOST=0.0.0.0
ENV OPENBOT_DATA_DIR=/data

VOLUME /data
EXPOSE 8940
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8940/api/health || exit 1

CMD ["node", "dist/index.js"]
