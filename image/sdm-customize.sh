#!/bin/bash
# Runs inside the image chroot during `sdm --customize` (post-install stage).
set -euo pipefail
/opt/openflexito-src/image/install.sh --trim --no-apt || true
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  python3 python3-venv python3-pip python3-picamera2 python3-serial python3-aiohttp \
  python3-numpy python3-pil python3-evdev rpicam-apps-lite network-manager avahi-daemon openssh-server
/opt/openflexito-src/image/install.sh --trim --no-apt
systemctl enable ssh
# Example WiFi credentials file the user fills in on the boot partition before first boot:
cat > /boot/firmware/openflexito-wifi.example.txt <<'W'
SSID=YourNetwork
PSK=YourPassword
COUNTRY=CA
W
