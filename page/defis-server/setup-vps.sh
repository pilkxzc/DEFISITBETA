#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  DEFIS Server — one-time VPS setup
#  Run once as root on 188.137.178.124:
#    bash setup-vps.sh
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

DEPLOY_DIR="/opt/defis-server"
DEFIS_PORT=3717

echo "==> [1/6] Installing system packages..."
apt-get update -qq
apt-get install -y -qq curl git build-essential ufw

echo "==> [2/6] Installing Node.js 20 LTS..."
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
fi
node --version
npm --version

echo "==> [3/6] Installing PM2..."
if ! command -v pm2 &>/dev/null; then
    npm install -g pm2 --quiet
fi
pm2 --version

echo "==> [4/6] Setting up firewall (UFW)..."
ufw --force enable
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow "$DEFIS_PORT/tcp" comment "DEFIS Server"
ufw status

echo "==> [5/6] Creating deploy directory..."
mkdir -p "$DEPLOY_DIR"

echo "==> [6/6] Creating .env from template..."
if [ ! -f "$DEPLOY_DIR/.env" ]; then
    # Generate a secure JWT secret automatically
    JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
    cat > "$DEPLOY_DIR/.env" <<EOF
NODE_ENV=production
DEFIS_PORT=${DEFIS_PORT}
DEFIS_HOST=0.0.0.0
DEFIS_JWT_SECRET=${JWT_SECRET}
DEFIS_DB=${DEPLOY_DIR}/defis.db
EOF
    echo "  .env created with auto-generated JWT secret."
else
    echo "  .env already exists — skipping."
fi

echo ""
echo "✓ VPS setup complete!"
echo ""
echo "Next steps:"
echo "  1. Copy server files:  scp -r ./defis-server/* root@188.137.178.124:${DEPLOY_DIR}/"
echo "  2. Install deps:       ssh root@188.137.178.124 'cd ${DEPLOY_DIR} && npm ci --omit=dev'"
echo "  3. Start server:       ssh root@188.137.178.124 'cd ${DEPLOY_DIR} && pm2 start ecosystem.config.js && pm2 save && pm2 startup'"
echo ""
echo "  Or just run deploy.sh from your local machine."
