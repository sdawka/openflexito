#!/bin/bash
# Remove services and packages a headless microscope does not need (Pi OS Lite Bookworm/Trixie).
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
PURGE="cloud-init netplan.io bluez bluez-firmware triggerhappy modemmanager pi-bluetooth rpi-eeprom \
       userconf-pi avahi-utils libcamera-tools man-db manpages apt-listchanges"
apt-mark manual raspberrypi-sys-mods raspi-firmware raspi-config udev 2>/dev/null || true
DEBIAN_FRONTEND=noninteractive apt-get purge -y $PURGE 2>/dev/null || true
apt-get autoremove -y --purge
apt-get clean
for u in apt-daily.timer apt-daily-upgrade.timer man-db.timer dphys-swapfile.service \
         rpi-eeprom-update.service systemd-timesyncd.service; do
  systemctl disable --now "$u" 2>/dev/null || true
done
systemctl enable systemd-timesyncd.service 2>/dev/null || true   # keep time sync; it is cheap
dphys-swapfile swapoff 2>/dev/null || true
rm -f /var/swap
echo "trim complete"
