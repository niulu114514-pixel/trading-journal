#!/bin/bash
# ============================================
# 交易日志系统 - Cloudflare 一键部署脚本
# 用法: CLOUDFLARE_API_TOKEN=你的令牌 ./deploy.sh
# 未设置环境变量时会安全地提示输入，不回显令牌。
# ============================================

set -euo pipefail

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  read -r -s -p "请输入 Cloudflare API Token: " CLOUDFLARE_API_TOKEN
  echo ""
  export CLOUDFLARE_API_TOKEN
fi

echo "=========================================="
echo "  交易日志系统 - 部署到 Cloudflare"
echo "=========================================="

# 1. 安装依赖
echo ""
echo "[1/7] 安装锁定版本依赖..."
pnpm install --frozen-lockfile

# 2. 验证 Token
echo ""
echo "[2/7] 验证 API Token..."
pnpm exec wrangler whoami
pnpm exec wrangler workflows list

# 3. 创建 D1 数据库（如不存在）
echo ""
echo "[3/7] 检查/创建 D1 数据库..."
if ! pnpm exec wrangler d1 info trading-journal-db 2>/dev/null; then
  echo "创建新数据库..."
  pnpm exec wrangler d1 create trading-journal-db
  echo "⚠️  请把上面返回的 database_id 填入 wrangler.jsonc"
  echo "⚠️  然后仅执行一次 pnpm db:init 初始化当前版本数据库，再重新运行本脚本"
  exit 1
fi

# 4. 创建 R2 存储桶（如不存在）
echo ""
echo "[4/7] 检查/创建 R2 存储桶..."
if ! pnpm exec wrangler r2 bucket info trading-journal-images 2>/dev/null; then
  echo "创建新存储桶..."
  pnpm exec wrangler r2 bucket create trading-journal-images
fi

# 5. 应用增量迁移。新数据库的 schema.sql 会预登记已包含的基线迁移。
echo ""
echo "[5/7] 应用 D1 增量迁移..."
pnpm db:migrate

# 6. 测试并构建生产文件。新版覆盖部署时 dist 不存在，因此必须重新生成。
echo ""
echo "[6/7] 测试、检查绑定并构建..."
pnpm test
pnpm check:bindings
pnpm build

# 7. 部署 Worker
echo ""
echo "[7/7] 部署 Worker..."
pnpm exec wrangler deploy

echo ""
echo "部署完成！"
echo "=========================================="
echo "首次使用: 先设置 CONFIG_ENCRYPTION_KEY 和 SETUP_TOKEN Secret，再打开网站初始化"
echo "TG 配置: 登录后到 设置 → 图片存储 → 填入 Bot Token 和 Chat ID"
echo "=========================================="
