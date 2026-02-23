#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
#  DEFIS Server — deploy / update on VPS
#  Run from your LOCAL machine (where this repo lives):
#    bash page/defis-server/deploy.sh
#
#  Requirements on local machine: ssh, rsync
#  Requirements on VPS: already ran setup-vps.sh
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

VPS_HOST="root@188.137.178.124"
DEPLOY_DIR="/opt/defis-server"
SERVER_SRC="$(cd "$(dirname "$0")" && pwd)"

echo "==> Syncing files to ${VPS_HOST}:${DEPLOY_DIR}..."
rsync -az --delete \
    --exclude='.env' \
    --exclude='defis.db' \
    --exclude='defis.db-shm' \
    --exclude='defis.db-wal' \
    --exclude='.admin-credentials' \
    --exclude='node_modules/' \
    --exclude='.git/' \
    "$SERVER_SRC/" \
    "${VPS_HOST}:${DEPLOY_DIR}/"

echo "==> Installing dependencies..."
ssh "$VPS_HOST" "cd ${DEPLOY_DIR} && npm ci --omit=dev --silent"

echo "==> Reloading PM2 (zero-downtime)..."
ssh "$VPS_HOST" "cd ${DEPLOY_DIR} && pm2 reload ecosystem.config.js --update-env || pm2 start ecosystem.config.js"

echo "==> Server status:"
ssh "$VPS_HOST" "pm2 list"

echo ""
echo "✓ Deploy complete!  http://188.137.178.124:3717/health"
