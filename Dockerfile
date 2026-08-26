# 编译构建阶段
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile

RUN pnpm run build

# 生产运行阶段
FROM node:22-bookworm-slim

WORKDIR /app

# 安装Caddy转发端口
RUN apt-get update && apt-get install -y --no-install-recommends caddy && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

COPY --from=builder /app /app

ENV PORT=3080

EXPOSE 3080

# 启动
CMD ["sh", "-c", "printf ':3080 {\n  reverse_proxy 127.0.0.1:3081 {\n    header_up Host 127.0.0.1:3081\n    header_up -Origin\n  }\n}\n' > /etc/caddy/Caddyfile && caddy run --config /etc/caddy/Caddyfile & pnpm run dsh web --port 3081 --no-open"]