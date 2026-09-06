#!/bin/bash
# Build a flashable openflexito image on macOS (or Linux) WITHOUT loop mounts: takes the official
# Raspberry Pi OS Lite 64-bit image and injects a first-boot script plus the project tarball into
# the FAT boot partition with mtools. First boot configures user/SSH/WiFi and installs the
# service on the following boot (needs internet once). Requires: xz, mtools (brew install mtools).
#
#   cp image/secrets.env.example image/secrets.env && edit it
#   ./image/build-mac.sh            -> image/build/openflexito-<date>.img
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/.." && pwd); BUILD="$HERE/build"; mkdir -p "$BUILD"
command -v mcopy >/dev/null || { echo "mtools missing: brew install mtools"; exit 1; }
[ -f "$HERE/secrets.env" ] || { echo "create $HERE/secrets.env from secrets.env.example"; exit 1; }
# shellcheck disable=SC1091
source "$HERE/secrets.env"
: "${WIFI_SSID:?}" "${WIFI_PSK:?}" "${WIFI_COUNTRY:=CA}" "${ADMIN_USER:=admin}" "${ADMIN_PASSWORD:=microscope}"
SSH_PUBKEY=${SSH_PUBKEY:-$(cat ~/.ssh/id_ed25519.pub 2>/dev/null || cat ~/.ssh/id_rsa.pub 2>/dev/null || true)}

# Pinned to the last Bookworm Lite release: Trixie adds cloud-init/netplan, which slow the boot and
# change how WiFi is provisioned (see README). Override with BASE_IMAGE_URL if needed.
BASE_IMAGE_URL=${BASE_IMAGE_URL:-https://downloads.raspberrypi.com/raspios_oldstable_lite_arm64/images/raspios_oldstable_lite_arm64-2026-06-19/2026-06-18-raspios-bookworm-arm64-lite.img.xz}
BASE_XZ="$BUILD/base.img.xz"
if [ ! -f "$BASE_XZ" ]; then
  echo "== downloading base image $BASE_IMAGE_URL"
  /usr/bin/python3 - "$BASE_XZ" "$BASE_IMAGE_URL" <<'PY'
import sys, urllib.request, os
req = urllib.request.Request(sys.argv[2], headers={"User-Agent": "openflexito"})
with urllib.request.urlopen(req) as r, open(sys.argv[1] + ".part", "wb") as f:
    print("  ", r.geturl()); 
    while chunk := r.read(1 << 20): f.write(chunk)
os.replace(sys.argv[1] + ".part", sys.argv[1])
PY
fi

echo "== building webapp"
(cd "$REPO/webapp" && npm run build >/dev/null)

echo "== packaging project"
TAR="$BUILD/openflexito.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$TAR" -C "$REPO" --exclude=.git --exclude=node_modules --exclude=.venv --exclude=image/build --exclude=image/secrets.env \
    --exclude='*.egg-info' --exclude=__pycache__ --exclude=.pytest_cache device webapp/dist image README.md LICENSE

echo "== decompressing base image"
OUT="$BUILD/openflexito-$(date +%Y%m%d).img"
xz -dkc "$BASE_XZ" > "$OUT"

# boot partition offset from the MBR (first partition, LBA start * 512)
OFFSET=$(/usr/bin/python3 -c "
import struct,sys
with open('$OUT','rb') as f: f.seek(446); e=f.read(16)
print(struct.unpack('<I', e[8:12])[0]*512)")
IMG="$OUT@@$OFFSET"
echo "== boot partition at offset $OFFSET"

echo "== injecting first-boot files"
HASH=$(openssl passwd -6 "$ADMIN_PASSWORD")   # macOS crypt(3) lacks SHA-512; OpenSSL 3 does it
esc() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
sed -e "s|@WIFI_SSID@|$(esc "$WIFI_SSID")|g" -e "s|@WIFI_PSK@|$(esc "$WIFI_PSK")|g" -e "s|@WIFI_COUNTRY@|$(esc "$WIFI_COUNTRY")|g" \
    -e "s|@ADMIN_USER@|$(esc "$ADMIN_USER")|g" -e "s|@ADMIN_HASH@|$(esc "$HASH")|g" -e "s|@SSH_PUBKEY@|$(esc "$SSH_PUBKEY")|g" \
    "$HERE/firstrun.sh" > "$BUILD/firstrun.sh"
mcopy -o -i "$IMG" "$BUILD/firstrun.sh" ::firstrun.sh
mcopy -o -i "$IMG" "$TAR" ::openflexito.tar.gz
mcopy -o -i "$IMG" "$HERE/overlay/boot/firmware/config-openflexito.txt" ::config-openflexito.txt
# cmdline: run firstrun.sh once, then reboot
mtype -i "$IMG" ::cmdline.txt | tr -d '\n' > "$BUILD/cmdline.txt"
printf ' systemd.run=/boot/firmware/firstrun.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target\n' >> "$BUILD/cmdline.txt"
mcopy -o -i "$IMG" "$BUILD/cmdline.txt" ::cmdline.txt
# config.txt: include our fragment (firstrun also does this, but keep the image self-consistent)
mtype -i "$IMG" ::config.txt > "$BUILD/config.txt"
grep -q '^include config-openflexito.txt' "$BUILD/config.txt" || echo 'include config-openflexito.txt' >> "$BUILD/config.txt"
mcopy -o -i "$IMG" "$BUILD/config.txt" ::config.txt
echo "== verifying"
mdir -i "$IMG" :: | grep -E "firstrun|openflexito|cmdline|config" 
echo "== image ready: $OUT"
echo "   flash with Raspberry Pi Imager (choose 'Use custom', no OS customisation) or: sudo dd if=$OUT of=/dev/rdiskN bs=4m"
echo "   first boot: configures + reboots (~1 min); second boot: installs openflexito (~5-10 min, needs internet), then http://microscope.local/"
