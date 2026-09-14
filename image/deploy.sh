#!/bin/sh
# Deploy the working tree to a running Pi over ssh (no image rebuild): webapp/dist, the device package,
# and the network overlay files; then restart the service. Files land root-owned (tar --uid 0) as the
# repo rule requires. Usage: image/deploy.sh [admin@microscope.local] [--no-restart]
# Build first: cd webapp && npm run build. The Pi's package dir is the venv site-packages copy of
# device/openflexito; NetworkManager only reads root:root 0600 profiles.
set -eu
HOST=${1:-admin@microscope.local}
RESTART=1; [ "${2:-}" = "--no-restart" ] && RESTART=0
HERE=$(cd "$(dirname "$0")/.." && pwd)
PKG=/opt/openflexito/venv/lib/python3.11/site-packages/openflexito

[ -f "$HERE/webapp/dist/index.html" ] || { echo "webapp/dist missing: run 'cd webapp && npm run build' first" >&2; exit 1; }

echo "== webapp -> $HOST:/opt/openflexito/webapp"
tar -C "$HERE/webapp/dist" --uid 0 --gid 0 -cf - . | ssh "$HOST" 'sudo find /opt/openflexito/webapp -mindepth 1 -delete && sudo tar -C /opt/openflexito/webapp -xf -'

echo "== device package -> $HOST:$PKG"
tar -C "$HERE/device/openflexito" --uid 0 --gid 0 --exclude __pycache__ -cf - . | ssh "$HOST" "sudo tar -C $PKG -xf - && sudo find $PKG -name '*.pyc' -delete && /opt/openflexito/venv/bin/python -c 'import openflexito.app' && echo 'import ok'"

echo "== network overlay (wired profile, hotspot fallback script)"
tar -C "$HERE/image/overlay" --uid 0 --gid 0 -cf - \
    etc/NetworkManager/system-connections/openflexito-wired.nmconnection \
    usr/local/bin/openflexito-netfallback \
  | ssh "$HOST" 'sudo tar -C / -xf - && sudo chmod 600 /etc/NetworkManager/system-connections/*.nmconnection && sudo chmod +x /usr/local/bin/openflexito-* && sudo nmcli connection reload'

if [ "$RESTART" = 1 ]; then
  echo "== restart openflexito"
  ssh "$HOST" 'sudo systemctl restart openflexito && sleep 3 && systemctl is-active openflexito'
fi
echo "done. e2e on the Pi: cd webapp && E2E_MOVES=0 npm run test:e2e -- http://$(ssh "$HOST" "hostname -I | cut -d' ' -f1")"
