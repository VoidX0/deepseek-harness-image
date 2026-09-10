#!/bin/sh
set -e

ROOT="/root/.dsh"
PATCHES="/app/image_patches"
EXTENDED_PATCHES="$ROOT/extended_patches"

# 1. 确保必要目录存在
mkdir -p "$ROOT"
mkdir -p /etc/caddy

cd /app

# 2. 补丁加载函数
apply_patches() {
    target_dir="$1"
    patch_type="$2"

    if [ -d "$target_dir" ]; then
        found=0
        for patch in "$target_dir"/*.patch.mjs; do
            [ -f "$patch" ] || continue
            found=1
            echo "[start] applying $patch_type: $(basename "$patch")"
            node "$patch" || echo "[start] ⚠ $patch_type 失败（未致命）: $(basename "$patch")"
        done

        if [ "$found" -eq 0 ]; then
            echo "[start] $patch_type 目录存在但无 .patch.mjs 文件，跳过"
        fi
    fi
}

# 3. 依次应用内置补丁与用户扩展补丁
# 先打内置补丁
apply_patches "$PATCHES" "内置补丁 (image_patches)"

# 再打挂载的扩展补丁（如果挂载了该目录）
apply_patches "$EXTENDED_PATCHES" "扩展补丁 (extended_patches)"

chmod 600 "$ROOT/.credentials.yaml" 2> /dev/null || true

# 4. 生成 Caddy 配置
cat << EOF > /etc/caddy/Caddyfile
:3080 {
  reverse_proxy 127.0.0.1:3081 {
    header_up Host 127.0.0.1:3081
    header_up Origin http://127.0.0.1:3081
    header_up X-Dsh-External "1"
  }
}
EOF

# 5. 启动 Caddy 并设置信号捕获
caddy run --config /etc/caddy/Caddyfile &
CADDY_PID=$!

trap "kill $CADDY_PID 2>/dev/null || true" EXIT

# 6. 启动 dsh web 服务
exec pnpm run dsh web --port 3081 --no-open 2>&1 | tee -a "$ROOT/dsh.log"
