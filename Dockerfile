FROM node:24-slim AS base
WORKDIR /app
RUN npm install -g pnpm pm2

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/orchestrator/package.json ./apps/orchestrator/
COPY packages/libraries/package.json ./packages/libraries/
RUN pnpm install --frozen-lockfile

FROM base AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/ ./
COPY . .

ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"
RUN cd packages/libraries && pnpm prisma generate

RUN pnpm --filter @githubdemo/libraries build
RUN pnpm --filter backend build
RUN pnpm --filter frontend build
RUN pnpm --filter orchestrator build

FROM base AS runner
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    nginx \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz | tar xz -C /usr/local/bin --strip-components=1

RUN mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -SL https://github.com/docker/compose/releases/download/v2.24.0/docker-compose-linux-x86_64 \
    -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/package.json ./apps/frontend/
COPY apps/orchestrator/package.json ./apps/orchestrator/
COPY packages/libraries/package.json ./packages/libraries/

COPY --from=builder /app/packages/libraries/dist ./packages/libraries/dist
COPY --from=builder /app/apps/backend/dist ./apps/backend/dist
COPY --from=builder /app/apps/frontend/.next ./apps/frontend/.next
COPY --from=builder /app/apps/frontend/public ./apps/frontend/public
COPY --from=builder /app/apps/orchestrator/dist ./apps/orchestrator/dist

COPY --from=builder /app/packages/libraries/prisma ./packages/libraries/prisma
COPY --from=builder /app/packages/libraries/prisma.config.ts ./packages/libraries/

#  Copy nginx config and ecosystem
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY ecosystem.config.js ./

RUN pnpm install --frozen-lockfile

EXPOSE 80 3000 3001 3002

#  Start nginx first, then apps
CMD ["sh", "-c", "nginx && pnpm run pm2-run"]