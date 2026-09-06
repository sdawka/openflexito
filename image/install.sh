#!/bin/bash
# Install openflexito onto a running Raspberry Pi OS Lite (64-bit Bookworm). Run as root:
#   sudo ./image/install.sh [--trim] [--readonly] [--no-apt]
# Idempotent: safe to re-run after changing device/ or webapp/dist.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
TRIM=0; READONLY=0; APT=1
for a in "$@"; do case $a in --trim) TRIM=1;; --readonly) READONLY=1;; --no-apt) APT=0;; esac; done
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }

echo "== packages"
if [ $APT = 1 ]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip python3-picamera2 python3-serial python3-aiohttp \
    python3-numpy python3-pil python3-evdev rpicam-apps-lite network-manager avahi-daemon openssh-server
fi

echo "== user and directories"
id openflexito >/dev/null 2>&1 || useradd --system --home /var/lib/openflexito --shell /usr/sbin/nologin openflexito
usermod -aG video,dialout,input,render openflexito 2>/dev/null || usermod -aG video,dialout,input openflexito
install -d -o openflexito -g openflexito -m 0755 /var/lib/openflexito
install -d /opt/openflexito

echo "== python service"
rsync -a --delete --exclude .venv --exclude __pycache__ --exclude .pytest_cache "$REPO/device/" /opt/openflexito/src/
[ -d /opt/openflexito/venv ] || python3 -m venv --system-site-packages /opt/openflexito/venv
/opt/openflexito/venv/bin/pip install --quiet --upgrade /opt/openflexito/src

echo "== webapp"
if [ -f "$REPO/webapp/dist/index.html" ]; then
  rsync -a --delete "$REPO/webapp/dist/" /opt/openflexito/webapp/
else
  echo "   (no webapp/dist; the service will serve its fallback page. Run 'npm run build' in webapp/ first.)"
fi

echo "== overlay files"
rsync -a --exclude boot "$HERE/overlay/" /
[ -f /etc/openflexito/config.toml ] || install -m 0644 "$HERE/overlay/etc/openflexito/config.toml" /etc/openflexito/config.toml
chmod 600 /etc/NetworkManager/system-connections/*.nmconnection
chmod +x /usr/local/bin/openflexito-*

echo "== boot config"
BOOT=/boot/firmware; [ -d $BOOT ] || BOOT=/boot
install -m 0644 "$HERE/overlay/boot/firmware/config-openflexito.txt" $BOOT/config-openflexito.txt
grep -q '^include config-openflexito.txt' $BOOT/config.txt || echo 'include config-openflexito.txt' >> $BOOT/config.txt
# free the PL011 UART from the serial console
sed -i -E 's/console=serial0,[0-9]+ ?//; s/console=ttyAMA0,[0-9]+ ?//' $BOOT/cmdline.txt

echo "== hostname and services"
hostnamectl set-hostname microscope || true
sed -i 's/^127\.0\.1\.1.*/127.0.1.1\tmicroscope/' /etc/hosts
systemctl daemon-reload
systemctl disable --now hciuart.service bluetooth.service serial-getty@ttyAMA0.service serial-getty@ttyS0.service 2>/dev/null || true
systemctl mask serial-getty@ttyAMA0.service 2>/dev/null || true
systemctl enable avahi-daemon NetworkManager openflexito.service openflexito-firstboot.service openflexito-netfallback.timer
systemctl restart avahi-daemon || true
systemctl restart openflexito.service

[ $TRIM = 1 ] && "$HERE/trim.sh"
if [ $READONLY = 1 ]; then
  echo "== enabling overlay (read-only) root filesystem"
  raspi-config nonint enable_overlayfs || echo "overlayfs enable failed (needs a reboot afterwards)"
fi
echo "== done. Reboot to apply UART/camera boot settings: sudo reboot"
