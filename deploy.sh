#!/usr/bin/env bash
set -euo pipefail

# slushy.trade-mcp prod deploy. Pushes code + .env to slushy.trade, installs
# deps, (re)installs the systemd unit, restarts the service. Mirrors
# slushy-payment-watcher/deploy.sh.
#
# ONE-TIME server setup (as a sudoer):
#   sudo mkdir -p /opt/slushy-trade-mcp
#   sudo chown $USER:$USER /opt/slushy-trade-mcp
# and add the nginx block from deploy/nginx-slushy-mcp.conf, then reload nginx.
#
# Usage: ./deploy.sh [--no-restart]
#   --no-restart  push files + npm ci but skip the systemctl restart

REMOTE_USER=debian
REMOTE_HOST=slushy.trade
REMOTE_DIR=/opt/slushy-trade-mcp
SERVICE_NAME=slushy-trade-mcp
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NO_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --no-restart) NO_RESTART=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

echo "==> typecheck"
( cd "$SCRIPT_DIR" && npm run typecheck )

if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo "ERROR: $SCRIPT_DIR/.env missing — refusing to deploy without it" >&2
  exit 1
fi

echo "==> rsync code to $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR"
rsync -av --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude .git \
  --exclude dist \
  "$SCRIPT_DIR/" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/"

echo "==> push .env (mode 600)"
scp -q "$SCRIPT_DIR/.env" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/.env"
ssh "$REMOTE_USER@$REMOTE_HOST" "chmod 600 $REMOTE_DIR/.env"

echo "==> npm ci on prod"
ssh "$REMOTE_USER@$REMOTE_HOST" "cd $REMOTE_DIR && npm ci"

echo "==> install/refresh systemd unit"
ssh "$REMOTE_USER@$REMOTE_HOST" "
  sudo install -m 644 $REMOTE_DIR/systemd/$SERVICE_NAME.service /etc/systemd/system/$SERVICE_NAME.service &&
  sudo systemctl daemon-reload &&
  sudo systemctl enable $SERVICE_NAME.service
"

if [ "$NO_RESTART" -eq 1 ]; then
  echo "==> --no-restart set; skipping restart"
  exit 0
fi

echo "==> restart $SERVICE_NAME"
ssh "$REMOTE_USER@$REMOTE_HOST" "sudo systemctl restart $SERVICE_NAME"
sleep 1
ssh "$REMOTE_USER@$REMOTE_HOST" "
  systemctl is-active $SERVICE_NAME &&
  echo '---' &&
  journalctl -u $SERVICE_NAME -n 20 --no-pager
"
