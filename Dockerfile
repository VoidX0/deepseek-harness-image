# 编译构建阶段
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /app

COPY . .

# 跳过 Lefthook 安装
ENV LEFTHOOK=0
RUN echo "process.exit(0)" > scripts/install-lefthook.mjs 2>/dev/null || true

# 安装依赖
RUN pnpm install --frozen-lockfile

# 编译
RUN pnpm run build

# 生产运行阶段
FROM node:22-bookworm-slim

WORKDIR /app

# 安装 Caddy 以及运行时
RUN apt-get update && apt-get install -y --no-install-recommends \
    caddy \
    python3 \
    make \
    g++ \
    git \
    ca-certificates \
    vim \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

COPY --from=builder /app /app

ENV PORT=3080

EXPOSE 3080

# 启动
CMD ["sh", "-c", "chmod 600 /root/.dsh/.credentials.yaml 2>/dev/null || true; printf ':3080 {\n  reverse_proxy 127.0.0.1:3081 {\n    header_up Host 127.0.0.1:3081\n    header_up Origin http://127.0.0.1:3081\n    header_up X-Dsh-External \"1\"\n  }\n}\n' > /etc/caddy/Caddyfile && caddy run --config /etc/caddy/Caddyfile & pnpm run dsh web --port 3081 --no-open"]
